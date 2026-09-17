import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAuth, type AuthRuntime, type DeviceStore } from './plugin.js';
import { buildApp } from '../app.js';
import { resolveAuthConfig, type AuthConfig } from './config.js';
import { createAccessTokenVerifier } from './oidc.js';
import type { AppUserState, EnrolledDevice, LiveDevice, RevokedDevice } from '../db/devices.js';
import {
  TEST_ORIGIN,
  makeDeviceKey,
  makeIssuer,
  makeProof,
  type DeviceKey,
  type TestIssuer,
} from '../../test/helpers/auth.js';

const USER = '5f3c1b9a-7e2d-4c6b-8a10-3d9e2f4b6c81';
const OTHER_USER = 'bb22cc33-dd44-4e55-9f66-001122334455';
const NONCE_PERIOD_MS = 300_000;

// ---------------------------------------------------------------------------
// An in-memory device store. The REAL store is proven against Postgres in
// src/db/devices.test.ts; this suite is about the edge behaviour above it, so
// it uses the port rather than a container per assertion.
// ---------------------------------------------------------------------------
function memoryStore() {
  const users = new Map<string, { deletedAt: Date | null }>();
  const devices: Array<{ id: string; userId: string; jkt: string; jwk: unknown; revokedAt: Date | null; enrolledAt: Date }> = [];

  const store: DeviceStore = {
    async ensureAppUser(userId: string): Promise<AppUserState> {
      const existing = users.get(userId);
      if (existing === undefined) {
        users.set(userId, { deletedAt: null });
        return 'created';
      }
      return existing.deletedAt === null ? 'existing' : 'deleted';
    },
    async findLiveDevice(userId: string, jkt: string): Promise<LiveDevice | undefined> {
      if (users.get(userId)?.deletedAt != null) return undefined;
      const row = devices.find((d) => d.userId === userId && d.jkt === jkt && d.revokedAt === null);
      return row ? { deviceId: row.id, jkt } : undefined;
    },
    async enroll(input): Promise<EnrolledDevice> {
      const live = devices.find((d) => d.userId === input.userId && d.jkt === input.jkt && d.revokedAt === null);
      if (live) return { deviceId: live.id, jkt: input.jkt, enrolledAt: live.enrolledAt, created: false };
      const row = {
        id: randomUUID(),
        userId: input.userId,
        jkt: input.jkt,
        jwk: input.jwk,
        revokedAt: null,
        enrolledAt: new Date(),
      };
      devices.push(row);
      return { deviceId: row.id, jkt: input.jkt, enrolledAt: row.enrolledAt, created: true };
    },
    async revoke(input): Promise<RevokedDevice | undefined> {
      const row = devices.find((d) => d.id === input.deviceId && d.userId === input.userId);
      if (!row) return undefined;
      if (row.revokedAt !== null) {
        return { deviceId: row.id, jkt: row.jkt, revokedAt: row.revokedAt, changed: false };
      }
      row.revokedAt = new Date();
      return { deviceId: row.id, jkt: row.jkt, revokedAt: row.revokedAt, changed: true };
    },
  };

  return { store, devices, users };
}

interface Harness {
  app: FastifyInstance;
  runtime: AuthRuntime;
  issuer: TestIssuer;
  config: AuthConfig;
  store: ReturnType<typeof memoryStore>;
  token(sub?: string): Promise<string>;
}

let open: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of open) await app.close();
  open = [];
});

async function harness(
  options: { store?: ReturnType<typeof memoryStore>; issuer?: TestIssuer; env?: Record<string, string> } = {},
): Promise<Harness> {
  const issuer = options.issuer ?? (await makeIssuer());
  const store = options.store ?? memoryStore();
  const config = resolveAuthConfig({
    OIDC_ISSUER: issuer.issuer,
    OIDC_AUDIENCE: issuer.audience,
    OIDC_JWKS_URI: 'https://auth.test.invalid/jwks',
    COORDINATOR_PUBLIC_ORIGIN: TEST_ORIGIN,
    DPOP_NONCE_PERIOD_SECONDS: String(NONCE_PERIOD_MS / 1000),
    ...options.env,
  });

  const app = Fastify({ logger: false });
  const runtime = registerAuth(app, {
    config,
    devices: store.store,
    verifyAccessToken: createAccessTokenVerifier({
      jwks: issuer.jwks,
      issuer: issuer.issuer,
      audience: issuer.audience,
      algorithms: config.oidcAlgorithms,
    }),
  });
  // NOT readied here: deny-by-default means tests add routes to prove they are
  // protected without asking, and inject() boots the instance on first use.
  app.get('/guarded', async (request) => ({ identity: request.callerIdentity }));
  open.push(app);

  return {
    app,
    runtime,
    issuer,
    config,
    store,
    token: (sub = USER) => issuer.mint({ sub }),
  };
}

