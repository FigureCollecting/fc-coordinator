/**
 * THE SEAM BETWEEN THE TWO SLICE-1b BRANCHES, tested where they actually meet.
 *
 * The auth branch proves its guard handles a nine-method route by registering a
 * SYNTHETIC one with the right shape. That is a good test of the guard. It is
 * not a test of THIS service, because a stand-in route is one someone wrote to
 * match what connect-fastify does — and the thing worth knowing is whether the
 * REAL Connect surface, registered by the real plugin inside the real buildApp,
 * is covered.
 *
 * Neither branch could assert that alone, so it lives here. Three levels, in
 * increasing order of how much they would survive a refactor:
 *
 *   STRUCTURAL   the real route carries no `config.auth`, so the registry
 *                classifies it `guarded`. Absence IS the protection, and this
 *                is the assertion that fails if someone ever "fixes" a 401 by
 *                adding `config: { auth: 'public' }`.
 *   BEHAVIOURAL  every one of the nine methods rejects an uncredentialed call,
 *                and the spine is never reached. This survives any change to
 *                how routes are classified, because it asks the socket.
 *   END TO END   a real Connect unary POST with a real access token and a real
 *                DPoP proof reaches the handler, and the subject the edge
 *                verified is the subject the entitlement was minted for.
 *
 * The last one is the point of the whole slice: it is the first test in which
 * the identity a caller PROVED and the identity the spine is told about are the
 * same value, established by two independently built modules.
 */
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { CompareService } from '@figurecollecting/fc-api-contract';
import { INVENTORY_LEVELS } from '@figurecollecting/ingest-contract/entitlement';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { buildApp } from '../../src/app.js';
import { resolveAuthConfig } from '../../src/auth/config.js';
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

/** The nine verbs connect-fastify registers an RPC under. Asserted, not assumed. */
const CONNECT_METHODS = ['GET', 'HEAD', 'TRACE', 'DELETE', 'OPTIONS', 'PATCH', 'PUT', 'QUERY', 'POST'];
const RPC_PATH = '/coordinator.v1.CompareService/Compare';
const KID = 'ent-test-2026-09';
const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const NOW_ISO = '2026-09-14T12:00:00.000Z';
const GTIN = '04573102591234';

const ENV_KEYS = [
  'OPENFGA_API_URL',
  'OPENFGA_STORE_ID',
  'ENTITLEMENT_SIGNING_KEY_PEM',
  'ENTITLEMENT_SIGNING_KID',
] as const;

const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

