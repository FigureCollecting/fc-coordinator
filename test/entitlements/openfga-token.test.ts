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
  const httpsEnv = (endpoint: string): NodeJS.ProcessEnv =>
    ({
      OPENFGA_OIDC_TOKEN_ENDPOINT: endpoint,
      OPENFGA_OIDC_CLIENT_ID: 'openfga',
      OPENFGA_OIDC_USERNAME: USERNAME,
      OPENFGA_OIDC_PASSWORD: PASSWORD,
    }) as NodeJS.ProcessEnv;

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

  it('says a provider is INCOMPLETE rather than reporting it healthy, AT ERROR LEVEL', () => {
    // THE QUIETER FAILURE IS THE MORE DANGEROUS ONE, and that is the whole
    // reason this asserts a level and not just a string. A provider with no
    // configuration at all is obvious and gets `warn`. A HALF-configured one
    // looks configured, mints nothing, and denies every read forever — so it
    // must not be the one that whispers.
    initOpenFgaAuth(oidcEnv({ OPENFGA_OIDC_USERNAME: undefined }));

    expect(String(errors[0]?.[0])).toContain('INCOMPLETE');
    expect(String(errors[0]?.[0])).toContain('OPENFGA_OIDC_USERNAME');
    expect(logs).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it('never announces an unusable provider more quietly than a missing one', () => {
    // Stated as the ordering rather than case by case, because the bug this
    // replaces was exactly an ordering slip: the comment promised the loudest
    // level and the code handed it to one of the two unusable states.
    initOpenFgaAuth(oidcEnv({ OPENFGA_OIDC_PASSWORD: undefined }));
    expect(errors).toHaveLength(1);

    resetOpenFgaTokenForTest();
    errors.length = 0;
    initOpenFgaAuth(httpsEnv('http://auth.example.com/token'));
    expect(errors).toHaveLength(1);

    resetOpenFgaTokenForTest();
    errors.length = 0;
    initOpenFgaAuth({} as NodeJS.ProcessEnv);
    expect(errors).toHaveLength(0);
    expect(warns).toHaveLength(1);
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

// ===========================================================================
// USERINFO EMBEDDED IN THE TOKEN ENDPOINT
//
// Every OTHER credential in this module arrives through its own variable and is
// asserted never to be logged. The token endpoint is the exception in both
// directions: it is the one value the boot line is SUPPOSED to print, and a URL
// is allowed to carry a password inside it. So the one place a secret is meant
// to be echoed is also the one place a secret can arrive unannounced.
//
// Nothing in the estate configures it this way. That is what makes it worth a
// test rather than a fix alone — a latent leak has no operator to notice it.
// ===========================================================================
describe('userinfo embedded in the token endpoint', () => {
  // Deliberately not the word "secret": the assertion must fail on THIS value
  // and not on some unrelated line that happens to use the noun.
  const EMBEDDED = 'hunter2-never-print-me';
  const USER = 'svcuser';

  const endpointEnv = (
    endpoint: string,
    over: Record<string, string | undefined> = {},
  ): NodeJS.ProcessEnv =>
    ({
      OPENFGA_OIDC_TOKEN_ENDPOINT: endpoint,
      OPENFGA_OIDC_CLIENT_ID: 'openfga',
      OPENFGA_OIDC_USERNAME: USERNAME,
      OPENFGA_OIDC_PASSWORD: PASSWORD,
      ...over,
    }) as NodeJS.ProcessEnv;

  const HTTPS = `https://${USER}:${EMBEDDED}@auth.example.com/application/o/token/`;
  /** The fixture endpoint, reachable, with userinfo bolted on. Loopback, so not REFUSED. */
  const loopbackWithUserinfo = (): string => idp.url.replace('http://', `http://${USER}:${EMBEDDED}@`);

  const printed = (): string => JSON.stringify([...logs, ...warns, ...errors]);

  // -------------------------------------------------------------------------
  // THE BOOT LINE
  // -------------------------------------------------------------------------

  // All four boot states, because the printed value is assembled once and
  // reused by every one of them — and the three unusable states are reached by
  // different branches, at three different console levels.
  it.each([
    ['complete', (): NodeJS.ProcessEnv => endpointEnv(HTTPS)],
    ['INCOMPLETE', (): NodeJS.ProcessEnv => endpointEnv(HTTPS, { OPENFGA_OIDC_USERNAME: undefined })],
    ['REFUSED, plaintext', (): NodeJS.ProcessEnv => endpointEnv(`http://${USER}:${EMBEDDED}@auth.example.com/token`)],
    ['REFUSED, not an absolute URL', (): NodeJS.ProcessEnv => endpointEnv(`//${USER}:${EMBEDDED}@auth.example.com/token`)],
    ['REFUSED, no scheme so the host lands in an opaque path', (): NodeJS.ProcessEnv => endpointEnv(`${USER}:${EMBEDDED}@auth.example.com/token`)],
  ])('never prints it at boot in the %s state', (_label, build) => {
    initOpenFgaAuth(build());

    // EVERY level, not the one this state is expected to use: a fix that moved
    // the leak from console.log to console.error would otherwise pass.
    expect(printed()).not.toContain(EMBEDDED);
  });

  it('still identifies WHICH endpoint is configured, by origin and path', () => {
    // Stripping must not turn the line into a shrug. An operator reads this to
    // confirm the Secret points at the right issuer.
    const described = describeOpenFgaAuth(endpointEnv(HTTPS));

    expect(described).toContain('token_endpoint=https://auth.example.com/application/o/token/');
    expect(described).not.toContain(EMBEDDED);
    expect(described).not.toContain(USER);
    expect(described).toContain('complete');
  });

  it('keeps every boot state exactly where it was, so stripping hid no misconfiguration', () => {
    // The risk of a redaction is that it redacts the DIAGNOSIS too. The state
    // word is the diagnosis, so it is pinned alongside the secret's absence.
    expect(describeOpenFgaAuth(endpointEnv(HTTPS))).toContain('complete');
    expect(describeOpenFgaAuth(endpointEnv(HTTPS, { OPENFGA_OIDC_PASSWORD: undefined }))).toContain('INCOMPLETE');
    expect(describeOpenFgaAuth(endpointEnv(`http://${USER}:${EMBEDDED}@auth.example.com/token`))).toContain('REFUSED');
    expect(describeOpenFgaAuth(endpointEnv(`//${USER}:${EMBEDDED}@auth.example.com/token`))).toContain('REFUSED');
  });

  // -------------------------------------------------------------------------
  // THE TWO PLACEHOLDERS ARE DIFFERENT OPERATOR PROBLEMS
  // -------------------------------------------------------------------------

  it('still says (unset) rather than (unparseable) when the endpoint is simply absent', () => {
    // An absent endpoint and an unrenderable one are different operator
    // problems and the line must not collapse them.
    const described = describeOpenFgaAuth(endpointEnv('', { OPENFGA_OIDC_TOKEN_ENDPOINT: undefined }));

    expect(described).toContain('token_endpoint=(unset)');
    expect(described).not.toContain('(unparseable)');
    expect(described).toContain('INCOMPLETE');
  });

  it.each([
    ['a protocol-relative URL, which has no scheme to parse', `//${USER}:${EMBEDDED}@auth.example.com/token`],
    ['a bare host:port, where the userinfo lands in an OPAQUE PATH', `${USER}:${EMBEDDED}@auth.example.com/token`],
    ['a data: URL, same shape, no authority at all', `data:text/plain,${USER}:${EMBEDDED}@auth.example.com`],
    // THE THREE BELOW CARRY NO `@`, and that is the whole reason they are here.
    // Every opaque input above happens to contain one, so once the at-sign
    // guard was added it answered first and the null-origin guard behind it
    // stopped being pinned by anything: deleting that guard left the suite
    // green. These are what an opaque endpoint looks like when the at-sign
    // guard cannot help, and with the null-origin check gone they render as
    // `null` concatenated to a path holding the secret — `nullhunter2/token`.
    // A guard that no test can break is a guard nobody will keep.
    ['an opaque URL with no @ anywhere, so only the null origin can catch it', `${USER}:${EMBEDDED}/token`],
    ['a mailto:, which is an opaque path and nothing else', `mailto:${EMBEDDED}`],
    ['a blob: with no inner URL to take an origin from', `blob:${EMBEDDED}`],
    // The literal placeholder text, CONFIGURED. This is the one input on which
    // branching on emptiness and branching on `endpoint === '(unset)'` differ,
    // and it is what makes the emptiness form the testable one. Not a
    // credential exposure either way — what the other form would print is this
    // same literal string — but "you configured nothing" and "you configured
    // something I will not repeat" are different diagnoses and must not merge.
    ['the literal text (unset), actually configured', '(unset)'],
  ])('renders %s as (unparseable), never as its own text', (_label, endpoint) => {
    // The opaque-path case is the one a naive `origin + pathname` gets WRONG:
    // `new URL` accepts it, reports origin "null", and puts the whole rest —
    // userinfo included — in `pathname`. Parsing successfully is not the same
    // as being safe to print.
    const described = describeOpenFgaAuth(endpointEnv(endpoint));

    expect(described).toContain('token_endpoint=(unparseable)');
    expect(described).not.toContain(EMBEDDED);
    expect(described).not.toContain('(unset)');

    // And through the boot line as well, at every level. `describeOpenFgaAuth`
    // returns a string; what matters is that the string reaches a console
    // without the secret in it, whichever level the state routes it to.
    initOpenFgaAuth(endpointEnv(endpoint));
    expect(printed()).toContain('(unparseable)');
    expect(printed()).not.toContain(EMBEDDED);
  });

  it('drops the query and the fragment, which are not part of identifying the issuer', () => {
    // Not userinfo, but the same argument: neither is needed to recognise the
    // endpoint, and a token endpoint carrying a query string is as plausible a
    // place to have parked a secret as the authority is.
    const described = describeOpenFgaAuth(
      endpointEnv(`https://auth.example.com/token?api_key=${EMBEDDED}#${EMBEDDED}`),
    );

    expect(described).toContain('token_endpoint=https://auth.example.com/token,');
    expect(described).not.toContain(EMBEDDED);
  });

  it.each([
    ['a plain @ in the path', `https://auth.example.com/a@${EMBEDDED}/token`],
    [
      'a blob: URL, whose origin comes from the INNER url and whose path keeps its userinfo',
      `blob:https://${USER}:${EMBEDDED}@auth.example.com/token`,
    ],
    [
      'a slash inside the password, which makes the USERNAME parse as the host',
      `https://${USER}:1234/${EMBEDDED}@auth.example.com/token`,
    ],
  ])('renders %s as (unparseable) — the origin is not safe either', (_label, endpoint) => {
    // NOT A HYPOTHETICAL. The second and third are real inputs reaching the
    // `@`-in-path branch, and the third is the one that settles the question of
    // what to degrade TO: `https://svcuser:1234/...` parses `svcuser` as the
    // host and `1234` as the port, so the ORIGIN itself is assembled out of a
    // username and the head of a password. Printing it would echo the
    // credential while calling it the issuer.
    const described = describeOpenFgaAuth(endpointEnv(endpoint));

    expect(described).toContain('token_endpoint=(unparseable)');
    expect(described).not.toContain(EMBEDDED);
    expect(described).not.toContain('auth.example.com/');
  });

  // -------------------------------------------------------------------------
  // EVERY OTHER CONSOLE SITE IN THE MODULE
  //
  // The boot line is where the leak was FOUND. It is not the only place the
  // configured endpoint can be reached from, so the property is asserted over
  // every branch in the file that writes to a console sink, driven with a
  // userinfo-bearing endpoint in each.
  // -------------------------------------------------------------------------
  it.each([
    [
      'the REFUSED mint path, which reports its own reason at the first mint',
      async (): Promise<void> => {
        expect(await getOpenFgaToken(endpointEnv(`//${USER}:${EMBEDDED}@auth.example.com/token`), T0)).toBeNull();
      },
    ],
    [
      'the INCOMPLETE mint path',
      async (): Promise<void> => {
        expect(
          await getOpenFgaToken(endpointEnv(HTTPS, { OPENFGA_OIDC_PASSWORD: undefined }), T0),
        ).toBeNull();
      },
    ],
    [
      'the shadowed-static warning, the one console.warn the oidc path can reach',
      async (): Promise<void> => {
        await openFgaAuthHeaders(endpointEnv(loopbackWithUserinfo(), { OPENFGA_API_TOKEN: 'stale' }), T0);
        expect(warns.length).toBeGreaterThan(0);
      },
    ],
    [
      'a mint that SUCCEEDS over an endpoint carrying userinfo',
      async (): Promise<void> => {
        expect(await getOpenFgaToken(endpointEnv(loopbackWithUserinfo()), T0)).toBe('token-1');
      },
    ],
    [
      'a mint whose response body is not an object',
      async (): Promise<void> => {
        idp.reply({ body: '[]' });
        expect(await getOpenFgaToken(endpointEnv(loopbackWithUserinfo()), T0)).toBeNull();
        expect(errors.length).toBeGreaterThan(0);
      },
    ],
    [
      'a mint whose response carries no access_token',
      async (): Promise<void> => {
        idp.reply({ body: { token_type: 'Bearer' } });
        expect(await getOpenFgaToken(endpointEnv(loopbackWithUserinfo()), T0)).toBeNull();
        expect(errors.length).toBeGreaterThan(0);
      },
    ],
    [
      'a mint the provider answers with a 500, so the axios error is the one being printed',
      async (): Promise<void> => {
        idp.reply({ status: 500, body: { error: 'boom' } });
        expect(await getOpenFgaToken(endpointEnv(loopbackWithUserinfo()), T0)).toBeNull();
        expect(errors.length).toBeGreaterThan(0);
      },
    ],
    [
      'a mint against a socket that refuses, the transport-error branch',
      async (): Promise<void> => {
        expect(
          await getOpenFgaToken(endpointEnv(`https://${USER}:${EMBEDDED}@127.0.0.2:1/token`), T0),
        ).toBeNull();
        expect(errors.length).toBeGreaterThan(0);
      },
    ],
  ])('leaks nothing through %s', async (_label, drive) => {
    await drive();

    expect(printed()).not.toContain(EMBEDDED);
    // The other two credentials are asserted elsewhere; re-asserted here because
    // this suite is the one that drives every console branch in one place.
    expect(printed()).not.toContain(PASSWORD);
  });

  it('names the endpoint on the mint-failure line, so the failure says WHICH issuer', async () => {
    // Redaction must not cost the diagnosis. Before this, a mint failure named
    // no endpoint at all; it names one now, and the safe form is the one it can
    // afford to name.
    idp.reply({ status: 500, body: { error: 'boom' } });
    expect(await getOpenFgaToken(endpointEnv(loopbackWithUserinfo()), T0)).toBeNull();

    const text = JSON.stringify(errors);
    expect(text).toContain('minting the OpenFGA token failed');
    expect(text).toContain(new URL(idp.url).origin);
    expect(text).not.toContain(EMBEDDED);
  });
});

// ===========================================================================
// WHY A MINT HAPPENED
//
// The module could already say HOW MANY tokens it minted. It could not say
// what for, and that turned out to matter: a review measured 26 mints for 50
// subjects against a permanent 401 where the per-subject reasoning predicted
// two, and the first fix attempted for it measured identical — because nobody
// could see which of the three reasons the extra mints were arriving under.
//
// So every mint now names its cause, a forced refresh says whether it actually
// threw anything away, and the single-flight pile-up records how deep it got.
// These are the numbers test/entitlements/mint-storm.test.ts reads.
// ===========================================================================
describe('the mint counters say WHY, not just how many', () => {
  it('calls the first mint of a process cold', async () => {
    expect(await getOpenFgaToken(oidcEnv(), T0)).toBe('token-1');

    const c = openFgaTokenCounters();
    expect(c['token_mint']).toBe(1);
    expect(c['token_mint_cold']).toBe(1);
    expect(c['token_mint_expired']).toBeUndefined();
    expect(c['token_mint_forced']).toBeUndefined();
  });

  it('calls a mint past the refresh point expired', async () => {
    const env = oidcEnv();
    await getOpenFgaToken(env, T0);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    // 600 s lifetime, 120 s skew -> the refresh point is 480 s in.
    expect(await getOpenFgaToken(env, T0 + 480_000)).toBe('token-2');

    const c = openFgaTokenCounters();
    expect(c['token_mint']).toBe(2);
    expect(c['token_mint_cold']).toBe(1);
    expect(c['token_mint_expired']).toBe(1);
  });

  it('re-mints when the caller names the token that is actually cached', async () => {
    // THE STORM PATH, and the legitimate half of it. The caller was refused
    // holding token-1, token-1 is what the cache holds, so nobody else has
    // replaced it yet and this really is the re-mint that has to happen.
    const env = oidcEnv();
    await openFgaAuthHeaders(env, T0);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    expect(
      await openFgaAuthHeaders(env, T0, { forceRefresh: true, presentedToken: 'token-1' }),
    ).toEqual({ authorization: 'Bearer token-2' });

    const c = openFgaTokenCounters();
    expect(c['token_mint']).toBe(2);
    expect(c['token_mint_forced']).toBe(1);
    expect(c['token_refresh_requested']).toBe(1);
    expect(c['token_refresh_discarded']).toBe(1);
  });

  it('STANDS DOWN when the cache has already moved past the token that was refused', async () => {
    // THE FIX. A caller refused holding token-1 arrives to find token-2 in the
    // cache — someone else's re-mint landed first. There is nothing to re-mint:
    // token-2 has not been tried. It takes token-2 and the identity provider is
    // never called. Fifty subjects refused together used to cost 26 mints and
    // now cost 2, entirely through this branch.
    const env = oidcEnv();
    await openFgaAuthHeaders(env, T0);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });
    await openFgaAuthHeaders(env, T0, { forceRefresh: true, presentedToken: 'token-1' });
    const mintsBefore = idp.calls.length;

    expect(
      await openFgaAuthHeaders(env, T0, { forceRefresh: true, presentedToken: 'token-1' }),
    ).toEqual({ authorization: 'Bearer token-2' });

    expect(idp.calls).toHaveLength(mintsBefore);
    const c = openFgaTokenCounters();
    expect(c['token_refresh_superseded']).toBe(1);
    expect(c['token_mint']).toBe(2);
    expect(c['token_cache_hit']).toBe(1);
  });

  it('clears the cache on trust when the caller can name no token, and says so', async () => {
    // THE PRE-FIX BEHAVIOUR, kept reachable for a caller with no token to name
    // and counted separately so it cannot creep back in unnoticed. grants.ts
    // always names one; mint-storm.test.ts pins this counter at zero.
    const env = oidcEnv();
    await openFgaAuthHeaders(env, T0);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    expect(await openFgaAuthHeaders(env, T0, { forceRefresh: true })).toEqual({
      authorization: 'Bearer token-2',
    });

    const c = openFgaTokenCounters();
    expect(c['token_refresh_blind']).toBe(1);
    expect(c['token_refresh_discarded']).toBeUndefined();
    expect(c['token_mint_forced']).toBe(1);
  });

  it('accounts for every refresh request across the four outcomes', async () => {
    // An invariant over the split, for the same reason the mint reasons have
    // one: a request landing in no bucket, or two, makes every ratio built on
    // these numbers wrong without making any single count look wrong.
    const env = oidcEnv();
    await openFgaAuthHeaders(env, T0, { forceRefresh: true, presentedToken: 'nothing-cached-yet' });
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });
    await openFgaAuthHeaders(env, T0, { forceRefresh: true, presentedToken: 'token-1' });
    await openFgaAuthHeaders(env, T0, { forceRefresh: true, presentedToken: 'token-1' });
    await openFgaAuthHeaders(env, T0, { forceRefresh: true });

    const c = openFgaTokenCounters();
    const byOutcome =
      (c['token_refresh_discarded'] ?? 0) +
      (c['token_refresh_superseded'] ?? 0) +
      (c['token_refresh_empty'] ?? 0) +
      (c['token_refresh_blind'] ?? 0);
    expect(byOutcome).toBe(c['token_refresh_requested']);
    expect(c['token_refresh_requested']).toBe(4);
  });

  it('separates a refresh that threw a token away from one that found nothing', async () => {
    // Asked for and acted on are different numbers, and the gap between them is
    // the interesting one: a refresh that discards nothing is a caller whose
    // token was ALREADY replaced by someone else's re-mint, which is exactly
    // the coordination the storm lacks.
    const env = oidcEnv();

    expect(await openFgaAuthHeaders(env, T0, { forceRefresh: true })).toEqual({
      authorization: 'Bearer token-1',
    });

    const c = openFgaTokenCounters();
    expect(c['token_refresh_requested']).toBe(1);
    expect(c['token_refresh_empty']).toBe(1);
    expect(c['token_refresh_discarded']).toBeUndefined();
    // Still attributed to the refresh, because that is what the caller asked
    // for — the outcome split, not the reason, is what says it found nothing.
    expect(c['token_mint_forced']).toBe(1);
    expect(c['token_mint_cold']).toBeUndefined();
  });

  it('accounts for every mint exactly once across the three reasons', async () => {
    // An invariant, not a scenario: a reason that stops being assigned, or one
    // assigned twice, makes every ratio built on these numbers wrong without
    // making any single count look wrong.
    const env = oidcEnv();
    await getOpenFgaToken(env, T0);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });
    await getOpenFgaToken(env, T0 + 480_000);
    await openFgaAuthHeaders(env, T0 + 480_000, { forceRefresh: true });

    const c = openFgaTokenCounters();
    const byReason =
      (c['token_mint_cold'] ?? 0) + (c['token_mint_expired'] ?? 0) + (c['token_mint_forced'] ?? 0);
    expect(byReason).toBe(c['token_mint']);
    expect(c['token_mint']).toBe(3);
  });

  it('records how deep the single-flight pile-up got, not just that there was one', async () => {
    // `token_coalesced` is a running total over the process; the peak is what
    // says whether fifty callers arrived together or two did, twenty-five
    // times. Those are the same total and different incidents.
    const env = oidcEnv();
    await Promise.all(Array.from({ length: 50 }, () => getOpenFgaToken(env, T0)));

    const c = openFgaTokenCounters();
    expect(c['token_mint']).toBe(1);
    expect(c['token_coalesced']).toBe(49);
    expect(c['token_inflight_peak']).toBe(50);
  });

  it('reports the peak as a high-water mark, not a sum of separate pile-ups', async () => {
    const env = oidcEnv();
    await Promise.all(Array.from({ length: 4 }, () => getOpenFgaToken(env, T0)));
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });
    await Promise.all(Array.from({ length: 3 }, () => getOpenFgaToken(env, T0 + 480_000)));

    const c = openFgaTokenCounters();
    expect(c['token_coalesced']).toBe(5);
    expect(c['token_inflight_peak']).toBe(4);
  });

  it('clears the reasons with the rest of the state, so one test cannot read another', () => {
    resetOpenFgaTokenForTest();
    expect(openFgaTokenCounters()).toEqual({});
  });
});
