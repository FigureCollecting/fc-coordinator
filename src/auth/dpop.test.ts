import { beforeEach, describe, expect, it } from 'vitest';
import { resolveAuthConfig } from './config.js';
import { createNonceEpoch, type NonceEpoch } from './nonce.js';
import { createJtiWindow, type JtiWindow } from './replay.js';
import { verifyDpopProof, type DpopVerifyInput } from './dpop.js';
import { TEST_ORIGIN, accessTokenHash, makeDeviceKey, makeProof, type DeviceKey } from '../../test/helpers/auth.js';

/**
 * A LOOSENED view of DpopOutcome. The production type is a discriminated union,
 * which is exactly right for callers — but it means a test cannot read `.reason`
 * without first narrowing on `.ok`, and `expect(...).reason` reads better as an
 * assertion than a narrowing dance repeated forty times.
 */
type AnyOutcome = {
  ok: boolean;
  reason?: string;
  error?: string;
  jkt?: string;
  jti?: string;
  deviceId?: string;
  jwk?: unknown;
};

const dpopVerify = (input: DpopVerifyInput): Promise<AnyOutcome> =>
  verifyDpopProof(input) as Promise<AnyOutcome>;

const ACCESS_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.header-free-fixture.signature';
const PATH = '/coordinator.v1.Sync/Push';
const HTU = `${TEST_ORIGIN}${PATH}`;
const PERIOD_MS = 300_000;
const DEVICE_ID = 'c9f0c6a5-9d06-4a5f-9b1f-6e3b9a4d0c21';

let key: DeviceKey;
let nonce: NonceEpoch;
let jti: JtiWindow;

beforeEach(async () => {
  key = await makeDeviceKey();
  nonce = createNonceEpoch({ periodMs: PERIOD_MS });
  jti = createJtiWindow({ ttlMs: 35_000, maxEntries: 100 });
});

/** Binding that accepts exactly the key under test — the enrolled-device case. */
function boundTo(device: DeviceKey) {
  return async (thumbprint: string) =>
    thumbprint === device.jkt ? { bound: true as const, deviceId: DEVICE_ID } : { bound: false as const };
}

async function input(overrides: Partial<DpopVerifyInput> = {}, proofOverrides = {}): Promise<DpopVerifyInput> {
  const proof = await makeProof(key, {
    htm: 'POST',
    htu: HTU,
    accessToken: ACCESS_TOKEN,
    nonce: nonce.mint(),
    ...proofOverrides,
  });
  return {
    proof,
    method: 'POST',
    path: PATH,
    origin: TEST_ORIGIN,
    accessToken: ACCESS_TOKEN,
    resolveBinding: boundTo(key),
    nonce,
    jti,
    algorithms: ['ES256', 'ES384', 'PS256', 'RS256'],
    maxAgeSeconds: 30,
    clockSkewSeconds: 5,
    requireNonce: true,
    ...overrides,
  };
}

