/**
 * LG-C1: `traceresponse` on the Connect surface, asked of the socket.
 *
 * connect-fastify does not answer through reply.send(): it writes the node response itself. So
 * whether a header reaches a Connect client is a property of the plugin and of where the header
 * was set, and this file asks the socket instead of assuming: the Connect protocol and gRPC-web
 * (both over HTTP/1.1, which is what the server speaks), a success and an error of each, and that
 * the id the client reads is the id on the request's own log line.
 *
 * It does NOT tell the node response from Fastify's reply as the place the header is set:
 * connect-fastify 2.2.0 copies the reply's headers across, so both pass here. The hijacked-reply
 * case in src/platform/http-trace.test.ts is the one that tells them apart.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Code, ConnectError, createClient, type Client, type Interceptor, type Transport } from '@connectrpc/connect';
import { createConnectTransport, createGrpcWebTransport } from '@connectrpc/connect-node';
import { CompareService } from '@figurecollecting/fc-api-contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { CALLER_IDENTITY_DECORATOR } from '../../src/connect/identity.js';
import {
  resetEntitlementGrantsForTest,
  resetEntitlementSigningForTest,
  resetOpenFgaTokenForTest,
} from '../../src/entitlements/index.js';
import { TRACE_RESPONSE_HEADER } from '../../src/platform/http-trace.js';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';

const KID = 'ent-test-2026-09';
const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const NOW_ISO = '2026-09-14T12:00:00.000Z';
const GTIN = '04573102591234';
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const TRACE_RESPONSE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/;
const ENV_KEYS = ['OPENFGA_GRPC_URL', 'OPENFGA_STORE_ID', 'ENTITLEMENT_SIGNING_KEY_PEM', 'ENTITLEMENT_SIGNING_KID'];

const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

type Protocol = 'connect' | 'grpc-web';
type Line = Record<string, unknown>;

let telemetry: Telemetry;
let app: FastifyInstance | null = null;
let spine: FakeSpineRead | null = null;
let fga: FakeOpenFga | null = null;
let lines: Line[] = [];

beforeAll(() => {
  telemetry = startTelemetry({ env: {}, serviceName: 'fc-coordinator-test' });
});

afterAll(async () => {
  await telemetry.shutdown();
});

afterEach(async () => {
  resetEntitlementGrantsForTest();
  await app?.close();
  app = null;
  await spine?.close();
  spine = null;
  await fga?.close();
  fga = null;
  for (const key of ENV_KEYS) delete process.env[key];
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

interface Started {
  client: Client<typeof CompareService>;
  /** The response headers of every call the client made, in order. */
  seen: Headers[];
}

/** The app as server.ts builds it, with a real spine fake or none (Compare then answers UNAVAILABLE). */
async function start(protocol: Protocol, withSpine: boolean): Promise<Started> {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  lines = [];
  if (withSpine) {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    fga = await startFakeOpenFga(() => true);
    process.env['OPENFGA_GRPC_URL'] = fga.baseUrl;
    process.env['OPENFGA_STORE_ID'] = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
    spine = await startFakeSpineRead({ keys: kp.keys });
  }

  app = buildApp({
    db: stubDb,
    logLevel: 'info',
    logSink: (line) => lines.push(JSON.parse(line) as Line),
    compare: { spineRead: spine === null ? null : new SpineReadClient(spine.baseUrl), initSigning: withSpine },
  });
  app.addHook('onRequest', async (request) => {
    (request as unknown as Record<string, unknown>)[CALLER_IDENTITY_DECORATOR] = { sub: SUB };
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const seen: Headers[] = [];
  const capture: Interceptor = (next) => async (req) => {
    const res = await next(req);
    seen.push(res.header);
    return res;
  };
  const options = { baseUrl, httpVersion: '1.1' as const, interceptors: [capture] };
  const transport: Transport = protocol === 'connect' ? createConnectTransport(options) : createGrpcWebTransport(options);
  return { client: createClient(CompareService, transport), seen };
}

const traceIdOf = (header: string | null | undefined): string => {
  expect(header).toEqual(expect.stringMatching(TRACE_RESPONSE));
  return TRACE_RESPONSE.exec(header!)![1]!;
};

describe.each<[Protocol]>([['connect'], ['grpc-web']])('LG-C1: traceresponse on a %s response', (protocol) => {
  it('is on a successful call, and names the trace its log line carries', async () => {
    const { client, seen } = await start(protocol, true);

    const res = await client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    expect(res.coverage?.redacted).toEqual([]);
    expect(seen).toHaveLength(1);
    const traceId = traceIdOf(seen[0]!.get(TRACE_RESPONSE_HEADER));
    const decision = lines.find((line) => line['msg'] === 'entitlement decision');
    expect(decision?.['trace_id']).toBe(traceId);
  });

  it("continues the caller's traceparent: the header answers with the caller's trace id", async () => {
    const { client, seen } = await start(protocol, true);

    await client.compare(
      { seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO },
      { headers: { traceparent: `00-${TRACE_ID}-${PARENT}-01` } },
    );

    const header = seen[0]!.get(TRACE_RESPONSE_HEADER);
    expect(traceIdOf(header)).toBe(TRACE_ID);
    expect(header).not.toContain(PARENT);
  });

  it('is on an error the handler answered (UNAVAILABLE), in the error metadata', async () => {
    const { client } = await start(protocol, false);

    const failure = await client
      .compare(
        { seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO },
        { headers: { traceparent: `00-${TRACE_ID}-${PARENT}-01` } },
      )
      .then(
        () => undefined,
        (err: unknown) => ConnectError.from(err),
      );

    expect(failure?.code).toBe(Code.Unavailable);
    expect(traceIdOf(failure?.metadata.get(TRACE_RESPONSE_HEADER))).toBe(TRACE_ID);
  });
});
