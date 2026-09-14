/**
 * THE DEFAULTS — which is to say, the production wiring.
 *
 * test/connect/compare.test.ts injects a fake identity resolver, because its
 * subject is the entitlement path rather than the plumbing. That leaves the
 * DEFAULT resolver — the one production actually runs, reading the decorator
 * the OIDC + DPoP plugin sets — exercised by nothing. The coverage gate found
 * exactly that, and it was right to: a default nobody tests is a default that
 * works until the day it matters.
 *
 * So this file registers the Connect surface the way server.ts will, decorates
 * a request the way the auth plugin will, and checks the subject arrives.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { CompareService } from '@figurecollecting/fc-api-contract';
import { INVENTORY_LEVELS } from '@figurecollecting/ingest-contract/entitlement';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import { CALLER_IDENTITY_DECORATOR } from '../../src/connect/identity.js';
import {
  resetEntitlementGrantsForTest,
  resetEntitlementSigningForTest,
} from '../../src/entitlements/index.js';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';

const KID = 'ent-test-2026-09';
const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const NOW_ISO = '2026-09-14T12:00:00.000Z';
const GTIN = '04573102591234';

const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

let telemetry: Telemetry;
let app: FastifyInstance | null = null;
let spine: FakeSpineRead | null = null;
let fga: FakeOpenFga | null = null;

beforeAll(() => {
  telemetry = startTelemetry({ env: {}, serviceName: 'fc-coordinator-test' });
});

afterAll(async () => {
  await telemetry.shutdown();
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
  for (const k of [
    'OPENFGA_API_URL',
    'OPENFGA_STORE_ID',
    'ENTITLEMENT_SIGNING_KEY_PEM',
    'ENTITLEMENT_SIGNING_KID',
  ]) {
    delete process.env[k];
  }
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  vi.restoreAllMocks();
});

/**
 * Register the Connect surface with NO resolveIdentity, so the default takes
 * effect, and simulate the auth plugin with an onRequest hook that decorates
 * the request — which is precisely what the OIDC + DPoP branch will do.
 */
async function startWithDefaultResolver(options: {
  decorate: unknown;
  initSigning?: boolean;
}): Promise<Client<typeof CompareService>> {
  const kp = generateTestSigningKey(KID);
  process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
  process.env['ENTITLEMENT_SIGNING_KID'] = KID;

  fga = await startFakeOpenFga(() => true);
  process.env['OPENFGA_API_URL'] = fga.baseUrl;
  process.env['OPENFGA_STORE_ID'] = '01KXA5NRJYR0GYKX4NWQ2ANDZS';

  spine = await startFakeSpineRead({ keys: kp.keys });

  app = buildApp({
    db: stubDb,
    logLevel: 'silent',
    compare: {
      spineRead: new SpineReadClient(spine.baseUrl),
      ...(options.initSigning === undefined ? {} : { initSigning: options.initSigning }),
      // NO resolveIdentity — the default is the subject of this file.
    },
  });
  app.addHook('onRequest', async (request) => {
    if (options.decorate !== undefined) {
      (request as unknown as Record<string, unknown>)[CALLER_IDENTITY_DECORATOR] = options.decorate;
    }
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return createClient(CompareService, createConnectTransport({ baseUrl, httpVersion: '1.1' }));
}

describe('the default identity resolver, as production wires it', () => {
  it('reads the decorator the auth plugin sets and entitles that caller', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = await startWithDefaultResolver({ decorate: { sub: SUB } });

    const res = await client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    expect(res.coverage?.redacted).toEqual([]);
    expect(JSON.parse(res.resultJson).heads[0].perStore[0].offers[0].stockOnHand).toBe('7');
    // And the uuid that reached OpenFGA is the one the decorator carried.
    expect(JSON.stringify(fga?.calls[0]?.body)).toContain(`user:${SUB}`);
  });

  it('treats an undecorated request as unauthenticated: redacted, never rejected', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = await startWithDefaultResolver({ decorate: undefined });

    const res = await client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    expect(res.coverage?.redacted).toEqual([INVENTORY_LEVELS]);
    // Rejecting is the auth plugin's job, upstream of here — so no Check was
    // spent on a caller this layer has no opinion about.
    expect(fga?.calls).toHaveLength(0);
  });
});

describe('the boot-time signing check', () => {
  it('logs once, by default, that minting is enabled and under which kid', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await startWithDefaultResolver({ decorate: { sub: SUB } });

    const logged = logSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    // The operator-visible fact: a missing Secret is a startup line, not a user
    // discovering their numbers have quietly vanished.
    expect(logged).toContain('minting enabled');
    expect(logged).toContain(KID);
    expect(logged).not.toContain('PRIVATE KEY');
  });

  it('can be turned off without changing whether minting works', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = await startWithDefaultResolver({ decorate: { sub: SUB }, initSigning: false });

    expect(logSpy.mock.calls.map((a) => a.map(String).join(' ')).join('\n')).not.toContain(
      'minting enabled',
    );
    // The key still loads lazily on the first mint, so the entitled path is
    // unchanged — which is exactly why this is a boot LOG and not a boot GATE.
    const res = await client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
    expect(res.coverage?.redacted).toEqual([]);
  });
});

describe('the health route is unaffected by the Connect surface', () => {
  it('still answers /healthz when Connect is mounted', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await startWithDefaultResolver({ decorate: { sub: SUB } });

    const res = await (app as FastifyInstance).inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().service).toBe('fc-coordinator');
  });
});
