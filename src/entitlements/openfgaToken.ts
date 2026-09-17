/**
 * openfgaToken.ts — the credential the entitlement Check presents, MINTED
 * rather than configured.
 *
 * WHY THIS FILE EXISTS. The Check used to send `OPENFGA_API_TOKEN` as a bearer
 * and that was right until OpenFGA moved to `authn.method: oidc`. The provider
 * it now trusts issues TEN-MINUTE tokens, so a static environment value is
 * correct for ten minutes and then denies forever — and denies SILENTLY,
 * because a 401 is caught, counted as an error and turned into a deny. Every
 * read would come back with its magnitudes withheld, and the only trace would
 * be a recurring "Check failed" in the log.
 *
 * THE GRANT IS client_credentials WITH A USERNAME AND PASSWORD, which looks
 * wrong and is not. The identity provider models this caller as a SERVICE
 * ACCOUNT whose app-password is presented alongside the public client id; the
 * operator script that mints the same token by hand does exactly this, with
 * `--data-urlencode` on both values. So does this: a password containing `&`,
 * `=` or `+` is not exotic, and one sent raw is a credential that works until
 * the day it is rotated to one containing a reserved character. An optional
 * `OPENFGA_OIDC_CLIENT_SECRET` is sent when set, for a confidential-client
 * deployment.
 *
 * THE FOUR PROPERTIES, each of which is a test:
 *
 *   REFRESH AHEAD OF EXPIRY. `expires_in - skew`, floored at HALF the lifetime
 *   so a short-lived token cannot schedule its refresh in the past — which
 *   would re-mint on every single call, a stampede wearing a safety margin's
 *   clothes.
 *
 *   SINGLE FLIGHT. A cold start under load must mint once. The identity
 *   provider is a cross-cluster hop, and one request per concurrent read is
 *   how a busy page becomes an outage upstream.
 *
 *   FAIL CLOSED. A mint failure returns null and the caller DENIES. It must
 *   never fall through to an unauthenticated Check: OpenFGA would answer 401
 *   and the user-visible outcome would be identical, but the log would name
 *   the wrong cause and an operator would go looking for a revoked grant
 *   instead of a missing Secret key. That is also why a PARTIALLY configured
 *   provider stays in `oidc` mode and fails there, rather than degrading to
 *   the unauthenticated path.
 *
 *   NOTHING LEAKS. Not the password, not the client secret, not the token, and
 *   never an axios error object — which serialises the whole request config,
 *   the form body included. The message only, the same rule the Check follows.
 *   The token endpoint is the one value that IS printed, so it goes through
 *   `printableEndpoint` everywhere: a URL may carry `user:password@` and that
 *   would otherwise be a credential arriving inside a value meant for the log.
 *
 * NO BACKOFF LAYER HERE, deliberately. A mint outage is already damped twice:
 * single-flight collapses concurrent attempts, and the grant cache remembers an
 * error-deny per subject for ENTITLEMENT_GRANT_ERROR_TTL_MS. A third timer
 * would only lengthen recovery once the provider comes back.
 *
 * PORTABILITY: this file imports `axios` and nothing else, so the directory
 * still copies whole. See ./index.ts.
 */
import axios from 'axios';

/** Which credential this process will present. */
export type OpenFgaAuthMode = 'oidc' | 'static' | 'none';

/** Assumed when the provider does not say. Short on purpose — see the header. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 60;
/** Two minutes of headroom on the ten-minute token the provider actually issues. */
const DEFAULT_REFRESH_SKEW_SECONDS = 120;
/** The floor: never refresh later than halfway through the lifetime. */
const MIN_REFRESH_FRACTION = 0.5;
/** A blocking hop inside a user-facing read, like the Check itself. */
const DEFAULT_MINT_TIMEOUT_MS = 5_000;
const DEFAULT_SCOPE = 'openid';

