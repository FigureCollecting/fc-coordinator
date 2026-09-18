/**
 * THE IdP MESH PATH, END TO END, OVER A REAL SOCKET.
 *
 * Both OIDC hops move onto the multicluster mirror in R7, and both of them fail
 * the same way if the client does not present the PUBLIC authority: Authentik
 * builds `iss` out of the request it received, so a token minted through the
 * mirror names the mirror, OpenFGA's issuer pin refuses it, and every read
 * comes back redacted with nothing in the log to say why.
 *
 * WHAT IS PROVEN HERE THAT test/entitlements/idp-path.test.ts CANNOT PROVE. That
 * file is about the RULE: which URL gets which headers. This one is about the
 * WIRE — that the headers the rule produced actually arrive, through two
 * different HTTP clients that had to be handled differently:
 *
 *   the token mint  axios, which passes a `Host` header straight through to
 *                   node:http
 *   the JWKS fetch  jose, which fetches through undici — and undici DROPS a
 *                   `Host` header silently, because it is a forbidden header
 *                   name in the Fetch standard. Measured, not assumed; see
 *                   src/auth/oidc.ts for the custom fetch that resolves it.
 *
 * WHY THE FIXTURE IS ON LOOPBACK AND NOT ON A `.svc.cluster.local` NAME. It
 * resolves nowhere on a workstation or in CI, and the one way to dial it anyway
 * would be to inject a DNS `lookup` into production code for the benefit of a
 * test. The rule therefore sends the SAME headers on a loopback URL when
 * IDP_PUBLIC_HOST is set — which is also correct on its own terms, since a
 * local issuer derives `iss` from the request exactly as Authentik does — and
 * idp-path.test.ts pins that the two header sets are identical. So the
 * classification is proven there and the transport is proven here, with the
 * join asserted rather than assumed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import { createAccessTokenVerifier, createJwksFor } from '../src/auth/oidc.js';
import { resolveAuthConfig } from '../src/auth/config.js';
import {
  getOpenFgaToken,
  resetOpenFgaTokenForTest,
} from '../src/entitlements/openfgaToken.js';
import { issuerFor, startFakeAuthentik, type FakeAuthentik } from './helpers/fakeAuthentik.js';

const PUBLIC_HOST = 'auth.mindsignals1.com';
/**
 * The issuer of the token this unit moves: the OPENFGA service account's, from
 * the `openfga` provider. NOT `/application/o/fc-coordinator/`, which is the
 * USER-token provider whose key set `OIDC_JWKS_URI` names. Both live on the
 * same Authentik and both reach it through the same mirror; only one of them
 * is the credential the mint returns. fc-infra pins this in three merged files.
 */
const PUBLIC_ISSUER = `https://${PUBLIC_HOST}/application/o/openfga/`;
const T0 = 1_780_000_000_000;

let idp: FakeAuthentik;

beforeEach(async () => {
  idp = await startFakeAuthentik();
  resetOpenFgaTokenForTest();
});

afterEach(async () => {
  resetOpenFgaTokenForTest();
  await idp.close();
});

/** The credential env, with the endpoint pointed at the fixture. */
const tokenEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OPENFGA_OIDC_TOKEN_ENDPOINT: idp.tokenEndpoint,
    OPENFGA_OIDC_CLIENT_ID: 'openfga',
    OPENFGA_OIDC_USERNAME: 'svc-openfga-fc-coordinator',
    OPENFGA_OIDC_PASSWORD: 'app-password-never-print-me',
    ...over,
  }) as NodeJS.ProcessEnv;