describe('verifyDpopProof — happy path', () => {
  it('accepts a fresh, bound, nonce-carrying proof and reports the device', async () => {
    const result = await dpopVerify(await input());
    expect(result).toEqual({
      ok: true,
      jkt: key.jkt,
      jti: expect.any(String),
      deviceId: DEVICE_ID,
      jwk: key.publicJwk,
    });
  });

  it('returns the VERIFIED public jwk, so enrolment stores the key the signature proved', async () => {
    const result = await dpopVerify(await input());
    expect(result.ok && result.jwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(JSON.stringify(result.ok && result.jwk)).not.toContain('"d"');
  });

  it('consumes the jti so the SAME proof cannot be presented twice', async () => {
    const one = await input();
    expect((await dpopVerify(one)).ok).toBe(true);
    expect(await dpopVerify(one)).toEqual({
      ok: false,
      reason: 'jti_replayed',
      error: 'invalid_dpop_proof',
    });
  });

  it('accepts an RSA-PSS device key as well as EC', async () => {
    const rsa = await makeDeviceKey('PS256');
    const result = await dpopVerify(
      await input({ resolveBinding: boundTo(rsa) }, {}).then(async (base) => ({
        ...base,
        proof: await makeProof(rsa, { htm: 'POST', htu: HTU, accessToken: ACCESS_TOKEN, nonce: nonce.mint() }),
      })),
    );
    expect(result).toMatchObject({ ok: true, jkt: rsa.jkt });
  });
});

describe('verifyDpopProof — step 1, the proof itself', () => {
  it('rejects a missing proof, and treats an empty header as absent', async () => {
    for (const proof of [undefined, '']) {
      expect(await dpopVerify(await input({ proof }))).toEqual({
        ok: false,
        reason: 'missing_proof',
        error: 'invalid_dpop_proof',
      });
    }
  });

  it('rejects more than one DPoP header — RFC 9449 allows exactly one', async () => {
    const base = await input();
    expect(await dpopVerify({ ...base, proof: [base.proof as string, base.proof as string] })).toEqual({
      ok: false,
      reason: 'multiple_proofs',
      error: 'invalid_dpop_proof',
    });
  });

  it('rejects a syntactically broken proof', async () => {
    for (const proof of ['not-a-jwt', 'a.b', 'a.b.c']) {
      expect((await dpopVerify(await input({ proof }))).reason).toBe('malformed_proof');
    }
  });

  it('rejects a proof with NO embedded jwk', async () => {
    expect((await dpopVerify(await input({}, { omitJwk: true }))).reason).toBe('malformed_proof');
  });

  it('REFUSES an embedded jwk that carries private key parameters', async () => {
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
      const result = await dpopVerify(
        await input({}, { header: { jwk: { ...key.publicJwk, [secret]: 'leaked' } } }),
      );
      expect(result).toEqual({ ok: false, reason: 'malformed_proof', error: 'invalid_dpop_proof' });
    }
  });

  it('rejects a typ that is not dpop+jwt', async () => {
    expect((await dpopVerify(await input({}, { typ: 'JWT' }))).reason).toBe('malformed_proof');
  });

  it('rejects an algorithm outside the allowlist', async () => {
    expect((await dpopVerify(await input({ algorithms: ['PS256'] }))).reason).toBe(
      'unsupported_algorithm',
    );
  });

  it('rejects a proof whose signature was tampered with', async () => {
    const base = await input();
    const [header, payload, signature] = (base.proof as string).split('.');
    const flipped = Buffer.from(signature!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    const tampered = `${header}.${payload}.${flipped.toString('base64url')}`;
    expect((await dpopVerify({ ...base, proof: tampered })).reason).toBe('malformed_proof');
  });

  it('rejects a proof with no jti, a non-string jti, or an absurdly long one', async () => {
    for (const bad of [{ jti: '' }, { jti: 'x'.repeat(200) }]) {
      expect((await dpopVerify(await input({}, bad))).reason).toBe('malformed_proof');
    }
  });
});

describe('verifyDpopProof — step 2, the binding, runs BEFORE htm/htu', () => {
  it('rejects a proof signed by a device key that is not bound to this token', async () => {
    const other = await makeDeviceKey();
    const base = await input();
    const proof = await makeProof(other, {
      htm: 'POST',
      htu: HTU,
      accessToken: ACCESS_TOKEN,
      nonce: nonce.mint(),
    });
    expect(await dpopVerify({ ...base, proof })).toEqual({
      ok: false,
      reason: 'key_not_bound',
      error: 'invalid_dpop_proof',
    });
  });

  it('rejects a revoked device — resolveBinding is the single revocation point', async () => {
    expect(
      (await dpopVerify(await input({ resolveBinding: async () => ({ bound: false as const }) }))).reason,
    ).toBe('key_not_bound');
  });

  it('reports key_not_bound, not htm_mismatch, when BOTH are wrong — the order is binding', async () => {
    const other = await makeDeviceKey();
    const base = await input();
    const proof = await makeProof(other, {
      htm: 'DELETE',
      htu: 'https://elsewhere.test.invalid/x',
      accessToken: ACCESS_TOKEN,
      nonce: nonce.mint(),
    });
    expect((await dpopVerify({ ...base, proof })).reason).toBe('key_not_bound');
  });

  it('does not consume the jti when the key is not bound', async () => {
    const other = await makeDeviceKey();
    const base = await input();
    const proof = await makeProof(other, { htm: 'POST', htu: HTU, accessToken: ACCESS_TOKEN, nonce: nonce.mint() });
    await dpopVerify({ ...base, proof });
    expect(jti.size).toBe(0);
  });
});

describe('verifyDpopProof — steps 3 and 4, htm/htu then iat', () => {
  it('rejects a method the proof did not commit to', async () => {
    expect((await dpopVerify(await input({ method: 'DELETE' }))).reason).toBe('htm_mismatch');
  });

  it('compares the method case-insensitively but exactly', async () => {
    expect((await dpopVerify(await input({ method: 'post' }, { htm: 'POST' }))).ok).toBe(true);
  });

  it('rejects a proof bound to a different path', async () => {
    expect((await dpopVerify(await input({}, { htu: `${TEST_ORIGIN}/other` }))).reason).toBe(
      'htu_mismatch',
    );
  });

  it('rejects a proof bound to a different ORIGIN, even with the right path', async () => {
    expect(
      (await dpopVerify(await input({}, { htu: `https://evil.test.invalid${PATH}` }))).reason,
    ).toBe('htu_mismatch');
  });

  it('ignores query and fragment on both sides, per RFC 9449', async () => {
    const result = await dpopVerify(
      await input({ path: `${PATH}?after=42` }, { htu: `${HTU}?ignored=1#frag` }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an htu that is not an absolute URL', async () => {
    expect((await dpopVerify(await input({}, { htu: PATH }))).reason).toBe('htu_mismatch');
  });

  it('rejects a proof older than the iat window', async () => {
    const stale = Math.floor(Date.now() / 1000) - 31;
    expect((await dpopVerify(await input({}, { iat: stale }))).reason).toBe('iat_out_of_window');
  });

  it('rejects a proof dated further into the future than the allowed skew', async () => {
    const ahead = Math.floor(Date.now() / 1000) + 6;
    expect((await dpopVerify(await input({}, { iat: ahead }))).reason).toBe('iat_out_of_window');
  });

  it('accepts a proof inside the skew allowance on either side', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect((await dpopVerify(await input({}, { iat: now - 29 }))).ok).toBe(true);
    expect((await dpopVerify(await input({}, { iat: now + 4 }))).ok).toBe(true);
  });
});

describe('verifyDpopProof — step 5, ath binds the proof to THIS token', () => {
  it('rejects a proof with no ath', async () => {
    expect((await dpopVerify(await input({}, { ath: null }))).reason).toBe('ath_mismatch');
  });

  it('rejects an ath computed over a different access token', async () => {
    expect(
      (await dpopVerify(await input({}, { ath: accessTokenHash('some.other.token') }))).reason,
    ).toBe('ath_mismatch');
  });

  it('rejects a proof replayed against a DIFFERENT access token for the same user', async () => {
    const base = await input();
    expect((await dpopVerify({ ...base, accessToken: 'a.different.token' })).reason).toBe(
      'ath_mismatch',
    );
  });
});

describe('verifyDpopProof — step 6, the nonce, and it precedes the jti check', () => {
  it('asks for a nonce when the proof carries none', async () => {
    expect(await dpopVerify(await input({}, { nonce: undefined }))).toEqual({
      ok: false,
      reason: 'nonce_missing',
      error: 'use_dpop_nonce',
    });
  });

  it('accepts a nonce from the PREVIOUS bucket of the same epoch', async () => {
    const previous = nonce.mint(Date.now() - PERIOD_MS);
    expect((await dpopVerify(await input({}, { nonce: previous }))).ok).toBe(true);
  });

  it('REJECTS a nonce from a previous process epoch — the restart property', async () => {
    const beforeRestart = createNonceEpoch({ periodMs: PERIOD_MS });
    const carried = beforeRestart.mint();
    const result = await dpopVerify(await input({}, { nonce: carried }));

    expect(result).toEqual({ ok: false, reason: 'nonce_invalid', error: 'use_dpop_nonce' });
    // ...and the replay cache was EMPTY, so it is not what did the rejecting.
    expect(jti.size).toBe(0);
  });

  it('rejects a nonce whose mac does not check out', async () => {
    expect((await dpopVerify(await input({}, { nonce: 'AAAA' }))).reason).toBe('nonce_invalid');
  });

  it('does not consume the jti when the nonce fails, so the retry may reuse it', async () => {
    const proof = await makeProof(key, {
      htm: 'POST',
      htu: HTU,
      accessToken: ACCESS_TOKEN,
      jti: 'fixed-jti',
      nonce: createNonceEpoch({ periodMs: PERIOD_MS }).mint(),
    });
    const base = await input();
    expect((await dpopVerify({ ...base, proof })).error).toBe('use_dpop_nonce');
    expect(jti.size).toBe(0);
    expect(jti.check('fixed-jti')).toBe('fresh');
  });

  it('skips the nonce entirely when a route does not require one', async () => {
    expect((await dpopVerify(await input({ requireNonce: false }, { nonce: undefined }))).ok).toBe(
      true,
    );
  });

  it('still validates a nonce that was volunteered on a route that does not require one', async () => {
    const foreign = createNonceEpoch({ periodMs: PERIOD_MS }).mint();
    expect(
      (await dpopVerify(await input({ requireNonce: false }, { nonce: foreign }))).reason,
    ).toBe('nonce_invalid');
  });
});

// ===========================================================================
// THE REPLAY HOLE (challenger B1). The iat check compares at SECOND
// granularity while the jti window prunes at MILLISECOND granularity, so a
// window sized to exactly (maxAge + skew) seconds evicts a jti while the proof
// it names is still iat-valid for up to another 999 ms.
//
// Adapted from the challenger's test/challenger-order.test.ts. Two changes:
// the ttl comes from resolveAuthConfig rather than being computed in the test,
// so this pins the CONFIG FORMULA and not just today's number; and the search
// reports the exploitable window rather than a bare boolean.
// ===========================================================================
describe('verifyDpopProof — the jti window must cover the WHOLE iat window', () => {
  it('never accepts the same proof twice, for any clock offset inside the iat window', async () => {
    const maxAgeSeconds = 30;
    const clockSkewSeconds = 5;
    const { jtiTtlMs } = resolveAuthConfig({
      OIDC_ISSUER: 'https://i.test.invalid/',
      OIDC_AUDIENCE: 'a',
      OIDC_JWKS_URI: 'https://i.test.invalid/jwks',
      COORDINATOR_PUBLIC_ORIGIN: TEST_ORIGIN,
      DPOP_PROOF_MAX_AGE_SECONDS: String(maxAgeSeconds),
      DPOP_CLOCK_SKEW_SECONDS: String(clockSkewSeconds),
    });

    // The worst case: a client whose clock runs the full accepted skew fast,
    // presenting at the very START of a second. Both halves are needed — the
    // hole is the gap between a floored second and a millisecond timer.
    const presentAtSecond = 1_800_000_000;
    let clock = presentAtSecond * 1000;
    const now = (): number => clock;
    const iat = presentAtSecond + clockSkewSeconds;

    const window = createJtiWindow({ ttlMs: jtiTtlMs, maxEntries: 1000, now });
    const epoch = createNonceEpoch({ periodMs: PERIOD_MS, now });
    const device = await makeDeviceKey();
    const proof = await makeProof(device, {
      htm: 'POST',
      htu: `${TEST_ORIGIN}${PATH}`,
      accessToken: ACCESS_TOKEN,
      iat,
      nonce: epoch.mint(),
    });
    const base: DpopVerifyInput = {
      proof,
      method: 'POST',
      path: PATH,
      origin: TEST_ORIGIN,
      accessToken: ACCESS_TOKEN,
      resolveBinding: async () => ({ bound: true, deviceId: DEVICE_ID }),
      nonce: epoch,
      jti: window,
      algorithms: ['ES256'],
      maxAgeSeconds,
      clockSkewSeconds,
      requireNonce: true,
      now,
    };

    expect((await verifyDpopProof(base)).ok).toBe(true);
    expect(window.size).toBe(1);

    // Walk the clock forward, millisecond by millisecond, over the band where
    // a hole can exist and find the FIRST moment the proof is accepted twice.
    // The jti check cannot stop rejecting before the entry is EVICTED, which
    // cannot happen before ttlMs, so the sweep starts a second short of that
    // and runs past the end of any iat window this config can produce.
    let firstReplayAt: number | undefined;
    for (let offset = jtiTtlMs - 1_000; offset <= jtiTtlMs + 5_000; offset += 1) {
      clock = presentAtSecond * 1000 + offset;
      if ((await verifyDpopProof(base)).ok) {
        firstReplayAt = offset;
        break;
      }
    }

    // The last moment the iat rule alone would still admit it, for the message.
    let lastIatValid = 0;
    for (let offset = 0; offset <= 50_000; offset += 1) {
      const second = Math.floor((presentAtSecond * 1000 + offset) / 1000);
      if (iat >= second - maxAgeSeconds && iat <= second + clockSkewSeconds) lastIatValid = offset;
    }

    expect({
      firstReplayAt,
      exploitableMs: firstReplayAt === undefined ? 0 : lastIatValid - firstReplayAt + 1,
    }).toEqual({ firstReplayAt: undefined, exploitableMs: 0 });
  });
});