/**
 * Loopback is the one place plaintext is acceptable, because it is not a hop
 * anyone can sit on. Exactly the exemption src/auth/config.ts makes for
 * OIDC_JWKS_URI, and exactly the set it uses.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const OIDC_KEYS = [
  'OPENFGA_OIDC_TOKEN_ENDPOINT',
  'OPENFGA_OIDC_CLIENT_ID',
  'OPENFGA_OIDC_USERNAME',
  'OPENFGA_OIDC_PASSWORD',
] as const;

interface CachedToken {
  token: string;
  /** Wall clock at which the NEXT call re-mints. Always before real expiry. */
  refreshAtMs: number;
}

/** Why the mint about to happen is happening. See `openFgaTokenCounters`. */
type MintReason = 'cold' | 'expired' | 'forced';

let cached: CachedToken | null = null;
let inflight: Promise<string | null> | null = null;
/**
 * Set by `invalidateOpenFgaToken`, read by the mint that follows it.
 *
 * Without it a forced re-mint is indistinguishable from a cold start, because
 * both of them find an empty cache — and telling those two apart is the whole
 * question behind the 401 storm.
 */
let invalidateRequested = false;
/** Callers currently waiting on one in-flight mint, for the high-water mark. */
let inflightWaiters = 0;
let warnedShadowedStatic = false;
let warnedIncomplete = false;
let warnedEndpoint = false;
let loggedBootLine = false;

const counters = new Map<string, number>();
const bump = (name: string): void => {
  counters.set(name, (counters.get(name) ?? 0) + 1);
};

/**
 * A high-water mark, not a running total: the deepest single-flight pile-up
 * seen so far. `token_coalesced` counts every caller that ever joined one;
 * fifty arriving together and two arriving twenty-five times give the same
 * total and are different incidents.
 */
const recordInflightPeak = (): void => {
  if (inflightWaiters > (counters.get('token_inflight_peak') ?? 0)) {
    counters.set('token_inflight_peak', inflightWaiters);
  }
};

/**
 * Snapshot of everything this module counts.
 *
 *   token_mint               tokens successfully minted
 *   token_mint_cold          ...of which: nothing was cached and no refresh
 *                            had been asked for — a process start, or the
 *                            first call after a failed mint
 *   token_mint_expired       ...of which: a cached token had reached its
 *                            refresh point. The healthy, scheduled case.
 *   token_mint_forced        ...of which: a caller asked for a refresh, which
 *                            in this service means the Check's 401 retry.
 *                            These three add up to token_mint exactly.
 *   token_mint_failed        mints that returned nothing
 *   token_cache_hit          calls served from the cache
 *   token_coalesced          calls that joined a mint already in flight
 *   token_inflight_peak      the deepest such pile-up (a gauge, not a total)
 *   token_refresh_requested  forced refreshes asked for
 *   token_refresh_discarded  ...of which: one actually threw a live token
 *                            away. The GAP between these two is a caller
 *                            whose token had already been replaced.
 *
 * WHAT THESE ARE FOR. A review measured 26 mints for 50 subjects against a
 * permanent OpenFGA 401 — the per-subject reasoning predicts two — and the
 * first fix proposed for it measured identical, because nothing here could say
 * which reason the extra mints arrived under. `token_mint_forced` against
 * `reminted` from grants.ts is the mint-per-retrying-subject ratio, and
 * `token_refresh_requested` against `token_refresh_discarded` says how much of
 * it is callers re-minting over each other.
 */
export const openFgaTokenCounters = (): Readonly<Record<string, number>> => Object.fromEntries(counters);

/** Test seam: drop the cached token, the in-flight mint, the counters and the one-shot warnings. */
export const resetOpenFgaTokenForTest = (): void => {
  cached = null;
  inflight = null;
  invalidateRequested = false;
  inflightWaiters = 0;
  counters.clear();
  warnedShadowedStatic = false;
  warnedIncomplete = false;
  warnedEndpoint = false;
  loggedBootLine = false;
};

/**
 * Drop the cached token. The 401 path calls this to force exactly one re-mint.
 *
 * ASKED FOR and ACTED ON are counted separately, and the gap between them is
 * the measurement this module was missing. A caller whose token has already
 * been replaced by a neighbour's re-mint finds nothing to discard; one that
 * discards a live token has just taken it away from everyone else holding it.
 */
