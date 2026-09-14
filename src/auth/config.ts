// ============================================================================
// Edge authentication configuration, resolved ONCE at boot and FAIL-CLOSED.
//
// Everything here is a deployment setting, never a code change — the same rule
// db/pool.ts follows for TLS. Four variables are REQUIRED and have no default,
// because every plausible default is wrong in a way that is hard to see:
//
//   OIDC_ISSUER / OIDC_AUDIENCE     an unpinned issuer or audience accepts a
//                                   token minted for a different application.
//   OIDC_JWKS_URI                   guessing the path from the issuer works
//                                   until an Authentik release moves it, and
//                                   then fails at runtime rather than at boot.
//   COORDINATOR_PUBLIC_ORIGIN       the `htu` comparison MUST NOT come from the
//                                   Host header, which the caller controls: an
//                                   attacker who can set Host could otherwise
//                                   make any proof match any URL.
//
// TWO SETTINGS ARE DERIVED, NOT CONFIGURED:
//   jtiTtlMs = (proofMaxAge + clockSkew) * 1000 + 1000. The replay window must
//   cover the whole `iat` acceptance window; letting an operator set them
//   independently invites a configuration where an expiring jti still names an
//   acceptable proof. Deriving it removes the failure mode entirely.
//
//   THE + 1000 IS LOAD-BEARING, and it is the granularity mismatch between the
//   two rules. `iat` is a JWT numeric date and the check compares FLOORED
//   SECONDS, so a proof presented at the very start of second N by a client
//   whose clock runs the full accepted skew fast stays iat-valid until the end
//   of second N + maxAge + skew — up to 999 ms past the millisecond timer the
//   replay window prunes on. Without the extra second the jti is evicted while
//   the proof it names is still acceptable, and the SAME proof replays inside
//   that gap. Measured at 999 ms before the fix; zero after.
//
// ALGORITHMS ARE VALIDATED AGAINST AN ALLOWLIST at boot. A symmetric `alg` on
// the DPoP path would be catastrophic — the "public" JWK in the proof header
// would BE the verification key, so anyone could mint a proof for any key. That
// must fail at startup, loudly, not silently at the first request.
// ============================================================================

export type Env = Record<string, string | undefined>;

/** Asymmetric signature algorithms only. No HS*, no `none`, ever. */
const SUPPORTED_ALGORITHMS = new Set([
  'ES256', 'ES384', 'ES512',
  'PS256', 'PS384', 'PS512',
  'RS256', 'RS384', 'RS512',
  'EdDSA', 'Ed25519',
]);

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export interface AuthConfig {
  issuer: string;
  audience: string;
  jwksUri: URL;
  /** Scheme + host + port, exactly. The left-hand side of every `htu` check. */
  origin: string;
  oidcAlgorithms: string[];
  dpopAlgorithms: string[];
  proofMaxAgeSeconds: number;
  clockSkewSeconds: number;
  noncePeriodMs: number;
  jtiMaxEntries: number;
  /** DERIVED from proofMaxAgeSeconds + clockSkewSeconds. Never configured. */
  jtiTtlMs: number;
  deviceCacheTtlMs: number;
  requireNonce: boolean;
}

function required(env: Env, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${key} is required and has no safe default`);
  }
  return value.trim();
}

function positiveNumber(env: Env, key: string, fallback: number, options: { integer?: boolean; allowZero?: boolean } = {}): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  const floorOk = options.allowZero === true ? value >= 0 : value > 0;
  if (!Number.isFinite(value) || !floorOk || (options.integer === true && !Number.isInteger(value))) {
    throw new Error(`${key} must be a positive ${options.integer === true ? 'integer' : 'number'}, got '${raw}'`);
  }
  return value;
}

function algorithms(env: Env, key: string, fallback: string): string[] {
  const list = (env[key] ?? fallback)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  if (list.length === 0) throw new Error(`${key} must name at least one algorithm`);
  for (const alg of list) {
    if (!SUPPORTED_ALGORITHMS.has(alg)) {
      throw new Error(
        `${key} contains unsupported algorithm '${alg}'; only asymmetric signature algorithms are accepted`,
      );
    }
  }
  return list;
}

function boolean(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (raw.trim() === 'true') return true;
  if (raw.trim() === 'false') return false;
  throw new Error(`${key} must be 'true' or 'false', got '${raw}'`);
}

export function resolveAuthConfig(env: Env = process.env): AuthConfig {
  const issuer = required(env, 'OIDC_ISSUER');
  const audience = required(env, 'OIDC_AUDIENCE');

  const jwksRaw = required(env, 'OIDC_JWKS_URI');
  let jwksUri: URL;
  try {
    jwksUri = new URL(jwksRaw);
  } catch {
    throw new Error(`OIDC_JWKS_URI must be an absolute URL, got '${jwksRaw}'`);
  }
  // HTTPS, except to loopback — which is how a local test issuer is reached and
  // is not a network hop anyone can sit on.
  if (jwksUri.protocol !== 'https:' && !LOOPBACK.has(jwksUri.hostname)) {
    throw new Error(`OIDC_JWKS_URI must use https (got '${jwksUri.protocol}') unless it is loopback`);
  }

  const originRaw = required(env, 'COORDINATOR_PUBLIC_ORIGIN');
  let origin: URL;
  try {
    origin = new URL(originRaw);
  } catch {
    throw new Error(`COORDINATOR_PUBLIC_ORIGIN must be an absolute URL, got '${originRaw}'`);
  }
  if (origin.origin !== originRaw) {
    throw new Error(
      `COORDINATOR_PUBLIC_ORIGIN must be a bare origin with no path, query or trailing slash; got '${originRaw}'`,
    );
  }

  const proofMaxAgeSeconds = positiveNumber(env, 'DPOP_PROOF_MAX_AGE_SECONDS', 30);
  const clockSkewSeconds = positiveNumber(env, 'DPOP_CLOCK_SKEW_SECONDS', 5, { allowZero: true });

  return {
    issuer,
    audience,
    jwksUri,
    origin: origin.origin,
    oidcAlgorithms: algorithms(env, 'OIDC_ALGORITHMS', 'RS256,ES256,PS256'),
    dpopAlgorithms: algorithms(env, 'DPOP_ALGORITHMS', 'ES256,ES384,PS256,RS256'),
    proofMaxAgeSeconds,
    clockSkewSeconds,
    noncePeriodMs: positiveNumber(env, 'DPOP_NONCE_PERIOD_SECONDS', 300) * 1000,
    jtiMaxEntries: positiveNumber(env, 'DPOP_JTI_MAX_ENTRIES', 100_000, { integer: true }),
    // + 1000: see the header. Seconds-granularity iat vs ms-granularity eviction.
    jtiTtlMs: (proofMaxAgeSeconds + clockSkewSeconds) * 1000 + 1000,
    deviceCacheTtlMs: positiveNumber(env, 'DEVICE_CACHE_TTL_SECONDS', 5) * 1000,
    requireNonce: boolean(env, 'DPOP_REQUIRE_NONCE', true),
  };
}