/** The device table as a Map. The edge takes it as a port precisely for this. */
function memoryDevices(): DeviceStore {
  const rows: { userId: string; deviceId: string; jkt: string; revokedAt: Date | null }[] = [];
  let n = 0;
  return {
    ensureAppUser: async (): Promise<AppUserState> => 'existing',
    findLiveDevice: async (userId, jkt): Promise<LiveDevice | undefined> => {
      const row = rows.find((r) => r.userId === userId && r.jkt === jkt && r.revokedAt === null);
      return row ? { deviceId: row.deviceId, jkt: row.jkt } : undefined;
    },
    enroll: async (input): Promise<EnrolledDevice> => {
      const existing = rows.find(
        (r) => r.userId === input.userId && r.jkt === input.jkt && r.revokedAt === null,
      );
      if (existing) {
        return { deviceId: existing.deviceId, jkt: existing.jkt, enrolledAt: new Date(), created: false };
      }
      const row = { userId: input.userId, deviceId: `dev-${++n}`, jkt: input.jkt, revokedAt: null };
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
  routes: RouteOptions[];
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

/**
 * The PRODUCTION wiring: buildApp with both `auth` and `compare`, in that order,
 * exactly as src/server.ts calls it. No resolveIdentity is injected — the whole
 * point is that the default reads what the edge decorated.
 */
async function start(options: { allow: boolean } = { allow: true }): Promise<Harness> {
  const kp = generateTestSigningKey(KID);
  process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
  process.env['ENTITLEMENT_SIGNING_KID'] = KID;

  const fga = await startFakeOpenFga(() => options.allow);
  process.env['OPENFGA_API_URL'] = fga.baseUrl;
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

  // Observe the REAL route table. Registered before ready(), which is the same
  // ordering rule the guard itself depends on.
  const routes: RouteOptions[] = [];
  app.addHook('onRoute', (route) => {
    routes.push(route);
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, baseUrl, spine, fga, issuer, routes };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  // The ported module writes its boot line to console by design (it may not
  // import this app's logger and stay portable).
  vi.spyOn(console, 'log').mockImplementation(() => {});
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

const compareRoute = (h: Harness): RouteOptions => {
  const route = h.routes.find((r) => r.url === RPC_PATH);
  expect(route).toBeDefined();
  return route as RouteOptions;
};

// ===========================================================================
// STRUCTURAL — the real route is classified `guarded`, by absence.
// ===========================================================================
describe('the real Connect route, as the registry sees it', () => {
  it('is registered under all nine Connect methods', async () => {
    harness = await start();
    const methods = compareRoute(harness).method as unknown as string[];

    // Pinned as a SET rather than a count: if connect-fastify ever adds or drops
    // a verb, this says which, and the guard's own nine-method test needs the
    // same list updated in step.
    expect(Array.isArray(methods)).toBe(true);
    expect([...methods].sort()).toEqual([...CONNECT_METHODS].sort());
  });

  it('declares NO config.auth, so the deny-by-default registry classifies it guarded', async () => {
    harness = await start();
    const route = compareRoute(harness);

    // The whole design of the edge is that `auth` is absent for a protected
    // route: `route.config?.auth ?? 'guarded'`. If anyone ever silences a 401
    // here by adding `config: { auth: 'public' }`, this is the line that stops
    // it, and it stops it at review time rather than at the next audit.
    expect((route.config as { auth?: string } | undefined)?.auth).toBeUndefined();
  });

  it('NO route on the Connect surface opts out, this one or any future one', async () => {
    harness = await start();

    // WHAT THIS HOOK CAN AND CANNOT SEE, because it is a trap worth writing
    // down: it is added after buildApp returns, so it never fires for routes
    // buildApp registered SYNCHRONOUSLY — /healthz and the enrolment routes are
    // already bound by then. It DOES see everything registered through
    // `app.register()`, which Fastify defers until ready(), and that is exactly
    // the Connect surface. So this assertion is scoped to the Connect surface
    // on purpose; the service-wide allowlist is the edge's own registry test
    // (src/auth/plugin.test.ts), which sees every route because it hooks first.
    expect(harness.routes.length).toBeGreaterThan(0);
    const optOuts = harness.routes
      .filter((r) => (r.config as { auth?: string } | undefined)?.auth !== undefined)
      .map((r) => `${r.url} -> ${(r.config as { auth?: string }).auth}`);

    // Today that is one RPC. When sync and the image read side land beside it,
    // this is what stops any of them shipping public by accident.
    expect(optOuts).toEqual([]);
    expect(harness.routes.map((r) => r.url)).toEqual([RPC_PATH]);
  });
});

// ===========================================================================
// BEHAVIOURAL — every method rejects, and nothing downstream is touched.
// ===========================================================================
describe('an uncredentialed call to Compare', () => {
  it.each(CONNECT_METHODS)('is rejected on %s, not just on POST', async (method) => {
    harness = await start();

    const res = await harness.app.inject({
      method: method as 'POST',
      url: RPC_PATH,
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      payload: method === 'GET' || method === 'HEAD' ? undefined : '{"gtin14":"04573102591234"}',
    });

    expect(res.statusCode).toBe(401);
    // Nothing leaked on the way to the refusal.
    expect(res.body).not.toContain('stockOnHand');
    expect(res.body).not.toContain('semanticsRev');
  });

  it('never reaches the spine or OpenFGA — the guard runs BEFORE the handler', async () => {
    harness = await start();

    for (const method of CONNECT_METHODS) {
      await harness.app.inject({ method: method as 'POST', url: RPC_PATH });
    }

    // If the guard ran after the handler, or only on POST, one of these would
    // have made a mesh hop for an anonymous caller.
    expect(harness.spine.calls).toHaveLength(0);
    expect(harness.fga.calls).toHaveLength(0);
  });

  it('answers with a fresh DPoP-Nonce, so a real client can immediately retry', async () => {
    harness = await start();
    const res = await harness.app.inject({ method: 'POST', url: RPC_PATH });

    expect(res.statusCode).toBe(401);
    expect(res.headers['dpop-nonce']).toMatch(/.+/);
  });
});

// ===========================================================================
// END TO END — a proved identity becomes an entitled read.
// ===========================================================================
describe('a fully credentialed Connect unary POST', () => {
  /** Enrol a device the way a client would, then return a nonce to reuse. */
  async function enrol(h: Harness, key: DeviceKey, token: string): Promise<string> {
    const first = await h.app.inject({
      method: 'POST',
      url: '/auth/devices',
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await makeProof(key, {
          htm: 'POST',
          htu: `${TEST_ORIGIN}/auth/devices`,
          accessToken: token,
        }),
      },
      payload: {},
    });
    // The nonce-less first attempt is answered with one; the retry succeeds.
    const nonce = first.headers['dpop-nonce'] as string;
    if (first.statusCode !== 200 && first.statusCode !== 201) {
      const retry = await h.app.inject({
        method: 'POST',
        url: '/auth/devices',
        headers: {
          authorization: `DPoP ${token}`,
          dpop: await makeProof(key, {
            htm: 'POST',
            htu: `${TEST_ORIGIN}/auth/devices`,
            accessToken: token,
            nonce,
          }),
        },
        payload: {},
      });
      expect([200, 201]).toContain(retry.statusCode);
      return retry.headers['dpop-nonce'] as string;
    }
    return nonce;
  }

  async function compare(
    h: Harness,
    key: DeviceKey,
    token: string,
    nonce: string,
  ): Promise<ReturnType<FastifyInstance['inject']>> {
    return h.app.inject({
      method: 'POST',
      url: RPC_PATH,
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        authorization: `DPoP ${token}`,
        dpop: await makeProof(key, {
          htm: 'POST',
          htu: `${TEST_ORIGIN}${RPC_PATH}`,
          accessToken: token,
          nonce,
        }),
      },
      payload: JSON.stringify({ gtin14: GTIN, nowIso: NOW_ISO }),
    });
  }

  it('passes the guard and comes back ENTITLED for the subject the proof was signed for', async () => {
    harness = await start({ allow: true });
    const key = await makeDeviceKey();
    const token = await harness.issuer.mint({ sub: SUB });
    const nonce = await enrol(harness, key, token);

    const res = await compare(harness, key, token, nonce);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { resultJson: string; coverage?: { redacted?: string[] } };
    expect(JSON.parse(body.resultJson).heads[0].perStore[0].offers[0].stockOnHand).toBe('7');
    expect(body.coverage?.redacted ?? []).toEqual([]);

    // THE ASSERTION THIS WHOLE FILE EXISTS FOR: the uuid the DPoP proof was
    // verified for is the uuid OpenFGA was asked about. Two modules built on
    // two branches, one identity, and no way for the client to name its own.
    expect(JSON.stringify(harness.fga.calls[0]?.body)).toContain(`user:${SUB}`);
    expect(harness.spine.calls[0]?.entitlementOutcome).toBe('granted');
  });

  it('comes back REDACTED for the same credentialed caller when OpenFGA denies', async () => {
    // Authentication and authorisation are different answers. The caller is
    // just as authentic here; they simply hold no grant.
    harness = await start({ allow: false });
    const key = await makeDeviceKey();
    const token = await harness.issuer.mint({ sub: SUB });
    const nonce = await enrol(harness, key, token);

    const res = await compare(harness, key, token, nonce);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { resultJson: string; coverage?: { redacted?: string[] } };
    expect(JSON.parse(body.resultJson).heads[0].perStore[0].offers[0].stockOnHand).toBeUndefined();
    expect(body.coverage?.redacted).toEqual([INVENTORY_LEVELS]);
  });

  it('reads only the two auth headers — the Connect body and content type are untouched', async () => {
    // A guard that wanted a form body, a CSRF token or a negotiated Accept would
    // reject Connect's bare-JSON POST. This passing is the proof it does not.
    harness = await start({ allow: true });
    const key = await makeDeviceKey();
    const token = await harness.issuer.mint({ sub: SUB });
    const nonce = await enrol(harness, key, token);

    const res = await compare(harness, key, token, nonce);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    // The request really did carry the Connect shape, and the seed survived it.
    expect(harness.spine.calls[0]?.request.seed).toEqual({ case: 'gtin14', value: GTIN });
  });

  it('works through a REAL Connect client over a socket, not only through inject', async () => {
    // inject() bypasses the HTTP stack. The mesh will not.
    harness = await start({ allow: true });
    const key = await makeDeviceKey();
    const token = await harness.issuer.mint({ sub: SUB });
    const nonce = await enrol(harness, key, token);

    const client: Client<typeof CompareService> = createClient(
      CompareService,
      createConnectTransport({ baseUrl: harness.baseUrl, httpVersion: '1.1' }),
    );

    const res = await client.compare(
      { seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO },
      {
        headers: {
          authorization: `DPoP ${token}`,
          dpop: await makeProof(key, {
            htm: 'POST',
            htu: `${TEST_ORIGIN}${RPC_PATH}`,
            accessToken: token,
            nonce,
          }),
        },
      },
    );

    expect(JSON.parse(res.resultJson).heads[0].perStore[0].offers[0].stockOnHand).toBe('7');
    expect(res.coverage?.redacted).toEqual([]);
  });
});
