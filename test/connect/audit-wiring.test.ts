/**
 * WHERE THE AUDIT LINE ACTUALLY LANDS.
 *
 * test/entitlements/audit.test.ts proves the module emits one event per
 * decision through a sink seam. This proves the HOST installs its own logger
 * into that seam, so the line arrives in the service's structured log — with
 * the trace tag every other line carries — rather than on the module's console
 * fallback, which nothing collects.
 *
 * It also pins the negative: the subject appears in the LOG and nowhere else.
 * The estate's telemetry rule keeps `sub` off spans, and the two rules only
 * coexist because they are about different sinks.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { CompareService } from '@figurecollecting/fc-api-contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { CALLER_IDENTITY_DECORATOR } from '../../src/connect/identity.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import {
  resetEntitlementGrantsForTest,
  resetEntitlementSigningForTest,
  resetOpenFgaTokenForTest,
} from '../../src/entitlements/index.js';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';

const KID = 'ent-test-2026-09';
const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const NOW_ISO = '2026-09-14T12:00:00.000Z';
const GTIN = '04573102591234';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';

const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;
const ENV_KEYS = ['OPENFGA_API_URL', 'OPENFGA_STORE_ID', 'OPENFGA_MODEL_ID',
  'ENTITLEMENT_SIGNING_KEY_PEM', 'ENTITLEMENT_SIGNING_KID'] as const;

let telemetry: Telemetry;
let app: FastifyInstance | null = null;
let spine: FakeSpineRead | null = null;
let fga: FakeOpenFga | null = null;
let lines: string[] = [];
let saved: Record<string, string | undefined> = {};

beforeAll(() => {
  telemetry = startTelemetry({ env: {}, serviceName: 'fc-coordinator-test' });
});
afterAll(async () => {
  await telemetry.shutdown();
});

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  lines = [];
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  resetOpenFgaTokenForTest();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  if (spine) {
    await spine.close();
    spine = null;
  }
  if (fga) {
    await fga.close();
    fga = null;
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

async function start(allow: boolean): Promise<Client<typeof CompareService>> {
  const kp = generateTestSigningKey(KID);
  process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
  process.env['ENTITLEMENT_SIGNING_KID'] = KID;

  fga = await startFakeOpenFga(() => allow);
  process.env['OPENFGA_API_URL'] = fga.baseUrl;
  process.env['OPENFGA_STORE_ID'] = STORE;

  spine = await startFakeSpineRead({ keys: kp.keys });

  app = buildApp({
    db: stubDb,
    logLevel: 'info',
    logSink: (line) => lines.push(line),
    compare: { spineRead: new SpineReadClient(spine.baseUrl) },
  });
  app.addHook('onRequest', async (request) => {
    (request as unknown as Record<string, unknown>)[CALLER_IDENTITY_DECORATOR] = { sub: SUB };
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return createClient(CompareService, createConnectTransport({ baseUrl, httpVersion: '1.1' }));
}

const auditLines = (): Record<string, unknown>[] =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry['event'] === 'entitlement.check');

describe('the audit line, through the real app', () => {
  it('arrives in the structured log at info level', async () => {
    const client = await start(true);
    await client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    const audits = auditLines();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      level: 'info',
      subject: SUB,
      decision: 'allow',
      source: 'openfga',
      relation: 'inventory_levels',
      object: 'app:figurecollecting',
    });
  });

  it('records the denial too — a redacted read is a decision, not a silence', async () => {
    const client = await start(false);
    const res = await client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    expect(res.coverage?.redacted).toEqual(['inventory_levels']);
    expect(auditLines()[0]).toMatchObject({ decision: 'deny' });
  });

  it('carries the trace tag every other line in this service carries', async () => {
    // The audit line is only useful correlated: an operator who can see the
    // decision but not the request it belonged to has half a record.
    const client = await start(true);
    await client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    const audit = auditLines()[0] as Record<string, unknown>;
    expect(typeof audit['trace']).toBe('string');
  });

  it('does NOT fall back to the console once the host has wired a sink', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const client = await start(true);
    await client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    expect(JSON.stringify(info.mock.calls)).not.toContain('entitlement.check');
  });
});
