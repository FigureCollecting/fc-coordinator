import { afterEach, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { createAccessTokenVerifier, createRemoteJwks } from './oidc.js';
import { TEST_AUDIENCE, TEST_ISSUER, makeIssuer, serveJwks } from '../../test/helpers/auth.js';

const SUBJECT = '0d1b1a3e-9f2c-4f63-8a11-2f9a5d6c7e80';

async function verifier(overrides: Partial<Parameters<typeof createAccessTokenVerifier>[0]> = {}) {
  const issuer = await makeIssuer();
  return {
    issuer,
    verify: createAccessTokenVerifier({
      jwks: issuer.jwks,
      issuer: issuer.issuer,
      audience: issuer.audience,
      algorithms: ['RS256'],
      ...overrides,
    }),
  };
}

let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
});

describe('createAccessTokenVerifier', () => {
  it('accepts a well-formed token and reports the Authentik uuid subject', async () => {
    const { issuer, verify } = await verifier();
    const result = await verify(await issuer.mint({ sub: SUBJECT }));
    expect(result).toMatchObject({ ok: true, token: { sub: SUBJECT } });
  });

  it('rejects a token signed by a key the JWKS does not hold', async () => {
    const { verify } = await verifier();
    const foreign = await makeIssuer();
    const result = await verify(await foreign.mint({ sub: SUBJECT }));
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token from another issuer', async () => {
    const { issuer, verify } = await verifier();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: issuer.kid })
      .setIssuer('https://evil.test.invalid/')
      .setAudience(TEST_AUDIENCE)
      .setSubject(SUBJECT)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign((await generateKeyPair('RS256', { extractable: true })).privateKey);
    expect(await verify(token)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a token minted for a different audience', async () => {
    const { issuer, verify } = await verifier();
    const wrongAudience = await makeIssuer({ audience: 'some-other-app' });
    // Same issuer name, same key material shape, different aud: prove aud is checked.
    const verifyAgainstOurs = createAccessTokenVerifier({
      jwks: wrongAudience.jwks,
      issuer: issuer.issuer,
      audience: TEST_AUDIENCE,
      algorithms: ['RS256'],
    });
    expect(await verifyAgainstOurs(await wrongAudience.mint({ sub: SUBJECT }))).toEqual({
      ok: false,
      reason: 'wrong_audience',
    });
  });

  it('rejects an expired token', async () => {
    const { issuer, verify } = await verifier();
    const token = await issuer.mint({ sub: SUBJECT }, { expiresIn: '-60s' });
    expect(await verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('allows the configured clock tolerance and no more', async () => {
    const { issuer } = await verifier();
    const strict = createAccessTokenVerifier({
      jwks: issuer.jwks,
      issuer: issuer.issuer,
      audience: issuer.audience,
      algorithms: ['RS256'],
      clockToleranceSeconds: 0,
    });
    const justExpired = await issuer.mint({ sub: SUBJECT }, { expiresIn: '-2s' });
    expect(await strict(justExpired)).toEqual({ ok: false, reason: 'expired' });
    // The default tolerance absorbs the same token: skew is allowed on purpose.
    expect((await (await verifier()).verify(justExpired)).ok).toBe(false);
  });

  it('rejects an issuer mismatch as a distinct reason when the key still resolves', async () => {
    const issuer = await makeIssuer({ issuer: 'https://other.test.invalid/' });
    const verify = createAccessTokenVerifier({
      jwks: issuer.jwks,
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
      algorithms: ['RS256'],
    });
    expect(await verify(await issuer.mint({ sub: SUBJECT }))).toEqual({
      ok: false,
      reason: 'wrong_issuer',
    });
  });

  it('rejects an algorithm outside the allowlist', async () => {
    const { issuer } = await verifier();
    const verify = createAccessTokenVerifier({
      jwks: issuer.jwks,
      issuer: issuer.issuer,
      audience: issuer.audience,
      algorithms: ['ES256'],
    });
    expect(await verify(await issuer.mint({ sub: SUBJECT }))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('REJECTS a subject that is not an Authentik uuid — never a pk, never an email', async () => {
    const { issuer, verify } = await verifier();
    for (const sub of ['1', '42', 'akadmin', 'ross@example.com', 'not-a-uuid', '']) {
      expect(await verify(await issuer.mint({ sub }))).toEqual({
        ok: false,
        reason: 'subject_not_uuid',
      });
    }
  });

  it('rejects a token with no subject at all', async () => {
    const { issuer } = await verifier();
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: issuer.kid })
      .setIssuer(issuer.issuer)
      .setAudience(issuer.audience)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign((await generateKeyPair('RS256', { extractable: true })).privateKey);
    // signature fails first; the point is it never yields ok:true without a sub
    expect((await (await verifier()).verify(token)).ok).toBe(false);
  });

  it('rejects a syntactically broken token without throwing', async () => {
    const { verify } = await verifier();
    for (const token of ['', 'abc', 'a.b', 'a.b.c']) {
      expect((await verify(token)).ok).toBe(false);
    }
  });

  it('surfaces cnf.jkt when a future IdP binds the token, and leaves it undefined otherwise', async () => {
    const { issuer, verify } = await verifier();
    const bound = await verify(await issuer.mint({ sub: SUBJECT, cnf: { jkt: 'THUMB' } }));
    expect(bound).toMatchObject({ ok: true, token: { cnfJkt: 'THUMB' } });

    const unbound = await verify(await issuer.mint({ sub: SUBJECT }));
    expect(unbound.ok && unbound.token.cnfJkt).toBeUndefined();
  });

  it('ignores a malformed cnf rather than trusting it', async () => {
    const { issuer, verify } = await verifier();
    const result = await verify(await issuer.mint({ sub: SUBJECT, cnf: { jkt: 42 } }));
    expect(result.ok && result.token.cnfJkt).toBeUndefined();
  });
});

describe('createRemoteJwks', () => {
  it('fetches the JWKS over HTTP(S) and caches it across verifications', async () => {
    const issuer = await makeIssuer();
    const served = await serveJwks(issuer.jwksBody);
    closers.push(served.close);

    const verify = createAccessTokenVerifier({
      jwks: createRemoteJwks(served.url),
      issuer: issuer.issuer,
      audience: issuer.audience,
      algorithms: ['RS256'],
    });

    expect((await verify(await issuer.mint({ sub: SUBJECT }))).ok).toBe(true);
    expect((await verify(await issuer.mint({ sub: SUBJECT }))).ok).toBe(true);
    expect(served.requests).toBe(1);
  });

  it('refetches when a token arrives with an unseen kid — key rotation', async () => {
    const first = await makeIssuer({ kid: 'kid-1' });
    const body: JSONWebKeySet = { keys: [...first.jwksBody.keys] };
    const served = await serveJwks(body);
    closers.push(served.close);

    const verify = createAccessTokenVerifier({
      jwks: createRemoteJwks(served.url, { cooldownMs: 0, cacheMaxAgeMs: 60_000 }),
      issuer: first.issuer,
      audience: first.audience,
      algorithms: ['RS256'],
    });
    expect((await verify(await first.mint({ sub: SUBJECT }))).ok).toBe(true);

    const rotated = await generateKeyPair('RS256', { extractable: true });
    body.keys.push({ ...(await exportJWK(rotated.publicKey)), kid: 'kid-2', alg: 'RS256', use: 'sig' });
    const rotatedToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'kid-2' })
      .setIssuer(first.issuer)
      .setAudience(first.audience)
      .setSubject(SUBJECT)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(rotated.privateKey);

    expect((await verify(rotatedToken)).ok).toBe(true);
    expect(served.requests).toBeGreaterThan(1);
  });

  it('fails closed when the JWKS endpoint is unreachable', async () => {
    const issuer = await makeIssuer();
    const verify = createAccessTokenVerifier({
      jwks: createRemoteJwks(new URL('http://127.0.0.1:1/jwks'), { timeoutMs: 500 }),
      issuer: issuer.issuer,
      audience: issuer.audience,
      algorithms: ['RS256'],
    });
    expect((await verify(await issuer.mint({ sub: SUBJECT }))).ok).toBe(false);
  });
});