interface CallOptions {
  method?: string;
  path?: string;
  token: string;
  key: DeviceKey;
  nonce?: string | undefined;
  jti?: string;
  proof?: string;
}

async function call(h: Harness, options: CallOptions) {
  const method = options.method ?? 'GET';
  const path = options.path ?? '/guarded';
  const proof =
    options.proof ??
    (await makeProof(options.key, {
      htm: method,
      htu: `${TEST_ORIGIN}${path}`,
      accessToken: options.token,
      ...(options.nonce !== undefined ? { nonce: options.nonce } : {}),
      ...(options.jti !== undefined ? { jti: options.jti } : {}),
    }));

  return h.app.inject({
    method: method as 'GET',
    url: path,
    headers: { authorization: `DPoP ${options.token}`, dpop: proof },
  });
}

/** Enrol a device the way a first sign-in does, then return it. */
async function enrol(h: Harness, key: DeviceKey, token: string): Promise<string> {
  const first = await call(h, { method: 'POST', path: '/auth/devices', token, key });
  expect(first.statusCode).toBe(401);
  const nonce = first.headers['dpop-nonce'] as string;
  const second = await call(h, { method: 'POST', path: '/auth/devices', token, key, nonce });
  expect(second.statusCode).toBe(201);
  return (second.json() as { deviceId: string }).deviceId;
}