describe('the token mint through the mirror', () => {
  it('presents the PUBLIC Host and X-Forwarded-Proto, so `iss` is the public issuer', async () => {
    const token = await getOpenFgaToken(tokenEnv({ IDP_PUBLIC_HOST: PUBLIC_HOST }), T0);
    expect(token).not.toBeNull();

    const call = idp.tokenCalls[0];
    expect(call?.host).toBe(PUBLIC_HOST);
    expect(call?.forwardedProto).toBe('https');

    // The claim the whole unit exists for, read off the token the fixture
    // actually signed rather than off what we asked it to sign.
    expect(decodeJwt(token as string).iss).toBe(PUBLIC_ISSUER);
  });

  it('WITHOUT the public host, the same fixture mints an issuer naming the dial address', async () => {
    // The negative control, and it is the failure R7 would have shipped: the
    // fake is unchanged, only the configuration is, and the token is one
    // OpenFGA refuses. Without this case the assertion above could be passing
    // on a fixture that pins the issuer regardless.
    const token = await getOpenFgaToken(tokenEnv(), T0);
    expect(token).not.toBeNull();

    const call = idp.tokenCalls[0];
    expect(call?.host).toBe(new URL(idp.tokenEndpoint).host);
    expect(call?.forwardedProto).toBeUndefined();
    expect(decodeJwt(token as string).iss).toBe(issuerFor(call?.host, undefined));
    expect(decodeJwt(token as string).iss).not.toBe(PUBLIC_ISSUER);
  });

  it('still sends the credential in the form body, unchanged by the new headers', async () => {
    await getOpenFgaToken(tokenEnv({ IDP_PUBLIC_HOST: PUBLIC_HOST }), T0);
    expect(idp.tokenCalls).toHaveLength(1);
    expect(idp.issued).toHaveLength(1);
  });
});

describe('the JWKS fetch through the mirror', () => {
  it('presents the PUBLIC Host, which undici alone cannot do', async () => {
    const config = resolveAuthConfig({
      OIDC_ISSUER: PUBLIC_ISSUER,
      OIDC_AUDIENCE: 'fc-coordinator',
      OIDC_JWKS_URI: idp.jwksUri,
      COORDINATOR_PUBLIC_ORIGIN: 'https://api.figurecollecting.com',
      IDP_PUBLIC_HOST: PUBLIC_HOST,
    });

    // A real jose resolver against a real socket. The kid will not match any
    // key it is asked for; the fetch is the thing under test.
    // THE WIRING PRODUCTION USES, not a hand-typed copy of it: src/server.ts
    // calls this exact function, so deleting the headers inside it fails here.
    const jwks = createJwksFor(config.jwksPath);
    await jwks({ alg: 'RS256', kid: 'authentik-kid-1' }).catch(() => undefined);

    expect(idp.jwksCalls).toHaveLength(1);
    expect(idp.jwksCalls[0]?.host).toBe(PUBLIC_HOST);
    expect(idp.jwksCalls[0]?.forwardedProto).toBe('https');
  });

  it('still verifies a token minted through the same mirror, end to end', async () => {
    // Mint through the mirror, then verify against a JWKS fetched through the
    // mirror, pinning the PUBLIC issuer. This is the pair that has to agree in
    // production, and neither half is mocked.
    const token = await getOpenFgaToken(tokenEnv({ IDP_PUBLIC_HOST: PUBLIC_HOST }), T0);
    const config = resolveAuthConfig({
      OIDC_ISSUER: PUBLIC_ISSUER,
      OIDC_AUDIENCE: 'openfga',
      OIDC_JWKS_URI: idp.jwksUri,
      COORDINATOR_PUBLIC_ORIGIN: 'https://api.figurecollecting.com',
      IDP_PUBLIC_HOST: PUBLIC_HOST,
    });
    const verify = createAccessTokenVerifier({
      jwks: createJwksFor(config.jwksPath),
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ['RS256'],
    });

    expect((await verify(token as string)).ok).toBe(true);
  });

  it('names the USER provider, whose key set this is — not the one that minted the token', async () => {
    // The two are different providers on one Authentik and the difference is
    // load-bearing for the acceptance step an operator runs: the mint returns
    // `/application/o/openfga/` and the key set lives at
    // `/application/o/fc-coordinator/jwks/`. Comparing one against the other
    // reads a working mesh path as a failure.
    expect(idp.jwksUri).toContain('/application/o/fc-coordinator/jwks/');
    expect(PUBLIC_ISSUER).toContain('/application/o/openfga/');
  });

  it('the public https path fetches with no injected headers at all', async () => {
    const config = resolveAuthConfig({
      OIDC_ISSUER: PUBLIC_ISSUER,
      OIDC_AUDIENCE: 'fc-coordinator',
      OIDC_JWKS_URI: idp.jwksUri.replace('http://127.0.0.1', 'https://auth.mindsignals1.com'),
      COORDINATOR_PUBLIC_ORIGIN: 'https://api.figurecollecting.com',
    });
    expect(config.jwksPath.headers).toEqual({});
    expect(config.jwksPath.kind).toBe('public');
  });
});