export const invalidateOpenFgaToken = (): void => {
  bump('token_refresh_requested');
  if (cached !== null) bump('token_refresh_discarded');
  cached = null;
  // So the mint that follows is attributed to the refresh instead of looking
  // like a cold start — which is what an empty cache otherwise looks like.
  invalidateRequested = true;
};

const trimmed = (raw: string | undefined): string => raw?.trim() ?? '';

/** A positive finite number, or the default. Zero is the absence of a bound, not a small one. */
const num = (raw: string | undefined, fallback: number): number => {
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Which credential path is active.
 *
 * ANY of the four OIDC variables being present means `oidc`, not just all four.
 * A half-configured provider must fail as a provider — loudly, naming the key
 * that is missing — rather than quietly becoming the unauthenticated path.
 */
export function openFgaAuthMode(env: NodeJS.ProcessEnv): OpenFgaAuthMode {
  if (OIDC_KEYS.some((key) => trimmed(env[key]) !== '')) return 'oidc';
  if (trimmed(env.OPENFGA_API_TOKEN) !== '') return 'static';
  return 'none';
}

/** A boot line an operator can read: which path, and enough to identify it. Never a secret. */
export function describeOpenFgaAuth(env: NodeJS.ProcessEnv): string {
  const mode = openFgaAuthMode(env);
  if (mode === 'oidc') {
    const missing = OIDC_KEYS.filter((key) => trimmed(env[key]) === '');
    const rawEndpoint = trimmed(env.OPENFGA_OIDC_TOKEN_ENDPOINT);
    const endpoint = rawEndpoint || '(unset)';
    const clientId = trimmed(env.OPENFGA_OIDC_CLIENT_ID) || '(unset)';
    const rejected = missing.length === 0 ? rejectEndpoint(endpoint) : null;
    // The RAW value is what gets validated; the PRINTABLE one is what gets
    // shown. The branch is on emptiness rather than on the placeholder's text,
    // so an endpoint literally configured as `(unset)` is still put through the
    // redaction and comes back `(unparseable)`.
    const shownEndpoint = rawEndpoint === '' ? '(unset)' : printableEndpoint(rawEndpoint);
    const state =
      missing.length > 0
        ? `INCOMPLETE, missing ${missing.join(', ')}`
        : rejected !== null
          ? `REFUSED — ${rejected}`
          : 'complete';
    return `oidc client_credentials (${state}; token_endpoint=${shownEndpoint}, client_id=${clientId})`;
  }
  if (mode === 'static') return 'static preshared token (OPENFGA_API_TOKEN)';
  return 'none — no credential configured, so every entitlement check denies';
}

/**
 * Log the active path once, the way the signing module logs its mint state. A
 * silent "which credential am I using" is how a ten-minute expiry became a
 * production outage in the first place.
 */
export function initOpenFgaAuth(env: NodeJS.ProcessEnv = process.env): OpenFgaAuthMode {
  const mode = openFgaAuthMode(env);
  if (!loggedBootLine) {
    loggedBootLine = true;
    const described = describeOpenFgaAuth(env);
    const line = `[ENTITLEMENT] OpenFGA credential: ${described}`;
    // A provider that cannot be used is worse than no provider at all: it looks
    // configured, mints nothing, and denies every read forever. BOTH such
    // states get the loudest level, at BOOT, rather than waiting for the first
    // Check — an endpoint we refuse to post to, and a half-filled Secret.
    //
    // The ordering is the point, and it was wrong here once: `none` is the
    // OBVIOUS failure and gets `warn`, so the two non-obvious ones must not be
    // quieter than it. They were, by one word.
    if (described.includes('REFUSED') || described.includes('INCOMPLETE')) console.error(line);
    else if (mode === 'none') console.warn(line);
    else console.log(line);
  }
  return mode;
}

/**
 * Rendered in place of an endpoint that cannot be shown without risking the
 * value inside it. Distinct from `(unset)` deliberately: "you configured
 * nothing" and "you configured something I will not repeat" are different
 * operator problems, and one boot line that says both says neither.
 */
const UNPRINTABLE_ENDPOINT = '(unparseable)';

/**
 * The configured token endpoint, in a form that is safe to put in a log line.
 *
 * WHY THIS EXISTS. This module's stated property is that nothing leaks, and
 * every other credential it handles arrives in a variable of its own that is
 * simply never printed. The endpoint is the exception in BOTH directions: it is
 * the one value the boot line is SUPPOSED to print — an operator reads it to
 * confirm the Secret points at the right issuer — and a URL is allowed to carry
 * `user:password@` in its authority. So the one value meant to be echoed is
 * also the one place a secret can arrive without announcing itself as one.
 *
 * ORIGIN PLUS PATH, and `origin` does the real work: it is the one part of a
 * parsed URL guaranteed to exclude userinfo, so scheme, host and port survive
 * and a credential cannot. Query and fragment go too — neither identifies the
 * issuer, and both are as plausible a place to have parked a key as the
 * authority is.
 *
 * THE CASE A NAIVE VERSION GETS WRONG is a value with no authority at all.
 * `new URL('svcuser:pw@idp.example.com/token')` does not throw: it reports
 * scheme `svcuser:`, origin `"null"` and pathname `pw@idp.example.com/token` —
 * the whole credential, sitting in the field this function would otherwise
 * print. Parsing successfully is not the same as being safe to print, so a null
 * origin renders as the placeholder rather than as anything derived from the
 * input.
 */
function printableEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return UNPRINTABLE_ENDPOINT;
  }
  // `'null'` is the literal string the URL standard yields for a scheme that
  // has no authority to have an origin for — the opaque-path case above.
  if (url.origin === 'null') return UNPRINTABLE_ENDPOINT;
  // A TRIPWIRE, not a case reachable today: with an authority present the
  // parser cannot leave userinfo in the path. If an `@` ever appears here that
  // assumption has stopped holding, so the value degrades to the origin — which
  // still names the issuer — rather than being printed on the strength of it.
  if (url.pathname.includes('@')) return url.origin;
  return `${url.origin}${url.pathname}`;
}

