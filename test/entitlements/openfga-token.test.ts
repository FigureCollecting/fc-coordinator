/**
 * THE OPENFGA CREDENTIAL, which stopped being a constant.
 *
 * The Check used to send `env.OPENFGA_API_TOKEN` as a bearer. D5b moved OpenFGA
 * to `authn.method: oidc` against an Authentik provider whose blueprint pins
 * `access_token_validity: minutes=10`, so a static value is correct for ten
 * minutes and then denies forever — silently, because a 401 is caught, counted
 * as an error and turned into a deny. Every read would come back redacted with
 * nothing in the log but a recurring "Check failed".
 *
 * So the credential is now MINTED, and the properties that matter are the ones
 * a ten-minute lifetime creates:
 *
 *   REFRESH AHEAD OF EXPIRY   a request must never race the expiry.
 *   SINGLE FLIGHT             a cold start under load mints once, not once per
 *                             concurrent read. The identity provider is a
 *                             cross-cluster hop and a stampede is a real one.
 *   FAIL CLOSED               a mint failure denies. It must NEVER fall through
 *                             to an unauthenticated Check: OpenFGA would answer
 *                             401 and the outcome would be identical, but the
 *                             log would name the wrong cause.
 *   NOTHING LEAKS             not the password, not the token, not an axios
 *                             error object (which carries the request config,
 *                             headers included).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeOpenFgaAuth,
  getOpenFgaToken,
  initOpenFgaAuth,
  invalidateOpenFgaToken,
  openFgaAuthHeaders,
  openFgaAuthMode,
  openFgaTokenCounters,
  resetOpenFgaTokenForTest,
} from '../../src/entitlements/openfgaToken.js';
import { startFakeTokenEndpoint, type FakeTokenEndpoint } from '../helpers/fakeTokenEndpoint.js';

const T0 = 1_780_000_000_000;
const PASSWORD = 'p@ss word&with=specials+and/slashes';
const USERNAME = 'svc-openfga-fc-coordinator';

let idp: FakeTokenEndpoint;
let errors: unknown[][];
let warns: unknown[][];
let logs: unknown[][];

const oidcEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OPENFGA_OIDC_TOKEN_ENDPOINT: idp.url,
    OPENFGA_OIDC_CLIENT_ID: 'openfga',
    OPENFGA_OIDC_USERNAME: USERNAME,
    OPENFGA_OIDC_PASSWORD: PASSWORD,
    ...over,
  }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  idp = await startFakeTokenEndpoint();
  resetOpenFgaTokenForTest();
  errors = [];
  warns = [];
  logs = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args);
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args);
  });
});

afterEach(async () => {
  await idp.close();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

// ===========================================================================
// WHICH CREDENTIAL IS IN USE
// ===========================================================================
describe('the auth mode', () => {
  it('is oidc when the provider is configured', () => {
    expect(openFgaAuthMode(oidcEnv())).toBe('oidc');
  });

  it('is static when only a preshared token is set — the local and break-glass path', () => {
    expect(openFgaAuthMode({ OPENFGA_API_TOKEN: 'shh' } as NodeJS.ProcessEnv)).toBe('static');
  });

  it('is none when neither is set', () => {
    expect(openFgaAuthMode({} as NodeJS.ProcessEnv)).toBe('none');
  });

  it('prefers oidc over a stray static token, and says so ONCE', async () => {
    const env = oidcEnv({ OPENFGA_API_TOKEN: 'stale-preshared-value' });
    expect(openFgaAuthMode(env)).toBe('oidc');

    const first = await openFgaAuthHeaders(env, T0);
    const second = await openFgaAuthHeaders(env, T0);
    expect(first).toEqual({ authorization: 'Bearer token-1' });
    expect(second).toEqual({ authorization: 'Bearer token-1' });

    const shadowed = warns.filter((w) => JSON.stringify(w).includes('OPENFGA_API_TOKEN'));
    expect(shadowed).toHaveLength(1);
    expect(JSON.stringify(shadowed)).not.toContain('stale-preshared-value');
  });

  it('stays oidc when the provider is only PARTLY configured, and fails closed there', async () => {
    // The dangerous alternative is falling back to `none`, which sends an
    // unauthenticated Check: OpenFGA answers 401, the read redacts, and the
    // operator chases a revoked grant instead of a missing Secret key.
    const env = oidcEnv({ OPENFGA_OIDC_PASSWORD: undefined });
    expect(openFgaAuthMode(env)).toBe('oidc');

    expect(await openFgaAuthHeaders(env, T0)).toBeUndefined();
    expect(idp.calls).toHaveLength(0);
    expect(JSON.stringify(errors)).toContain('OPENFGA_OIDC_PASSWORD');
  });

  it('describes the active path without naming a secret', () => {
    const described = describeOpenFgaAuth(oidcEnv());
    expect(described).toContain('oidc');
    expect(described).toContain('openfga');
    expect(described).not.toContain(PASSWORD);
    expect(described).not.toContain(USERNAME);
  });
});

// ===========================================================================
// MINTING
// ===========================================================================
describe('minting a token', () => {
  it('posts a form-encoded client_credentials grant', async () => {
    const token = await getOpenFgaToken(oidcEnv(), T0);

    expect(token).toBe('token-1');
    expect(idp.calls).toHaveLength(1);
    const call = idp.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.contentType).toContain('application/x-www-form-urlencoded');
    expect(call.form).toMatchObject({
      grant_type: 'client_credentials',
      client_id: 'openfga',
      username: USERNAME,
      scope: 'openid',
    });
  });

  it('url-encodes the password, so one with & or = or + survives the wire', async () => {
    await getOpenFgaToken(oidcEnv(), T0);
    // The decoded value is the one that matters; the raw body proves it was
    // actually escaped rather than sent literally and split by the parser.
    expect(idp.calls[0]!.form['password']).toBe(PASSWORD);
    expect(idp.calls[0]!.raw).not.toContain('with=specials');
  });

  it('sends a client_secret only when one is configured', async () => {
    await getOpenFgaToken(oidcEnv(), T0);
    expect(idp.calls[0]!.form['client_secret']).toBeUndefined();

    resetOpenFgaTokenForTest();
    await getOpenFgaToken(oidcEnv({ OPENFGA_OIDC_CLIENT_SECRET: 'confidential' }), T0);
    expect(idp.calls[1]!.form['client_secret']).toBe('confidential');
  });

  it('takes a configured scope over the default', async () => {
    await getOpenFgaToken(oidcEnv({ OPENFGA_OIDC_SCOPE: 'openid profile' }), T0);
    expect(idp.calls[0]!.form['scope']).toBe('openid profile');
  });
});

// ===========================================================================
// CACHING AND REFRESH
// ===========================================================================
describe('the cached token', () => {
  it('is reused inside its lifetime — one mint, many checks', async () => {
    const env = oidcEnv();
    expect(await getOpenFgaToken(env, T0)).toBe('token-1');
    expect(await getOpenFgaToken(env, T0 + 60_000)).toBe('token-1');
    expect(await getOpenFgaToken(env, T0 + 479_000)).toBe('token-1');
    expect(idp.calls).toHaveLength(1);
    expect(openFgaTokenCounters()['token_cache_hit']).toBe(2);
  });

  it('is re-minted AHEAD of expiry, never at it', async () => {
    // 600 s lifetime, 120 s skew -> refresh at 480 s, two minutes of headroom.
    const env = oidcEnv();
    await getOpenFgaToken(env, T0);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    expect(await getOpenFgaToken(env, T0 + 480_000)).toBe('token-2');
    expect(idp.calls).toHaveLength(2);
  });

  it('honours a configured refresh skew', async () => {
    const env = oidcEnv({ OPENFGA_OIDC_REFRESH_SKEW_SECONDS: '300' });
    await getOpenFgaToken(env, T0);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    expect(await getOpenFgaToken(env, T0 + 299_000)).toBe('token-1');
    expect(await getOpenFgaToken(env, T0 + 300_000)).toBe('token-2');
  });

  it('never schedules a refresh in the past when the skew exceeds the lifetime', async () => {
    // A 60 s token with the default 120 s skew would refresh 60 s ago, which
    // means re-minting on EVERY call — a stampede dressed as a safety margin.
    // The floor is half the lifetime.
    const env = oidcEnv();
    idp.reply({ body: { access_token: 'short', expires_in: 60 } });
    await getOpenFgaToken(env, T0);

    expect(await getOpenFgaToken(env, T0 + 29_000)).toBe('short');
    expect(idp.calls).toHaveLength(1);
    expect(await getOpenFgaToken(env, T0 + 30_000)).toBe('short');
    expect(idp.calls).toHaveLength(2);
  });

  it('treats a missing or nonsensical expires_in as a SHORT lifetime, not an eternal one', async () => {
    const env = oidcEnv();
    idp.reply({ body: { access_token: 'no-expiry' } });
    await getOpenFgaToken(env, T0);

    // 60 s assumed, halved by the floor -> re-mint at 30 s rather than never.
    expect(await getOpenFgaToken(env, T0 + 29_000)).toBe('no-expiry');
    expect(idp.calls).toHaveLength(1);
    await getOpenFgaToken(env, T0 + 31_000);
    expect(idp.calls).toHaveLength(2);
  });

  it('is dropped on demand, which is how a 401 forces a re-mint', async () => {
    const env = oidcEnv();
    await getOpenFgaToken(env, T0);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    invalidateOpenFgaToken();
    expect(await getOpenFgaToken(env, T0 + 1)).toBe('token-2');
  });

  it('forceRefresh on the header helper drops the cache first', async () => {
    const env = oidcEnv();
    expect(await openFgaAuthHeaders(env, T0)).toEqual({ authorization: 'Bearer token-1' });
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    expect(await openFgaAuthHeaders(env, T0 + 1, { forceRefresh: true })).toEqual({
      authorization: 'Bearer token-2',
    });
  });
});

// ===========================================================================
// SINGLE FLIGHT
// ===========================================================================
describe('a cold cache under load', () => {
  it('mints ONCE for fifty concurrent callers', async () => {
    const env = oidcEnv();
    const results = await Promise.all(Array.from({ length: 50 }, () => getOpenFgaToken(env, T0)));

    expect(new Set(results)).toEqual(new Set(['token-1']));
    expect(idp.calls).toHaveLength(1);
    expect(openFgaTokenCounters()['token_coalesced']).toBe(49);
  });

  it('lets the NEXT caller mint again after an in-flight failure resolves', async () => {
    const env = oidcEnv();
    idp.reply({ status: 500, body: { error: 'server_error' } });
    const failed = await Promise.all([getOpenFgaToken(env, T0), getOpenFgaToken(env, T0)]);
    expect(failed).toEqual([null, null]);
    expect(idp.calls).toHaveLength(1);

    idp.reply({ body: { access_token: 'recovered', expires_in: 600 } });
    expect(await getOpenFgaToken(env, T0)).toBe('recovered');
  });
});

// ===========================================================================
// FAILING CLOSED, AND QUIETLY
// ===========================================================================
describe('a mint that fails', () => {
  it.each([
    ['a 500', { status: 500, body: { error: 'server_error' } }],
    ['a 401', { status: 401, body: { error: 'invalid_client' } }],
    ['a body with no access_token', { body: { token_type: 'Bearer' } }],
    ['a non-string access_token', { body: { access_token: 42 } }],
    ['a body that is not an object', { body: '"nope"' }],
  ])('returns null on %s', async (_label, reply) => {
    idp.reply(reply as { status?: number; body?: unknown });
    expect(await getOpenFgaToken(oidcEnv(), T0)).toBeNull();
    expect(openFgaTokenCounters()['token_mint_failed']).toBe(1);
  });

  it('returns null when the endpoint is unreachable', async () => {
    const env = oidcEnv({ OPENFGA_OIDC_TOKEN_ENDPOINT: 'http://127.0.0.1:1/token' });
    expect(await getOpenFgaToken(env, T0)).toBeNull();
  });

  it('yields NO authorization header at all rather than an unauthenticated one', async () => {
    // The distinction this protects: `undefined` means "do not call OpenFGA",
    // and `{}` means "call it with no credential". Confusing the two turns a
    // missing Secret into a 401 that reads like a revoked grant.
    idp.reply({ status: 500, body: {} });
    expect(await openFgaAuthHeaders(oidcEnv(), T0)).toBeUndefined();
    expect(await openFgaAuthHeaders({} as NodeJS.ProcessEnv, T0)).toEqual({});
  });

  it('logs neither the password, the client secret nor a token', async () => {
    idp.reply({ status: 500, body: { error: 'server_error' } });
    await getOpenFgaToken(oidcEnv({ OPENFGA_OIDC_CLIENT_SECRET: 'confidential' }), T0);

    const logged = JSON.stringify([...errors, ...warns, ...logs]);
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain('confidential');
    expect(logged).not.toContain('token-1');
    // It still says enough to act on.
    expect(logged).toMatch(/OpenFGA/i);
  });

  it('logs the message only, never the axios error object', async () => {
    // An axios error serialises its whole request config — url, headers and the
    // form body with both credentials in it. `(err as Error).message` is the
    // rule the Check already follows and this follows it too.
    idp.reply({ status: 500, body: { error: 'server_error' } });
    await getOpenFgaToken(oidcEnv(), T0);

    for (const args of errors) {
      for (const arg of args) {
        expect(typeof arg === 'string' || typeof arg === 'number').toBe(true);
      }
    }
  });
});

// ===========================================================================
// THE STATIC PATH
// ===========================================================================
describe('the static token path', () => {
  it('sends the preshared value and never calls the identity provider', async () => {
    const headers = await openFgaAuthHeaders({ OPENFGA_API_TOKEN: ' shh ' } as NodeJS.ProcessEnv, T0);
    expect(headers).toEqual({ authorization: 'Bearer shh' });
    expect(idp.calls).toHaveLength(0);
  });

  it('is what describeOpenFgaAuth reports, without the token', () => {
    const described = describeOpenFgaAuth({ OPENFGA_API_TOKEN: 'shh' } as NodeJS.ProcessEnv);
    expect(described).toContain('static');
    expect(described).not.toContain('shh');
  });

  it('reports the unconfigured case, which is the one that denies everything', () => {
    expect(describeOpenFgaAuth({} as NodeJS.ProcessEnv)).toContain('none');
  });
});

// ===========================================================================
// THE BOOT LINE
// ===========================================================================
describe('the boot line', () => {
  it('names the active path ONCE, not once per call', () => {
    expect(initOpenFgaAuth(oidcEnv())).toBe('oidc');
    initOpenFgaAuth(oidcEnv());

    expect(logs).toHaveLength(1);
    expect(String(logs[0]?.[0])).toContain('oidc');
  });

  it('WARNS rather than logs when there is no credential, because that state denies everything', () => {
    expect(initOpenFgaAuth({} as NodeJS.ProcessEnv)).toBe('none');

    expect(logs).toHaveLength(0);
    expect(warns).toHaveLength(1);
    expect(String(warns[0]?.[0])).toContain('none');
  });

  it('says a provider is INCOMPLETE rather than reporting it healthy', () => {
    initOpenFgaAuth(oidcEnv({ OPENFGA_OIDC_USERNAME: undefined }));
    expect(String(logs[0]?.[0])).toContain('INCOMPLETE');
    expect(String(logs[0]?.[0])).toContain('OPENFGA_OIDC_USERNAME');
  });

  it('never prints a credential', () => {
    initOpenFgaAuth(oidcEnv({ OPENFGA_OIDC_CLIENT_SECRET: 'confidential' }));
    const printed = JSON.stringify([...logs, ...warns]);
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain('confidential');
  });
});

// ===========================================================================
// THE TOKEN ENDPOINT IS A TRANSPORT DECISION, NOT JUST A URL
// ===========================================================================
describe('the token endpoint scheme', () => {
  const httpsEnv = (endpoint: string): NodeJS.ProcessEnv =>
    ({
      OPENFGA_OIDC_TOKEN_ENDPOINT: endpoint,
      OPENFGA_OIDC_CLIENT_ID: 'openfga',
      OPENFGA_OIDC_USERNAME: USERNAME,
      OPENFGA_OIDC_PASSWORD: PASSWORD,
    }) as NodeJS.ProcessEnv;

  it.each([
    ['a routable http host', 'http://auth.example.com/application/o/token/'],
    ['an http host by IP', 'http://10.1.2.3:9000/token'],
  ])('REFUSES to mint over %s', async (_label, endpoint) => {
    // resolveAuthConfig already refuses a non-https OIDC_JWKS_URI, and JWKS
    // carries PUBLIC KEYS. This endpoint carries the service account's
    // password. The weaker rule was on the higher-value secret.
    expect(await getOpenFgaToken(httpsEnv(endpoint), T0)).toBeNull();
    expect(JSON.stringify(errors)).toContain('https');
  });

  it('allows loopback http, which is how a local issuer and these fixtures are reached', async () => {
    // The same exemption auth/config.ts makes, for the same reason: loopback is
    // not a hop anyone can sit on. Deliberately NOT an opt-out environment
    // variable — a flag that disables a transport requirement is a flag that
    // eventually gets set in production.
    expect(await getOpenFgaToken(httpsEnv(idp.url), T0)).toBe('token-1');
  });

  it('allows https', async () => {
    // Refused at the socket, not at the scheme check: getting this far means
    // the scheme was accepted and the mint was actually attempted.
    expect(await getOpenFgaToken(httpsEnv('https://127.0.0.2:1/token'), T0)).toBeNull();
    expect(JSON.stringify(errors)).not.toContain('https unless');
  });

  it('REFUSES an endpoint that is not an absolute URL at all', async () => {
    expect(await getOpenFgaToken(httpsEnv('auth.example.com/token'), T0)).toBeNull();
    expect(JSON.stringify(errors)).toContain('OPENFGA_OIDC_TOKEN_ENDPOINT');
  });

  it('says so at BOOT, so it is not discovered at the first read', () => {
    const described = describeOpenFgaAuth(httpsEnv('http://auth.example.com/token'));
    expect(described).toContain('REFUSED');
    expect(initOpenFgaAuth(httpsEnv('http://auth.example.com/token'))).toBe('oidc');
    expect(JSON.stringify(errors)).toContain('REFUSED');
  });
});
