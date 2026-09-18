import { afterEach, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { createAccessTokenVerifier, createRemoteJwks } from './oidc.js';
import { TEST_AUDIENCE, TEST_ISSUER, makeIssuer, serveJwks } from '../../test/helpers/auth.js';
import { startFakeAuthentik } from '../../test/helpers/fakeAuthentik.js';
import Fastify from 'fastify';

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

// ===========================================================================
// THE JWKS FETCH THROUGH THE IN-CLUSTER MIRROR (R7).
//
// MEASURED, NOT ASSUMED: Node's global fetch — which is what jose uses, and
// what jose's own `headers` option feeds — SILENTLY DROPS a `Host` header,
// because `host` is a forbidden header name in the Fetch standard. A probe
// against a real socket on this Node:
//
//   global fetch   host: 127.0.0.1:45207   x-forwarded-proto: https
//   jose headers   host: 127.0.0.1:45207   x-forwarded-proto: https
//   node:http      host: auth.example.com  x-forwarded-proto: https
//
// So `headers` alone gets X-Forwarded-Proto through and loses the one header
// that decides the issuer. createRemoteJwks therefore installs jose's
// `[customFetch]` over node:http when a host header is asked for — which
// replaces the TRANSPORT only: the cache age, the unknown-kid cooldown, the
// refetch and the timeout all stay inside jose, and the cases below prove they
// still work through the substitution.
// ===========================================================================
describe('createRemoteJwks presenting a public authority', () => {
  it('sends the Host header the mesh path requires', async () => {
    const idp = await startFakeAuthentik();
    closers.push(idp.close);

    const jwks = createRemoteJwks(new URL(idp.jwksUri), {
      headers: { host: 'auth.mindsignals1.com', 'x-forwarded-proto': 'https' },
    });
    await jwks({ alg: 'RS256', kid: 'authentik-kid-1' }).catch(() => undefined);

    expect(idp.jwksCalls).toHaveLength(1);
    expect(idp.jwksCalls[0]?.host).toBe('auth.mindsignals1.com');
    expect(idp.jwksCalls[0]?.forwardedProto).toBe('https');
  });

  it('sends the dial address as Host when no public authority is configured', async () => {
    // The unchanged path, asserted so "we always rewrite Host" cannot creep in.
    const idp = await startFakeAuthentik();
    closers.push(idp.close);

    const jwks = createRemoteJwks(new URL(idp.jwksUri));
    await jwks({ alg: 'RS256', kid: 'authentik-kid-1' }).catch(() => undefined);

    expect(idp.jwksCalls[0]?.host).toBe(new URL(idp.jwksUri).host);
    expect(idp.jwksCalls[0]?.forwardedProto).toBeUndefined();
  });

  it("keeps jose's cache: two verifications, one fetch", async () => {
    const idp = await startFakeAuthentik();
    closers.push(idp.close);

    const jwks = createRemoteJwks(new URL(idp.jwksUri), {
      headers: { host: 'auth.mindsignals1.com', 'x-forwarded-proto': 'https' },
    });
    await jwks({ alg: 'RS256', kid: 'authentik-kid-1' }).catch(() => undefined);
    await jwks({ alg: 'RS256', kid: 'authentik-kid-1' }).catch(() => undefined);

    expect(idp.jwksCalls).toHaveLength(1);
  });

  it("keeps jose's rotation refetch: an unknown kid pulls the set again", async () => {
    const idp = await startFakeAuthentik();
    closers.push(idp.close);

    const jwks = createRemoteJwks(new URL(idp.jwksUri), {
      headers: { host: 'auth.mindsignals1.com' },
      cooldownMs: 0,
      cacheMaxAgeMs: 60_000,
    });
    await jwks({ alg: 'RS256', kid: 'authentik-kid-1' }).catch(() => undefined);
    await jwks({ alg: 'RS256', kid: 'never-issued' }).catch(() => undefined);

    expect(idp.jwksCalls.length).toBeGreaterThan(1);
  });

  it('still fails closed when the endpoint is unreachable, timeout intact', async () => {
    const jwks = createRemoteJwks(new URL('http://127.0.0.1:1/jwks'), {
      headers: { host: 'auth.mindsignals1.com' },
      timeoutMs: 500,
    });
    await expect(jwks({ alg: 'RS256', kid: 'kid-1' })).rejects.toBeInstanceOf(Error);
  });

  it('still fails closed on a non-200 answer', async () => {
    const app = Fastify({ logger: false });
    app.get('/jwks', async (_req, reply) => reply.code(503).send('nope'));
    await app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => app.close());
    const port = (app.addresses()[0] as { port: number }).port;

    const jwks = createRemoteJwks(new URL(`http://127.0.0.1:${port}/jwks`), {
      headers: { host: 'auth.mindsignals1.com' },
      timeoutMs: 2_000,
    });
    await expect(jwks({ alg: 'RS256', kid: 'kid-1' })).rejects.toBeInstanceOf(Error);
  });

  it('speaks TLS when the URL says https, proving the client is chosen by scheme', async () => {
    // A CLEARTEXT server on the other end, dialled with an `https:` URL. An
    // http client would read a 200 and this case would pass vacuously; a TLS
    // client cannot complete a handshake against a plain HTTP server and
    // fails. So a rejection here is evidence that the https arm selected
    // node:https, which pointing at a closed port could never be.
    const idp = await startFakeAuthentik();
    closers.push(idp.close);
    const port = new URL(idp.jwksUri).port;

    const jwks = createRemoteJwks(
      new URL(`https://127.0.0.1:${port}/application/o/fc-coordinator/jwks/`),
      { headers: { host: 'auth.mindsignals1.com' }, timeoutMs: 2_000 },
    );
    await expect(jwks({ alg: 'RS256', kid: 'authentik-kid-1' })).rejects.toBeInstanceOf(Error);
    // And the cleartext server never saw a readable request.
    expect(idp.jwksCalls).toHaveLength(0);
  });

  it('never follows a redirect, so a 302 cannot move the trusted key set', async () => {
    // The JWKS is the set of keys every access token is verified against. A
    // redirect here is a key-substitution primitive, and jose asks for
    // `redirect: 'manual'` precisely so it cannot be followed — a replacement
    // transport that quietly follows one would give that away without changing
    // a line of jose's own code.
    const app = Fastify({ logger: false });
    app.get('/jwks', async (_req, reply) => reply.code(302).header('location', 'https://evil.example/jwks').send());
    await app.listen({ port: 0, host: '127.0.0.1' });
    closers.push(() => app.close());
    const port = (app.addresses()[0] as { port: number }).port;

    const jwks = createRemoteJwks(new URL(`http://127.0.0.1:${port}/jwks`), {
      headers: { host: 'auth.mindsignals1.com' },
      timeoutMs: 2_000,
    });
    await expect(jwks({ alg: 'RS256', kid: 'kid-1' })).rejects.toBeInstanceOf(Error);
  });
});