/**
 * Is this an endpoint the service account's password may be sent to?
 *
 * WHY THE RULE IS HERE AT ALL. `resolveAuthConfig` already refuses a non-https
 * `OIDC_JWKS_URI` and explains why every variable there has no safe default.
 * JWKS carries PUBLIC KEYS. This endpoint carries a password and, when
 * configured, a client secret — so the weaker rule was sitting on the
 * higher-value secret. Plaintext here is an offer to read the credential off
 * the wire, and it was previously accepted in silence: no warning, no boot
 * line, nothing.
 *
 * NO OPT-OUT VARIABLE, deliberately. The loopback exemption is enough for a
 * local issuer and for every fixture in the suite, and a flag whose whole
 * purpose is to disable a transport requirement is a flag that eventually gets
 * set in production by someone in a hurry.
 *
 * Returns null when the endpoint is acceptable, or the reason it is not.
 */
function rejectEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // The configured value is NOT echoed raw here, unlike the same message in
    // auth/config.ts. That one is about OIDC_JWKS_URI, which carries public
    // keys; this one is about the endpoint the service account's password is
    // posted to, and a URL may carry a second credential inside it.
    return `OPENFGA_OIDC_TOKEN_ENDPOINT must be an absolute URL, got ${printableEndpoint(raw)}`;
  }
  if (url.protocol !== 'https:' && !LOOPBACK_HOSTS.has(url.hostname)) {
    return `OPENFGA_OIDC_TOKEN_ENDPOINT must use https (got '${url.protocol}') unless it is loopback — the service account's password is sent to it`;
  }
  return null;
}

interface OidcConfig {
  endpoint: string;
  clientId: string;
  username: string;
  password: string;
  clientSecret: string;
  scope: string;
  skewSeconds: number;
  timeoutMs: number;
}