// ===========================================================================
// THE ACCEPTANCE TABLE (plan §C slice 1)
// ===========================================================================
describe('acceptance — DPoP edge', () => {
  let h: Harness;
  let key: DeviceKey;
  let token: string;

  beforeEach(async () => {
    h = await harness();
    key = await makeDeviceKey();
    token = await h.token();
    await enrol(h, key, token);
  });

  it('HAPPY PATH: a bound device with a valid nonce is let through and carries an identity', async () => {
    const res = await call(h, { token, key, nonce: h.runtime.nonce.mint() });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { identity: { sub: string; jkt: string } }).identity).toMatchObject({
      sub: USER,
      jkt: key.jkt,
    });
  });

  it('HAPPY PATH: the coordinator holds no per-request state beyond the jti window', async () => {
    const before = h.runtime.jtiWindow.size;
    for (let i = 0; i < 5; i += 1) {
      expect((await call(h, { token, key, nonce: h.runtime.nonce.mint() })).statusCode).toBe(200);
    }
    expect(h.runtime.jtiWindow.size).toBe(before + 5);
    // one binding entry for the one (user, key) pair — nothing per request
    expect(h.runtime.bindings.size).toBe(1);
  });

  it('REUSED PROOF (same jti) is rejected', async () => {
    const nonce = h.runtime.nonce.mint();
    const proof = await makeProof(key, {
      htm: 'GET',
      htu: `${TEST_ORIGIN}/guarded`,
      accessToken: token,
      nonce,
    });
    expect((await call(h, { token, key, proof })).statusCode).toBe(200);

    const replay = await call(h, { token, key, proof });
    expect(replay.statusCode).toBe(401);
    expect(replay.headers['www-authenticate']).toContain('error="invalid_dpop_proof"');
  });

  it('NO PROOF is rejected', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/guarded',
      headers: { authorization: `DPoP ${token}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_dpop_proof"');
  });

  it('A PROOF SIGNED BY A DIFFERENT DEVICE KEY is rejected', async () => {
    const attacker = await makeDeviceKey();
    const res = await call(h, { token, key: attacker, nonce: h.runtime.nonce.mint() });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_dpop_proof"');
  });

  it('NO NONCE on a nonce-requiring route returns 401 use_dpop_nonce with a fresh nonce, and the retry succeeds', async () => {
    const first = await call(h, { token, key });
    expect(first.statusCode).toBe(401);
    expect(first.headers['www-authenticate']).toContain('error="use_dpop_nonce"');
    expect(first.headers['www-authenticate']).toContain('error_description=');
    const nonce = first.headers['dpop-nonce'] as string;
    expect(nonce).toBeTruthy();

    // The client re-signs the SAME request with the supplied nonce and a FRESH jti.
    const retry = await call(h, { token, key, nonce, jti: randomUUID() });
    expect(retry.statusCode).toBe(200);
  });

  it('A NONCE FROM A PREVIOUS EPOCH is rejected ON THE NONCE CHECK, with the replay cache still empty', async () => {
    // `h` is the process BEFORE the restart; the client holds one of its nonces.
    const carried = h.runtime.nonce.mint();

    // A new process over the SAME device table: new epoch id, new HMAC key,
    // and — the point of the test — an EMPTY replay cache.
    const afterRestart = await harness({ store: h.store, issuer: h.issuer });
    expect(afterRestart.runtime.jtiWindow.size).toBe(0);

    const res = await call(afterRestart, { token, key, nonce: carried });

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="use_dpop_nonce"');
    // BOTH halves of the property: rejected, and NOT by the replay cache, which
    // never saw the jti because the nonce check runs first.
    expect(afterRestart.runtime.jtiWindow.size).toBe(0);

    // And the retry with a nonce from the NEW epoch goes straight through.
    const retry = await call(afterRestart, {
      token,
      key,
      nonce: res.headers['dpop-nonce'] as string,
      jti: randomUUID(),
    });
    expect(retry.statusCode).toBe(200);
  });

  it('A NONCE FROM THE PREVIOUS BUCKET of the same epoch is accepted', async () => {
    // TWO CLOCK READS, KNOWINGLY. This mints against one `Date.now()` and the
    // edge verifies against another a request later, so a bucket boundary
    // falling between them would turn "previous" into "two ago" and fail. The
    // margin is the whole 300 s period against a gap of about two milliseconds
    // — four orders of magnitude wider than the one-second margins that
    // actually flaked in dpop.test.ts, and it has never been observed to fire.
    //
    // It is NOT closed the way those were, because this is an acceptance test
    // over the assembled edge and registerAuth takes no clock: see the comment
    // at its construction, which declines that seam on purpose. Closing this
    // means reversing that decision, which is a bigger question than a flake.
    const previous = h.runtime.nonce.mint(Date.now() - NONCE_PERIOD_MS);
    expect((await call(h, { token, key, nonce: previous })).statusCode).toBe(200);
  });

  it('A REVOKED DEVICE is rejected while the same user’s other device keeps working', async () => {
    const second = await makeDeviceKey();
    await enrol(h, second, token);
    const firstDeviceId = h.store.devices.find((d) => d.jkt === key.jkt)!.id;

    const revoke = await call(h, {
      method: 'POST',
      path: `/auth/devices/${firstDeviceId}/revoke`,
      token,
      key: second,
      nonce: h.runtime.nonce.mint(),
    });
    expect(revoke.statusCode).toBe(200);

    expect((await call(h, { token, key, nonce: h.runtime.nonce.mint() })).statusCode).toBe(401);
    expect((await call(h, { token, key: second, nonce: h.runtime.nonce.mint() })).statusCode).toBe(200);
  });
});

// ===========================================================================
// The access token half
// ===========================================================================
describe('access token handling', () => {
  let h: Harness;
  let key: DeviceKey;
  let token: string;

  beforeEach(async () => {
    h = await harness();
    key = await makeDeviceKey();
    token = await h.token();
    await enrol(h, key, token);
  });

  it('rejects a request with no Authorization header', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/guarded' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('REFUSES the Bearer scheme — a DPoP-bound token must be presented as DPoP', async () => {
    const proof = await makeProof(key, {
      htm: 'GET',
      htu: `${TEST_ORIGIN}/guarded`,
      accessToken: token,
      nonce: h.runtime.nonce.mint(),
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/guarded',
      headers: { authorization: `Bearer ${token}`, dpop: proof },
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('rejects an access token from another issuer', async () => {
    const foreign = await makeIssuer();
    const other = await foreign.mint({ sub: USER });
    const res = await call(h, { token: other, key, nonce: h.runtime.nonce.mint() });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('rejects a token whose subject is not an Authentik uuid', async () => {
    const res = await call(h, { token: await h.issuer.mint({ sub: '42' }), key, nonce: h.runtime.nonce.mint() });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('rejects an authorization header with no credential at all', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/guarded', headers: { authorization: 'DPoP' } });
    expect(res.statusCode).toBe(401);
  });

  it('answers 401 without a body that echoes anything the caller sent', async () => {
    const res = await call(h, { token: 'not.a.token', key, nonce: h.runtime.nonce.mint() });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('not.a.token');
  });
});

// ===========================================================================
// Nonce issuance
// ===========================================================================
describe('nonce issuance', () => {
  it('stamps a fresh DPoP-Nonce on EVERY guarded response, success or failure', async () => {
    const h = await harness();
    const key = await makeDeviceKey();
    const token = await h.token();
    await enrol(h, key, token);

    const ok = await call(h, { token, key, nonce: h.runtime.nonce.mint() });
    expect(ok.statusCode).toBe(200);
    expect(h.runtime.nonce.verify(ok.headers['dpop-nonce'] as string)).toEqual({ ok: true });

    const bad = await h.app.inject({ method: 'GET', url: '/guarded' });
    expect(h.runtime.nonce.verify(bad.headers['dpop-nonce'] as string)).toEqual({ ok: true });
  });

  it('advertises the accepted algorithms so a client can pick one', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/guarded' });
    expect(res.headers['www-authenticate']).toContain('algs="ES256 ES384 PS256 RS256"');
  });
});

// ===========================================================================
// Enrolment and revocation
// ===========================================================================
describe('POST /auth/devices — enrolment', () => {
  it('stores the thumbprint and the PUBLIC jwk on first sign-in', async () => {
    const h = await harness();
    const key = await makeDeviceKey();
    const token = await h.token();
    const deviceId = await enrol(h, key, token);

    const row = h.store.devices.find((d) => d.id === deviceId)!;
    expect(row.jkt).toBe(key.jkt);
    expect(row.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(JSON.stringify(row.jwk)).not.toContain('"d"');
  });

  it('is idempotent: re-enrolling a live key returns 200 and the same device', async () => {
    const h = await harness();
    const key = await makeDeviceKey();
    const token = await h.token();
    const deviceId = await enrol(h, key, token);

    const again = await call(h, {
      method: 'POST',
      path: '/auth/devices',
      token,
      key,
      nonce: h.runtime.nonce.mint(),
    });
    expect(again.statusCode).toBe(200);
    expect((again.json() as { deviceId: string }).deviceId).toBe(deviceId);
    expect(h.store.devices).toHaveLength(1);
  });

  it('accepts a device key that is NOT yet enrolled — that is the whole point', async () => {
    const h = await harness();
    const token = await h.token();
    const fresh = await makeDeviceKey();
    const res = await call(h, {
      method: 'POST',
      path: '/auth/devices',
      token,
      key: fresh,
      nonce: h.runtime.nonce.mint(),
    });
    expect(res.statusCode).toBe(201);
  });

  it('still demands a valid proof: an unsigned or stale proof cannot enrol a key', async () => {
    const h = await harness();
    const token = await h.token();
    const key = await makeDeviceKey();
    const stale = await makeProof(key, {
      htm: 'POST',
      htu: `${TEST_ORIGIN}/auth/devices`,
      accessToken: token,
      nonce: h.runtime.nonce.mint(),
      iat: Math.floor(Date.now() / 1000) - 600,
    });
    const res = await call(h, { method: 'POST', path: '/auth/devices', token, key, proof: stale });
    expect(res.statusCode).toBe(401);
    expect(h.store.devices).toHaveLength(0);
  });

  it('REFUSES to enrol for a soft-deleted user', async () => {
    const h = await harness();
    const token = await h.token();
    const key = await makeDeviceKey();
    await h.store.store.ensureAppUser(USER);
    h.store.users.set(USER, { deletedAt: new Date() });

    const res = await call(h, {
      method: 'POST',
      path: '/auth/devices',
      token,
      key,
      nonce: h.runtime.nonce.mint(),
    });
    expect(res.statusCode).toBe(403);
    expect(h.store.devices).toHaveLength(0);
  });

  it('records an optional label without trusting its length', async () => {
    const h = await harness();
    const token = await h.token();
    const key = await makeDeviceKey();
    const proof = await makeProof(key, {
      htm: 'POST',
      htu: `${TEST_ORIGIN}/auth/devices`,
      accessToken: token,
      nonce: h.runtime.nonce.mint(),
    });
    const res = await h.app.inject({
      method: 'POST',
      url: '/auth/devices',
      headers: { authorization: `DPoP ${token}`, dpop: proof },
      payload: { label: 'x'.repeat(500) },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /auth/devices/:deviceId/revoke', () => {
  it('revokes and is idempotent, never deleting the row', async () => {
    const h = await harness();
    const key = await makeDeviceKey();
    const token = await h.token();
    const deviceId = await enrol(h, key, token);
    const second = await makeDeviceKey();
    await enrol(h, second, token);

    const first = await call(h, {
      method: 'POST',
      path: `/auth/devices/${deviceId}/revoke`,
      token,
      key: second,
      nonce: h.runtime.nonce.mint(),
    });
    expect(first.statusCode).toBe(200);
    expect((first.json() as { revoked: boolean }).revoked).toBe(true);

    const again = await call(h, {
      method: 'POST',
      path: `/auth/devices/${deviceId}/revoke`,
      token,
      key: second,
      nonce: h.runtime.nonce.mint(),
    });
    expect(again.statusCode).toBe(200);
    expect(h.store.devices).toHaveLength(2);
  });

  it('refuses to revoke a device belonging to ANOTHER user', async () => {
    const h = await harness();
    const victimKey = await makeDeviceKey();
    const victimToken = await h.token(OTHER_USER);
    const victimDevice = await enrol(h, victimKey, victimToken);

    const attackerKey = await makeDeviceKey();
    const attackerToken = await h.token(USER);
    await enrol(h, attackerKey, attackerToken);

    const res = await call(h, {
      method: 'POST',
      path: `/auth/devices/${victimDevice}/revoke`,
      token: attackerToken,
      key: attackerKey,
      nonce: h.runtime.nonce.mint(),
    });
    expect(res.statusCode).toBe(404);
    expect(await h.store.store.findLiveDevice(OTHER_USER, victimKey.jkt)).toBeDefined();
  });

  it('rejects a device id that is not a uuid before it reaches the database', async () => {
    const h = await harness();
    const key = await makeDeviceKey();
    const token = await h.token();
    await enrol(h, key, token);

    const res = await call(h, {
      method: 'POST',
      path: '/auth/devices/not-a-uuid/revoke',
      token,
      key,
      nonce: h.runtime.nonce.mint(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /auth/session', () => {
  it('returns the verified identity for a bound device', async () => {
    const h = await harness();
    const key = await makeDeviceKey();
    const token = await h.token();
    const deviceId = await enrol(h, key, token);

    const res = await call(h, { path: '/auth/session', token, key, nonce: h.runtime.nonce.mint() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: USER, deviceId, jkt: key.jkt });
  });
});

// ===========================================================================
// DENY BY DEFAULT (challenger B2). A route that forgets to ask for protection
// must be protected anyway. The enumeration test is the part that keeps this
// true as the Connect surface lands beside it.
// ===========================================================================
describe('the edge is deny-by-default', () => {
  it('protects a route that asked for NOTHING', async () => {
    const h = await harness();
    h.app.get('/forgot-to-guard', async () => ({ secret: 'stockOnHand=3' }));
    await h.app.ready();

    const res = await h.app.inject({ method: 'GET', url: '/forgot-to-guard' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('stockOnHand');
  });

  it('protects a route registered AFTER the auth wiring, with any method', async () => {
    const h = await harness();
    h.app.post('/late/:id', async () => ({ ok: true }));
    h.app.delete('/late/:id', async () => ({ ok: true }));
    await h.app.ready();

    expect((await h.app.inject({ method: 'POST', url: '/late/1' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'DELETE', url: '/late/1' })).statusCode).toBe(401);
  });

  it('lets a route opt OUT explicitly, and only explicitly', async () => {
    const h = await harness();
    h.app.get('/open', { config: { auth: 'public' } }, async () => ({ ok: true }));
    await h.app.ready();

    expect((await h.app.inject({ method: 'GET', url: '/open' })).statusCode).toBe(200);
  });

  it('answers an unknown path with 401, not 404 — an unauthenticated caller gets no path oracle', async () => {
    const h = await harness();
    const res = await h.app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(res.statusCode).toBe(401);
  });

  it('records every registered route, with the protection class that applies to it', async () => {
    const h = await harness();
    await h.app.ready();
    const urls = h.runtime.routes.map((r) => `${r.method} ${r.url} ${r.auth}`).sort();
    expect(urls).toContain('POST /auth/devices enrolment');
    expect(urls).toContain('GET /auth/session guarded');
    expect(urls).toContain('POST /auth/devices/:deviceId/revoke guarded');
  });
});

describe('ROUTE ENUMERATION — every route on the real app is accounted for', () => {
  const PUBLIC = new Set(['GET /healthz', 'HEAD /healthz']);

  async function realApp() {
    const issuer = await makeIssuer();
    const store = memoryStore();
    const config = resolveAuthConfig({
      OIDC_ISSUER: issuer.issuer,
      OIDC_AUDIENCE: issuer.audience,
      OIDC_JWKS_URI: 'https://auth.test.invalid/jwks',
      COORDINATOR_PUBLIC_ORIGIN: TEST_ORIGIN,
    });
    const app = buildApp({
      db: { query: async () => ({ rows: [] }) },
      logLevel: 'silent',
      auth: {
        config,
        devices: store.store,
        verifyAccessToken: createAccessTokenVerifier({
          jwks: issuer.jwks,
          issuer: issuer.issuer,
          audience: issuer.audience,
          algorithms: config.oidcAlgorithms,
        }),
      },
    });
    await app.ready();
    open.push(app);
    return app;
  }

  it('rejects an unauthenticated request to EVERY route that is not on the public allowlist', async () => {
    const app = await realApp();
    const routes = app.auth.routes.filter((r) => !PUBLIC.has(`${r.method} ${r.url}`));
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      const url = route.url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await app.inject({ method: route.method as 'GET', url });
      expect({ route: `${route.method} ${route.url}`, status: res.statusCode }).toEqual({
        route: `${route.method} ${route.url}`,
        status: 401,
      });
    }
  });

  it('serves the public allowlist without credentials', async () => {
    const app = await realApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    // 200 because the injected db answers. The point is that it answered AT ALL
    // with no Authorization header and no proof.
    expect(res.statusCode).toBe(200);
    expect(res.headers['www-authenticate']).toBeUndefined();
  });

  it('the registry holds every METHOD of every route Fastify actually serves', async () => {
    const app = await realApp();
    // hasRoute is the independent source, and it is asked PER METHOD. A registry
    // built from a route entry whose `method` is an array would otherwise record
    // one method and hide the other eight — the exact shape connect-fastify
    // registers an RPC in. Counting per URL is what makes that visible.
    const byUrl = new Map<string, string[]>();
    for (const route of app.auth.routes) {
      byUrl.set(route.url, [...(byUrl.get(route.url) ?? []), route.method]);
    }
    expect(byUrl.size).toBeGreaterThan(0);

    for (const [url, registered] of byUrl) {
      const served = app.supportedMethods.filter((method) => app.hasRoute({ method, url }));
      expect({ url, methods: [...registered].sort() }).toEqual({ url, methods: [...served].sort() });
    }
  });

  it('finds no route Fastify serves that the registry missed', async () => {
    const app = await realApp();
    const known = new Set(app.auth.routes.map((r) => `${r.method} ${r.url}`));
    for (const url of new Set(app.auth.routes.map((r) => r.url))) {
      for (const method of app.supportedMethods) {
        if (app.hasRoute({ method, url })) {
          expect(known.has(`${method} ${url}`)).toBe(true);
        }
      }
    }
  });
});

// ===========================================================================
// THE NINE-METHOD ROUTE. connect-fastify registers an RPC as ONE route entry
// whose `method` is an ARRAY of nine verbs. A guard that assumes `method` is a
// string, or that only POST carries a body worth protecting, leaves eight of
// them open while a URL-only enumeration test still passes.
//
// Connect unary is POST + `Content-Type: application/json` +
// `Connect-Protocol-Version: 1` with a BARE message body. The guard must read
// nothing but the Authorization and DPoP headers: no form body, no CSRF token,
// no Accept negotiation.
// ===========================================================================
const CONNECT_METHODS = ['GET', 'HEAD', 'TRACE', 'DELETE', 'OPTIONS', 'PATCH', 'PUT', 'POST', 'QUERY'];
const RPC_URL = '/coordinator.v1.CompareService/Compare';

describe('a Connect-shaped route registered with a nine-method array', () => {
  it('is guarded on EVERY ONE of the nine methods, not just POST', async () => {
    const h = await harness();
    h.app.route({
      method: CONNECT_METHODS as never,
      url: RPC_URL,
      handler: async () => ({ stockOnHand: 3 }),
    });

    const statuses: Record<string, number> = {};
    for (const method of CONNECT_METHODS) {
      const res = await h.app.inject({ method: method as 'POST', url: RPC_URL });
      statuses[method] = res.statusCode;
      expect(res.body).not.toContain('stockOnHand');
    }

    expect(statuses).toEqual(Object.fromEntries(CONNECT_METHODS.map((m) => [m, 401])));
  });

  it('classifies all nine methods in the registry, so the enumeration test sees nine routes', async () => {
    const h = await harness();
    h.app.route({ method: CONNECT_METHODS as never, url: RPC_URL, handler: async () => ({}) });
    await h.app.ready();

    const registered = h.runtime.routes.filter((r) => r.url === RPC_URL);
    expect(registered.map((r) => r.method).sort()).toEqual([...CONNECT_METHODS].sort());
    expect(registered.every((r) => r.auth === 'guarded')).toBe(true);
  });

  it('lets a correctly signed Connect unary POST through, reading only the two headers', async () => {
    const h = await harness();
    // Register BEFORE the first inject: inject boots the instance, and Fastify
    // refuses routes after that. This is the same ordering rule the guard
    // depends on, surfacing in a test.
    h.app.route({
      method: CONNECT_METHODS as never,
      url: RPC_URL,
      handler: async (request) => ({ sub: request.callerIdentity?.sub }),
    });
    const key = await makeDeviceKey();
    const token = await h.token();
    await enrol(h, key, token);

    const proof = await makeProof(key, {
      htm: 'POST',
      htu: `${TEST_ORIGIN}${RPC_URL}`,
      accessToken: token,
      nonce: h.runtime.nonce.mint(),
    });
    const res = await h.app.inject({
      method: 'POST',
      url: RPC_URL,
      headers: {
        authorization: `DPoP ${token}`,
        dpop: proof,
        'content-type': 'application/json',
        'connect-protocol-version': '1',
      },
      payload: { gtin14: '04901990123456' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sub: USER });
  });
});

describe('the subject reaches the entitlement seam VERBATIM', () => {
  it('passes the Authentik uuid through byte for byte, never trimmed or case-folded', async () => {
    // OpenFGA compares subjects byte for byte, so any normalisation here shows
    // up downstream as a silently empty entitlement set.
    const mixedCase = '5F3C1B9A-7e2d-4C6B-8a10-3D9E2F4B6C81';
    const h = await harness();
    const key = await makeDeviceKey();
    const token = await h.token(mixedCase);
    await enrol(h, key, token);

    const res = await call(h, { token, key, nonce: h.runtime.nonce.mint() });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { identity: { sub: string } }).identity.sub).toBe(mixedCase);
  });
});
