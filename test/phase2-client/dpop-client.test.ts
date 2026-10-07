// The client's proof builder, checked by the coordinator's OWN verifier (src/auth/dpop.ts), not by
// a re-statement of RFC 9449: a proof is right when the server it is for accepts it.
import { createHash } from 'node:crypto';
import { calculateJwkThumbprint, decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import { verifyDpopProof } from '../../src/auth/dpop.js';
import { createNonceEpoch } from '../../src/auth/nonce.js';
import { createJtiWindow } from '../../src/auth/replay.js';
import {
  challengeError,
  generateClientKey,
  nonceParts,
  signProof,
} from '../../scripts/phase2-client/dpop.js';

const ORIGIN = 'https://api.test.invalid';
const PATH = '/api/auth/session';
const TOKEN = 'header.payload.signature-of-a-token';

async function verify(proof: string, opts: { requireNonce?: boolean; nonce?: ReturnType<typeof createNonceEpoch>; boundJkt?: string } = {}) {
  return verifyDpopProof({
    proof,
    method: 'GET',
    path: PATH,
    origin: ORIGIN,
    accessToken: TOKEN,
    resolveBinding: async (jkt) => (opts.boundJkt === undefined || jkt === opts.boundJkt ? { bound: true, deviceId: 'd-1' } : { bound: false }),
    nonce: opts.nonce ?? createNonceEpoch({ periodMs: 300_000 }),
    jti: createJtiWindow({ ttlMs: 36_000, maxEntries: 100 }),
    algorithms: ['ES256'],
    maxAgeSeconds: 30,
    clockSkewSeconds: 5,
    requireNonce: opts.requireNonce ?? true,
  });
}

describe('generateClientKey', () => {
  it('makes an ES256 key whose private half cannot be exported and whose public JWK has no private member', async () => {
    const key = await generateClientKey();
    expect(key.alg).toBe('ES256');
    expect(key.privateKey.extractable).toBe(false);
    expect(key.publicJwk).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(key.publicJwk).not.toHaveProperty('d');
    expect(key.jkt).toBe(await calculateJwkThumbprint(key.publicJwk, 'sha256'));
  });
});

describe('signProof', () => {
  it('produces a proof the coordinator accepts, bound to the key that signed it', async () => {
    const epoch = createNonceEpoch({ periodMs: 300_000 });
    const key = await generateClientKey();
    const proof = await signProof(key, { htm: 'GET', htu: `${ORIGIN}${PATH}`, accessToken: TOKEN, nonce: epoch.mint() });
    const outcome = await verify(proof.proof, { nonce: epoch, boundJkt: key.jkt });
    expect(outcome).toMatchObject({ ok: true, jkt: key.jkt, jti: proof.jti });
    expect(decodeProtectedHeader(proof.proof)).toMatchObject({ typ: 'dpop+jwt', alg: 'ES256' });
  });

  it("commits to the token with ath = base64url(sha256(token))", async () => {
    const key = await generateClientKey();
    const proof = await signProof(key, { htm: 'GET', htu: `${ORIGIN}${PATH}`, accessToken: TOKEN });
    expect(decodeJwt(proof.proof)['ath']).toBe(createHash('sha256').update(TOKEN, 'ascii').digest('base64url'));
  });

  it('omits the nonce when given none, which a nonce-requiring coordinator refuses as nonce_missing', async () => {
    const key = await generateClientKey();
    const proof = await signProof(key, { htm: 'GET', htu: `${ORIGIN}${PATH}`, accessToken: TOKEN });
    expect(decodeJwt(proof.proof)).not.toHaveProperty('nonce');
    expect(await verify(proof.proof)).toMatchObject({ ok: false, reason: 'nonce_missing' });
  });

  it('uses the jti it is given, and a fresh one otherwise', async () => {
    const key = await generateClientKey();
    const a = await signProof(key, { htm: 'GET', htu: `${ORIGIN}${PATH}`, accessToken: TOKEN, jti: 'chosen-jti' });
    const b = await signProof(key, { htm: 'GET', htu: `${ORIGIN}${PATH}`, accessToken: TOKEN });
    const c = await signProof(key, { htm: 'GET', htu: `${ORIGIN}${PATH}`, accessToken: TOKEN });
    expect(a.jti).toBe('chosen-jti');
    expect(decodeJwt(a.proof)['jti']).toBe('chosen-jti');
    expect(b.jti).not.toBe(c.jti);
  });

  it('signs the htu it is told to, so a www-named proof fails htu_mismatch at the coordinator', async () => {
    const key = await generateClientKey();
    const proof = await signProof(key, { htm: 'GET', htu: `https://www.api.test.invalid${PATH}`, accessToken: TOKEN });
    expect(await verify(proof.proof, { requireNonce: false })).toMatchObject({ ok: false, reason: 'htu_mismatch' });
  });
});

describe('nonceParts', () => {
  it("reads the epoch and bucket the coordinator's nonce carries", () => {
    const now = 1_790_000_000_000;
    const epoch = createNonceEpoch({ periodMs: 300_000, now: () => now });
    expect(nonceParts(epoch.mint())).toEqual({ epoch: epoch.epochId, bucket: BigInt(Math.floor(now / 300_000)) });
    expect(nonceParts(epoch.mint(now + 300_000))!.bucket).toBe(BigInt(Math.floor(now / 300_000)) + 1n);
  });

  it('refuses anything that is not a canonical 40-byte nonce', () => {
    expect(nonceParts('')).toBeUndefined();
    expect(nonceParts(Buffer.alloc(39).toString('base64url'))).toBeUndefined();
    expect(nonceParts(`${Buffer.alloc(40).toString('base64url')}!`)).toBeUndefined();
  });
});

describe('challengeError', () => {
  it('reads the error code out of a DPoP challenge, and nothing else', () => {
    expect(challengeError('DPoP error="use_dpop_nonce", error_description="x", algs="ES256"')).toBe('use_dpop_nonce');
    expect(challengeError('DPoP error="invalid_dpop_proof", error_description="x"')).toBe('invalid_dpop_proof');
    expect(challengeError(null)).toBeUndefined();
    expect(challengeError('Bearer realm="x"')).toBeUndefined();
  });
});
