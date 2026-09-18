/**
 * THE ROUTE PREFIX, and the one property that makes it a security setting
 * rather than a cosmetic one.
 *
 * C21 puts the coordinator behind a public edge at
 * `https://figurecollecting.com/api`. The service therefore has to SERVE the
 * `/api` path itself — the edge must not strip it — because the DPoP `htu`
 * comparison is `COORDINATOR_PUBLIC_ORIGIN + request.url`, and `request.url` is
 * whatever arrives at this process. A `stripPrefix` at the edge would leave
 * every client signing a proof for `/api/...` while the server compared against
 * `/...`, and every request would 401 naming nothing.
 *
 * So the assertions that matter here are the NEGATIVE ones:
 *
 *   - a proof whose `htu` omits the prefix is REJECTED even though the token,
 *     the key, the device and the nonce are all good. That is the rewrite
 *     failure mode, reproduced;
 *   - the unprefixed path is not served at all, so a rewrite cannot
 *     accidentally work;
 *   - `/healthz` is the exception and stays at the root, because kubelet
 *     probes it in-cluster and the tunnel never routes it.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { registerConnect } from '../../src/connect/register.js';
import {
  resolveAuthConfig,
  resolveRoutePrefix,
  validateRoutePrefix,
  DEFAULT_ROUTE_PREFIX,
} from '../../src/auth/config.js';
import { createAccessTokenVerifier } from '../../src/auth/oidc.js';
import type { DeviceStore } from '../../src/auth/plugin.js';
import type { AppUserState, EnrolledDevice, LiveDevice } from '../../src/db/devices.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import {
  resetEntitlementGrantsForTest,
  resetEntitlementSigningForTest,
} from '../../src/entitlements/index.js';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';
import {
  makeDeviceKey,
  makeIssuer,
  makeProof,
  TEST_ORIGIN,
  type DeviceKey,
  type TestIssuer,
} from '../helpers/auth.js';

const RPC = '/coordinator.v1.CompareService/Compare';
const PREFIX = '/api';
const CONNECT_METHODS = ['GET', 'HEAD', 'TRACE', 'DELETE', 'OPTIONS', 'PATCH', 'PUT', 'QUERY', 'POST'];
const KID = 'ent-test-2026-09';
const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const NOW_ISO = '2026-09-14T12:00:00.000Z';
const GTIN = '04573102591234';

const ENV_KEYS = [
  'OPENFGA_GRPC_URL',
  'OPENFGA_STORE_ID',
  'ENTITLEMENT_SIGNING_KEY_PEM',
  'ENTITLEMENT_SIGNING_KID',
] as const;

const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

function memoryDevices(): DeviceStore {
  const rows: { userId: string; deviceId: string; jkt: string }[] = [];
  let n = 0;
  return {
    ensureAppUser: async (): Promise<AppUserState> => 'existing',
    findLiveDevice: async (userId, jkt): Promise<LiveDevice | undefined> => {
      const row = rows.find((r) => r.userId === userId && r.jkt === jkt);
      return row ? { deviceId: row.deviceId, jkt: row.jkt } : undefined;
    },
    enroll: async (input): Promise<EnrolledDevice> => {
      const existing = rows.find((r) => r.userId === input.userId && r.jkt === input.jkt);
      if (existing) {
        return { deviceId: existing.deviceId, jkt: existing.jkt, enrolledAt: new Date(), created: false };
      }
      const row = { userId: input.userId, deviceId: `dev-${++n}`, jkt: input.jkt };
      rows.push(row);
      return { deviceId: row.deviceId, jkt: row.jkt, enrolledAt: new Date(), created: true };
    },
    revoke: async () => undefined,
  };
}

interface Harness {
  app: FastifyInstance;
  baseUrl: string;
  spine: FakeSpineRead;
  fga: FakeOpenFga;
  issuer: TestIssuer;
}

let harness: Harness | null = null;
let telemetry: Telemetry;
let saved: Record<string, string | undefined> = {};

beforeAll(() => {
  telemetry = startTelemetry({ env: {}, serviceName: 'fc-coordinator-test' });
});

afterAll(async () => {
  await telemetry.shutdown();
});

async function start(routePrefix: string): Promise<Harness> {
  const kp = generateTestSigningKey(KID);
  process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
  process.env['ENTITLEMENT_SIGNING_KID'] = KID;

  const fga = await startFakeOpenFga(() => true);
  process.env['OPENFGA_GRPC_URL'] = fga.baseUrl;
  process.env['OPENFGA_STORE_ID'] = '01KXA5NRJYR0GYKX4NWQ2ANDZS';

  const spine = await startFakeSpineRead({ keys: kp.keys });
  const issuer = await makeIssuer();
  const config = resolveAuthConfig({
    OIDC_ISSUER: issuer.issuer,
    OIDC_AUDIENCE: issuer.audience,
    OIDC_JWKS_URI: 'https://auth.test.invalid/jwks',
    COORDINATOR_PUBLIC_ORIGIN: TEST_ORIGIN,
  });

  const app = buildApp({
    db: stubDb,
    logLevel: 'silent',
    routePrefix,
    auth: {
      config,
      devices: memoryDevices(),
      verifyAccessToken: createAccessTokenVerifier({
        jwks: issuer.jwks,
        issuer: issuer.issuer,
        audience: issuer.audience,
        algorithms: config.oidcAlgorithms,
      }),
    },
    compare: { spineRead: new SpineReadClient(spine.baseUrl) },
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, baseUrl, spine, fga, issuer };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  if (harness) {
    await harness.app.close();
    await harness.spine.close();
    await harness.fga.close();
    harness = null;
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  vi.restoreAllMocks();
});

// ===========================================================================
// THE SETTING
// ===========================================================================
describe('COORDINATOR_ROUTE_PREFIX', () => {
  it('defaults to /api, which is the production shape', () => {
    expect(DEFAULT_ROUTE_PREFIX).toBe('/api');
    expect(resolveRoutePrefix({})).toBe('/api');
  });

  it('serves at the root when set EXPLICITLY empty, which is how dev runs', () => {
    // Unset means "production default"; an explicit empty string means "root".
    // Conflating the two would leave no way to ask for the root at all.
    expect(resolveRoutePrefix({ COORDINATOR_ROUTE_PREFIX: '' })).toBe('');
  });

  it('takes the configured value', () => {
    expect(resolveRoutePrefix({ COORDINATOR_ROUTE_PREFIX: '/v2/api' })).toBe('/v2/api');
  });

  it.each([
    ['no leading slash', 'api'],
    ['a trailing slash', '/api/'],
    ['a query', '/api?x=1'],
    ['a fragment', '/api#frag'],
    ['an empty segment', '/api//v1'],
    ['interior whitespace', '/a pi'],
  ])('refuses %s at boot rather than at the first request', (_label, value) => {
    expect(() => validateRoutePrefix(value)).toThrow(/COORDINATOR_ROUTE_PREFIX/);
    expect(() => resolveRoutePrefix({ COORDINATOR_ROUTE_PREFIX: value })).toThrow();
  });

  it('trims surrounding whitespace, the way every other setting in this file does', () => {
    expect(validateRoutePrefix('  /api  ')).toBe('/api');
  });
});

// ===========================================================================
// WHAT IS SERVED WHERE
// ===========================================================================
describe('with the prefix set, every route moves except /healthz', () => {
  it('serves /healthz at the ROOT and nowhere else', async () => {
    harness = await start(PREFIX);

    const root = await harness.app.inject({ method: 'GET', url: '/healthz' });
    expect(root.statusCode).toBe(200);

    // Not 404: the deny-by-default hook answers an unknown path with 401 so an
    // anonymous caller cannot map the surface.
    const prefixed = await harness.app.inject({ method: 'GET', url: `${PREFIX}/healthz` });
    expect(prefixed.statusCode).toBe(401);
  });

  it('serves the Connect RPC under the prefix, on all nine methods', async () => {
    harness = await start(PREFIX);
    const urls = harness.app.auth.routes.map((r) => r.url);
    expect(urls).toContain(`${PREFIX}${RPC}`);
    expect(urls).not.toContain(RPC);

    for (const method of CONNECT_METHODS) {
      expect(harness.app.hasRoute({ method, url: `${PREFIX}${RPC}` })).toBe(true);
      expect(harness.app.hasRoute({ method, url: RPC })).toBe(false);
    }
  });

  it('serves the enrolment routes under the prefix', async () => {
    harness = await start(PREFIX);
    const urls = harness.app.auth.routes.map((r) => `${r.method} ${r.url}`);
    expect(urls).toContain(`POST ${PREFIX}/auth/devices`);
    expect(urls).toContain(`GET ${PREFIX}/auth/session`);
    expect(urls).toContain(`POST ${PREFIX}/auth/devices/:deviceId/revoke`);
    expect(urls).not.toContain('POST /auth/devices');
  });

  it('keeps the prefixed Connect route GUARDED — the registry classifies by absence', async () => {
    harness = await start(PREFIX);
    const rpc = harness.app.auth.routes.filter((r) => r.url === `${PREFIX}${RPC}`);
    expect(rpc.length).toBe(CONNECT_METHODS.length);
    for (const route of rpc) expect(route.auth).toBe('guarded');
  });

  it('rejects an uncredentialed call at the prefixed path on every method', async () => {
    harness = await start(PREFIX);
    for (const method of CONNECT_METHODS) {
      const res = await harness.app.inject({ method: method as 'POST', url: `${PREFIX}${RPC}` });
      expect({ method, status: res.statusCode }).toEqual({ method, status: 401 });
    }
    expect(harness.spine.calls).toHaveLength(0);
    expect(harness.fga.calls).toHaveLength(0);
  });

  it('leaves everything at the root when the prefix is empty', async () => {
    harness = await start('');
    expect(harness.app.auth.routes.map((r) => r.url)).toContain(RPC);
    expect(harness.app.hasRoute({ method: 'POST', url: '/auth/devices' })).toBe(true);
    expect((await harness.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });
});

// ===========================================================================
// THE htu PROPERTY — why the edge must not rewrite
// ===========================================================================
describe('the DPoP htu, under a prefix', () => {
  async function enrol(h: Harness, key: DeviceKey, token: string, prefix: string): Promise<string> {
    const url = `${prefix}/auth/devices`;
    const first = await h.app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await makeProof(key, { htm: 'POST', htu: `${TEST_ORIGIN}${url}`, accessToken: token }),
      },
      payload: {},
    });
    const nonce = first.headers['dpop-nonce'] as string;
    if (first.statusCode === 200 || first.statusCode === 201) return nonce;
    const retry = await h.app.inject({
      method: 'POST',
      url,
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await makeProof(key, {
          htm: 'POST',
          htu: `${TEST_ORIGIN}${url}`,
          accessToken: token,
          nonce,
        }),
      },
      payload: {},
    });
    expect([200, 201]).toContain(retry.statusCode);
    return retry.headers['dpop-nonce'] as string;
  }

  async function compare(h: Harness, key: DeviceKey, token: string, nonce: string, htuPath: string) {
    return h.app.inject({
      method: 'POST',
      url: `${PREFIX}${RPC}`,
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        authorization: `DPoP ${token}`,
        dpop: await makeProof(key, {
          htm: 'POST',
          htu: `${TEST_ORIGIN}${htuPath}`,
          accessToken: token,
          nonce,
        }),
      },
      payload: JSON.stringify({ gtin14: GTIN, nowIso: NOW_ISO }),
    });
  }

  it('accepts a proof signed for the PREFIXED url — the no-rewrite case', async () => {
    harness = await start(PREFIX);
    const key = await makeDeviceKey();
    const token = await harness.issuer.mint({ sub: SUB });
    const nonce = await enrol(harness, key, token, PREFIX);

    const res = await compare(harness, key, token, nonce, `${PREFIX}${RPC}`);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { resultJson: string };
    expect(JSON.parse(body.resultJson).heads[0].perStore[0].offers[0].stockOnHand).toBe('7');
  });

  it('REJECTS a proof signed for the stripped url — this is what an edge rewrite would produce', async () => {
    // Everything else about this caller is valid. The only difference is that
    // the client signed the path the edge would have shown it after stripping
    // `/api`. If this ever passes, the htu check has stopped binding the path.
    harness = await start(PREFIX);
    const key = await makeDeviceKey();
    const token = await harness.issuer.mint({ sub: SUB });
    const nonce = await enrol(harness, key, token, PREFIX);

    const res = await compare(harness, key, token, nonce, RPC);

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('invalid_dpop_proof');
    expect(harness.spine.calls).toHaveLength(0);
  });
});

// ===========================================================================
// THE MODULE DEFAULT, exercised directly
// ===========================================================================
describe('registerConnect, called without a prefix', () => {
  it('mounts at the root — the prefix is an option, not a requirement', async () => {
    // buildApp always passes one, so this default is only reachable from a
    // direct call. It is still the documented behaviour of an exported
    // function, and an undefended default is one nobody notices breaking.
    const app = Fastify({ logger: false });
    registerConnect(app, { spineRead: null, initSigning: false });
    await app.ready();

    expect(app.hasRoute({ method: 'POST', url: RPC })).toBe(true);
    await app.close();
  });
});