/** The resolved provider settings, or null (having said which key is missing). */
function oidcConfig(env: NodeJS.ProcessEnv): OidcConfig | null {
  const missing = OIDC_KEYS.filter((key) => trimmed(env[key]) === '');
  if (missing.length > 0) {
    if (!warnedIncomplete) {
      warnedIncomplete = true;
      console.error(
        `[ENTITLEMENT] the OpenFGA OIDC credential is only partly configured — missing ${missing.join(', ')}. No token can be minted, so every entitlement check denies and spine reads come back redacted.`,
      );
    }
    return null;
  }
  const endpoint = trimmed(env.OPENFGA_OIDC_TOKEN_ENDPOINT);
  const rejected = rejectEndpoint(endpoint);
  if (rejected !== null) {
    if (!warnedEndpoint) {
      warnedEndpoint = true;
      console.error(`[ENTITLEMENT] REFUSED to mint an OpenFGA token: ${rejected}. Every entitlement check denies and spine reads come back redacted until this is corrected.`);
    }
    return null;
  }

  return {
    endpoint,
    clientId: trimmed(env.OPENFGA_OIDC_CLIENT_ID),
    username: trimmed(env.OPENFGA_OIDC_USERNAME),
    // NOT trimmed: a password's surrounding whitespace is part of it.
    password: env.OPENFGA_OIDC_PASSWORD ?? '',
    clientSecret: env.OPENFGA_OIDC_CLIENT_SECRET ?? '',
    scope: trimmed(env.OPENFGA_OIDC_SCOPE) || DEFAULT_SCOPE,
    skewSeconds: num(env.OPENFGA_OIDC_REFRESH_SKEW_SECONDS, DEFAULT_REFRESH_SKEW_SECONDS),
    timeoutMs: num(env.OPENFGA_OIDC_TIMEOUT_MS, DEFAULT_MINT_TIMEOUT_MS),
  };
}

/** When to re-mint. Ahead of expiry, and never in the past. */
function refreshAtMs(expiresInSeconds: number, skewSeconds: number, nowMs: number): number {
  const lifetime = expiresInSeconds > 0 ? expiresInSeconds : DEFAULT_TOKEN_LIFETIME_SECONDS;
  const ahead = Math.max(lifetime - skewSeconds, lifetime * MIN_REFRESH_FRACTION);
  return nowMs + ahead * 1000;
}

async function mint(config: OidcConfig, nowMs: number, reason: MintReason): Promise<string | null> {
  // URLSearchParams percent-encodes every value, which is the whole point: a
  // password with `&` or `=` in it would otherwise split into extra fields.
  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    username: config.username,
    password: config.password,
    scope: config.scope,
  });
  if (config.clientSecret !== '') form.set('client_secret', config.clientSecret);

  try {
    const response = await axios.post(config.endpoint, form.toString(), {
      timeout: config.timeoutMs,
      // NEVER FOLLOW A REDIRECT FROM HERE, and this is the single most
      // dangerous line in the file to remove.
      //
      // axios defaults to following up to 21 redirects, and follow-redirects
      // preserves BOTH the method and the body across a 307 or a 308 —
      // including to a different host. The body of THIS request is the service
      // account's password and, when configured, the client secret. Measured
      // against a real socket before this option existed: a token endpoint
      // answering 307 handed the full form body, password intact and correctly
      // percent-decoded at the far end, to the host it named, and the token
      // that host returned was cached and presented to OpenFGA as this
      // service's credential. The url-encoding above exists so the password
      // survives the wire; without this line it survives it all the way to
      // whoever asks.
      //
      // Zero, not one, and not same-host-only. A token endpoint that is not
      // where it says it is, is a misconfiguration; an allowance shaped like
      // "same host is fine" is one Host header away from not being. With
      // maxRedirects at 0 axios returns the 3xx as an ordinary response, which
      // the default validateStatus then rejects, so a redirect lands in the
      // catch below and fails the mint closed like any other bad answer.
      maxRedirects: 0,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    const data: unknown = response.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      bump('token_mint_failed');
      console.error('[ENTITLEMENT] the OpenFGA token response was not an object — denying');
      return null;
    }
    const body = data as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      bump('token_mint_failed');
      console.error('[ENTITLEMENT] the OpenFGA token response carried no access_token — denying');
      return null;
    }
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : 0;
    cached = { token: body.access_token, refreshAtMs: refreshAtMs(expiresIn, config.skewSeconds, nowMs) };
    bump('token_mint');
    // Beside the total, never instead of it: the three reasons must add up to
    // it, and they only do if both are bumped on the same successful path.
    bump(`token_mint_${reason}`);
    return cached.token;
  } catch (err) {
    // The MESSAGE only. An axios error carries the request config, and this
    // request's body is the service account's password.
    bump('token_mint_failed');
    // Naming the endpoint is the difference between "the provider is down" and
    // "the Secret points at the wrong provider", and the printable form is one
    // this line can afford to name. The MESSAGE only from the error itself.
    console.error(
      `[ENTITLEMENT] minting the OpenFGA token failed at ${printableEndpoint(config.endpoint)} — denying:`,
      (err as Error).message,
    );
    return null;
  }
}

