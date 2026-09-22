/**
 * THE IdP MESH PATH, END TO END, OVER A REAL SOCKET.
 *
 * Both OIDC hops move onto the multicluster mirror in R7, and both of them fail
 * the same way if the client does not present the PUBLIC authority: Authentik
 * builds `iss` out of the request it received, so a token minted through the
 * mirror names the mirror, OpenFGA's issuer pin refuses it, and every read
 * comes back redacted with nothing in the log to say why. The gateway rewrites
 * `Host`, so the authority has to arrive in `X-Forwarded-Host`; the fixture
 * applies the same rewrite.
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
import * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { decodeJwt } from 'jose';
import { createAccessTokenVerifier, createJwksFor } from '../src/auth/oidc.js';
import { resolveAuthConfig } from '../src/auth/config.js';
import {
  getOpenFgaToken,
  resetOpenFgaTokenForTest,
} from '../src/entitlements/openfgaToken.js';
import {
  GATEWAY_TARGET_AUTHORITY,
  issuerFor,
  startFakeAuthentik,
  type FakeAuthentik,
} from './helpers/fakeAuthentik.js';

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
  vi.restoreAllMocks();
  resetOpenFgaTokenForTest();
  await idp.close();
});

/** What the mesh path must put on the wire, on both hops, and nothing else of its kind. */
const MESH_HEADERS = {
  host: PUBLIC_HOST,
  'x-forwarded-host': PUBLIC_HOST,
  'x-forwarded-proto': 'https',
};

const authEnv = (jwksUri: string, over: Record<string, string> = {}): Record<string, string> => ({
  OIDC_ISSUER: PUBLIC_ISSUER,
  OIDC_AUDIENCE: 'fc-coordinator',
  OIDC_JWKS_URI: jwksUri,
  COORDINATOR_PUBLIC_ORIGIN: 'https://api.figurecollecting.com',
  ...over,
});

/** A raw mint with exactly these headers, bypassing both production clients. */
const rawMintIssuer = (headers: Record<string, string>): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    const req = http.request(idp.tokenEndpoint, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { access_token: string };
        resolve(decodeJwt(body.access_token).iss);
      });
    });
    req.on('error', reject);
    req.end();
  });

describe('the fixture reproduces the gateway measured on prod', () => {
  it('ignores the Host the client sent and honours X-Forwarded-Host', async () => {
    // acceptance-u6.sh case d, 2026-09-22: Host + X-Forwarded-Proto minted the
    // in-cluster issuer; adding X-Forwarded-Host minted the public one.
    expect(await rawMintIssuer({ host: PUBLIC_HOST, 'x-forwarded-proto': 'https' })).toBe(
      `https://${GATEWAY_TARGET_AUTHORITY}/application/o/openfga/`,
    );
    expect(await rawMintIssuer(MESH_HEADERS)).toBe(PUBLIC_ISSUER);
    expect(issuerFor({ forwardedHost: PUBLIC_HOST, forwardedProto: 'https' })).toBe(PUBLIC_ISSUER);
  });
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
  it('presents the public authority in X-Forwarded-Host, so `iss` is the public issuer', async () => {
    const token = await getOpenFgaToken(tokenEnv({ IDP_PUBLIC_HOST: PUBLIC_HOST }), T0);
    expect(token).not.toBeNull();

    const call = idp.tokenCalls[0];
    expect(call?.host).toBe(PUBLIC_HOST);
    expect(call?.forwardedHost).toBe(PUBLIC_HOST);
    expect(call?.forwardedProto).toBe('https');

    // The claim the whole unit exists for, read off the token the fixture
    // actually signed rather than off what we asked it to sign.
    expect(decodeJwt(token as string).iss).toBe(PUBLIC_ISSUER);
  });

  it('WITHOUT the public host, the same fixture mints an issuer naming the in-cluster Service', async () => {
    // The negative control: the fake is unchanged, only the configuration is,
    // and the token is one OpenFGA refuses. Without this case the assertion
    // above could be passing on a fixture that pins the issuer regardless.
    const token = await getOpenFgaToken(tokenEnv(), T0);
    expect(token).not.toBeNull();

    const call = idp.tokenCalls[0];
    expect(call?.host).toBe(new URL(idp.tokenEndpoint).host);
    expect(call?.forwardedHost).toBeUndefined();
    expect(call?.forwardedProto).toBeUndefined();
    expect(decodeJwt(token as string).iss).toBe(`http://${GATEWAY_TARGET_AUTHORITY}/application/o/openfga/`);
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

describe('the header set on each hop', () => {
  it('is exactly Host, X-Forwarded-Host and X-Forwarded-Proto on the mint AND the JWKS fetch', async () => {
    // Both hops through the wiring production uses, read off the wire.
    await getOpenFgaToken(tokenEnv({ IDP_PUBLIC_HOST: PUBLIC_HOST }), T0);
    const config = resolveAuthConfig(authEnv(idp.jwksUri, { IDP_PUBLIC_HOST: PUBLIC_HOST }));
    await createJwksFor(config.jwksPath)({ alg: 'RS256', kid: 'authentik-kid-1' }).catch(() => undefined);

    expect(idp.tokenCalls).toHaveLength(1);
    expect(idp.jwksCalls).toHaveLength(1);
    expect(idp.tokenCalls[0]?.proxyHeaders).toEqual(MESH_HEADERS);
    expect(idp.jwksCalls[0]?.proxyHeaders).toEqual(MESH_HEADERS);
  });
});

describe('the public https path', () => {
  it('sends neither a Host override nor X-Forwarded-Host on either hop, even with IDP_PUBLIC_HOST set', async () => {
    // Observed at each client's boundary: the fixture is cleartext and this
    // path is TLS. IDP_PUBLIC_HOST is set to prove it is inert here.
    const post = vi
      .spyOn(axios, 'post')
      .mockResolvedValue({ data: { access_token: 'public-path-token', expires_in: 600 } });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(Response.json({ keys: [] }));
    const tokenUrl = `https://${PUBLIC_HOST}/application/o/token/`;
    const jwksUrl = `https://${PUBLIC_HOST}/application/o/fc-coordinator/jwks/`;

    await getOpenFgaToken(
      tokenEnv({ OPENFGA_OIDC_TOKEN_ENDPOINT: tokenUrl, IDP_PUBLIC_HOST: PUBLIC_HOST }),
      T0,
    );
    const config = resolveAuthConfig(authEnv(jwksUrl, { IDP_PUBLIC_HOST: PUBLIC_HOST }));
    await createJwksFor(config.jwksPath)({ alg: 'RS256', kid: 'authentik-kid-1' }).catch(() => undefined);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(tokenUrl);
    expect(post.mock.calls[0]?.[2]?.headers).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(jwksUrl);
    const sent = new Headers(fetchSpy.mock.calls[0]?.[1]?.headers);
    expect(sent.has('host')).toBe(false);
    expect(sent.has('x-forwarded-host')).toBe(false);
    expect(sent.has('x-forwarded-proto')).toBe(false);
    expect(idp.calls).toHaveLength(0);
  });
});