/**
 * A live access token, or null. `nowMs` is injected so refresh timing is
 * testable without sleeping, exactly as the grant cache does it.
 */
export async function getOpenFgaToken(
  env: NodeJS.ProcessEnv,
  nowMs: number = Date.now(),
): Promise<string | null> {
  const config = oidcConfig(env);
  if (config === null) return null;

  if (cached !== null && nowMs < cached.refreshAtMs) {
    bump('token_cache_hit');
    return cached.token;
  }

  // One mint in flight. Set synchronously, before any await, so callers that
  // arrive in the same tick all find it.
  const pending = inflight;
  if (pending !== null) {
    bump('token_coalesced');
    inflightWaiters += 1;
    recordInflightPeak();
    return pending;
  }

  // Read BEFORE the flag is cleared, and before the mint is started: a cache
  // that still holds something reached its refresh point, an empty one either
  // was emptied by a forced refresh or was never filled.
  const reason: MintReason = cached !== null ? 'expired' : invalidateRequested ? 'forced' : 'cold';
  invalidateRequested = false;

  const run = mint(config, nowMs, reason);
  inflight = run;
  inflightWaiters = 1;
  recordInflightPeak();
  try {
    return await run;
  } finally {
    inflight = null;
    inflightWaiters = 0;
  }
}

/**
 * The Authorization header the Check should send.
 *
 * THREE ANSWERS, AND THE DIFFERENCE BETWEEN TWO OF THEM IS THE POINT:
 *   `{ authorization: … }`  present a credential
 *   `{}`                    no credential is configured; call anyway, which is
 *                           the documented unconfigured behaviour
 *   `undefined`             a credential WAS configured and could not be
 *                           obtained. Do not call at all — a 401 from OpenFGA
 *                           and a failed mint are the same outcome and
 *                           different causes, and only the caller can say which.
 */
export async function openFgaAuthHeaders(
  env: NodeJS.ProcessEnv,
  nowMs: number = Date.now(),
  options: { forceRefresh?: boolean } = {},
): Promise<Record<string, string> | undefined> {
  const mode = openFgaAuthMode(env);

  if (mode === 'none') return {};

  if (mode === 'static') return { authorization: `Bearer ${trimmed(env.OPENFGA_API_TOKEN)}` };

  if (trimmed(env.OPENFGA_API_TOKEN) !== '' && !warnedShadowedStatic) {
    warnedShadowedStatic = true;
    console.warn(
      '[ENTITLEMENT] both the OIDC provider and OPENFGA_API_TOKEN are set — the OIDC path wins and the preshared token is ignored. Unset OPENFGA_API_TOKEN so the active credential is unambiguous.',
    );
  }

  if (options.forceRefresh === true) invalidateOpenFgaToken();

  const token = await getOpenFgaToken(env, nowMs);
  if (token === null) return undefined;
  return { authorization: `Bearer ${token}` };
}
