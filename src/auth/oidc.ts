// ============================================================================
// OIDC access-token verification against Authentik (plan §A.4, "Identity").
//
// This service holds NO credential material. Authentik proves WHO; the DPoP
// device key (dpop.ts) proves WHICH DEVICE. All this module does is verify the
// access token's signature against the issuer's JWKS and pin issuer, audience
// and algorithm.
//
// THE SUBJECT IS A UUID, ALWAYS. `app_user.id` IS the Authentik uuid (§B.1),
// which is also the entitlement `sub` and the OpenFGA subject. Authentik will
// happily be configured to put a numeric pk or an email in `sub`; either would
// silently create a second, parallel identity space and make every downstream
// authorization decision wrong. A non-uuid subject is REJECTED here rather than
// stored.
//
// BINDING, path B (plan §A.4): Authentik 2026.5.4 pops `cnf` before encoding an
// access token, so no token carries `cnf.jkt` today and the device binding
// comes from the enrolment table. `cnfJkt` is surfaced anyway: the day an
// Authentik does issue it, binding.ts prefers it with no flag day and no
// re-enrolment.
// ============================================================================
import * as http from 'node:http';
import * as https from 'node:https';
// TYPE ONLY: erased at runtime, so the edge takes no dependency on the
// entitlement module's graph to describe a path the entitlement module defines.
import type { IdpPath } from '../entitlements/index.js';
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type FetchImplementation,
  type JWTVerifyGetKey,
  type RemoteJWKSet,
} from 'jose';

/** RFC 4122 shape, version-agnostic: a v7 uuid from a future Authentik must pass. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VerifiedAccessToken {
  /** The Authentik uuid. Never logged, never put on a span. */
  sub: string;
  /** RFC 9449 confirmation thumbprint, when a future IdP binds the token. */
  cnfJkt?: string;
  expiresAt?: number;
}

export type AccessTokenFailure =
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'expired'
  | 'not_yet_valid'
  | 'subject_not_uuid';

export type AccessTokenResult =
  | { ok: true; token: VerifiedAccessToken }
  | { ok: false; reason: AccessTokenFailure };

export interface AccessTokenVerifierOptions {
  /** Key resolver. Production: createRemoteJwks. Tests: a local JWKS. */
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
  algorithms: string[];
  clockToleranceSeconds?: number;
}

export interface RemoteJwksOptions {
  /** How long a fetched JWKS is reused. */
  cacheMaxAgeMs?: number;
  /** Minimum gap between refetches triggered by an unknown kid. */
  cooldownMs?: number;
  timeoutMs?: number;
  /**
   * Sent with every JWKS fetch. Normally empty; on the in-cluster Authentik
   * mirror it carries the PUBLIC authority, because the identity provider
   * derives the issuer it advertises from the request. Produced by
   * `resolveIdpPath` — never assembled here.
   */
  headers?: Readonly<Record<string, string>>;
}

/**
 * NODE'S FETCH SILENTLY DROPS A `Host` HEADER, which is the whole reason this
 * function exists. `host` is a forbidden header name in the Fetch standard, so
 * undici — which is what jose fetches through, including via jose's own
 * `headers` option — removes it without erroring. Measured against a real
 * socket on this Node before anything was written:
 *
 *   global fetch   host: 127.0.0.1:45207   x-forwarded-proto: https
 *   jose headers   host: 127.0.0.1:45207   x-forwarded-proto: https
 *   node:http      host: auth.example.com  x-forwarded-proto: https
 *
 * `X-Forwarded-Proto` gets through and `Host` does not, so the option alone
 * would produce a fetch that looks configured and mints the wrong issuer.
 *
 * WHAT THIS REPLACES, AND WHAT IT DOES NOT. Only the TRANSPORT. jose's
 * `[customFetch]` seam is called at exactly the points jose decides to fetch,
 * so the cache age, the unknown-kid cooldown, the rotation refetch, the
 * single-flight and the timeout all stay inside jose and are unchanged — the
 * alternative the brief offered, fetching the set ourselves and handing it to
 * `createLocalJWKSet`, would have moved every one of those into this file.
 * Pinned by the four cases in oidc.test.ts that exercise them THROUGH this
 * substitution.
 *
 * `redirect: 'manual'` is honoured by not following one: node:http does not
 * follow redirects, and a 3xx therefore arrives as a non-200 that jose
 * rejects. That matters more here than anywhere else in the service — the JWKS
 * is the set of keys every access token is verified against, so a followed
 * redirect is a key-substitution primitive.
 */
function meshFetch(): FetchImplementation {
  return async (url, options) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    // ONE ROUTE FOR THE HEADERS, and it is jose's. An earlier version also
    // merged its own copy on top, which was defence in depth against a hazard
    // that cannot occur as wired — and the cost was that three mutations
    // (drop our merge, drop the option, swap the order) all survived the whole
    // suite, because either route alone still delivered the header. Two
    // mechanisms that cannot be told apart are one mechanism and one place for
    // a future edit to go wrong unobserved.
    const headers: Record<string, string> = {};
    for (const [name, value] of options.headers) headers[name] = value;

    return await new Promise<Response>((resolve, reject) => {
      const request = client.request(
        target,
        { method: options.method, headers, signal: options.signal },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('error', reject);
          response.on('end', () => {
            // A Response carries `status` and `json()`, which is all jose uses,
            // and rebuilding it here keeps the contract jose declares rather
            // than a duck-typed stand-in that drifts from it.
            resolve(
              new Response(Buffer.concat(chunks), {
                // `?? 502` is the ONE branch in this function no test reaches,
                // and it is disclosed rather than chased: node always sets a
                // status on a response it delivered, but the type allows
                // `undefined` because IncomingMessage is shared with the
                // request side. Deleting the fallback to make a number go up
                // would trade a compile-time guarantee for a coverage line.
                status: response.statusCode ?? 502,
                headers: { 'content-type': response.headers['content-type'] ?? 'application/json' },
              }),
            );
          });
        },
      );
      // REJECT WITH THE SIGNAL'S OWN REASON WHEN IT FIRED. jose maps a timeout
      // BY NAME — `err.name === 'TimeoutError'` — and node's abort surfaces as
      // `AbortError` with the TimeoutError demoted to `cause`, so a timeout on
      // this path arrived as ERR_ABORT rather than jose's ERR_JWKS_TIMEOUT. The
      // budget was always right to the millisecond; the identity was not, and a
      // replacement transport should not quietly change the error taxonomy of
      // the thing it replaces. `AbortSignal.timeout().reason` is a DOMException
      // named TimeoutError, which is exactly what jose looks for.
      request.on('error', (err) =>
        reject(options.signal.aborted ? (options.signal.reason as Error) : err),
      );
      request.end();
    });
  };
}

/**
 * The production key resolver. jose refetches on an unknown `kid` (rate-limited
 * by the cooldown), so ROTATION needs no restart and no configuration: publish
 * the new key in Authentik, and the first token signed with it pulls the set.
 *
 * Returns jose's `RemoteJWKSet`, which is a `JWTVerifyGetKey` and also carries
 * `reload`, `fresh` and `coolingDown` — the state a test has to read to prove
 * the cache still behaves through the transport substitution below.
 */
export function createRemoteJwks(url: URL, options: RemoteJwksOptions = {}): RemoteJWKSet {
  // LOWER-CASED FIRST, because the decision below is a lookup and HTTP header
  // names are case-insensitive. `resolveIdpPath` always lower-cases, so
  // production was never exposed — but this function is exported with an
  // unconstrained `headers` option, and a caller who spelled it `Host`, the way
  // HTTP prints it, fell back to undici and had the header stripped: the exact
  // configured-looking silent failure this whole unit exists to prevent.
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  // The substitution is installed ONLY when a `host` is asked for. Every other
  // deployment keeps jose's own fetch, byte for byte, so the public path is not
  // quietly moved onto a transport this repo maintains.
  const transport = headers['host'] === undefined ? {} : { [customFetch]: meshFetch() };
  return createRemoteJWKSet(url, {
    cacheMaxAge: options.cacheMaxAgeMs ?? 600_000,
    cooldownDuration: options.cooldownMs ?? 30_000,
    timeoutDuration: options.timeoutMs ?? 5_000,
    headers,
    ...transport,
  });
}

/**
 * THE PRODUCTION WIRING, IN A PLACE A TEST CAN SEE IT.
 *
 * This is one expression, and it used to live in src/server.ts — which is
 * excluded from the coverage gate as "the process entrypoint, listen/SIGTERM
 * wiring with no logic of its own". That stopped being true the moment the
 * entrypoint carried the decision that makes the mirrored JWKS fetch work:
 * deleting the headers there left all 819 tests green, because the end-to-end
 * test re-typed the same expression by hand instead of calling it.
 *
 * So the expression is here, both callers use it, and the mutation goes red.
 * It also takes `path.url` rather than a separately-passed URL, which removes
 * the way the target and its headers could ever disagree.
 */
export function createJwksFor(
  path: IdpPath,
  options: Omit<RemoteJwksOptions, 'headers'> = {},
): RemoteJWKSet {
  return createRemoteJwks(path.url, { ...options, headers: path.headers });
}

/** Map jose's error taxonomy onto our reasons. Never surfaced to the client. */
function classify(error: unknown): AccessTokenFailure {
  const claim = (error as { claim?: unknown }).claim;
  const code = (error as { code?: unknown }).code;
  if (code === 'ERR_JWT_EXPIRED') return 'expired';
  if (claim === 'iss') return 'wrong_issuer';
  if (claim === 'aud') return 'wrong_audience';
  if (claim === 'exp') return 'expired';
  if (claim === 'nbf') return 'not_yet_valid';
  return 'bad_signature';
}

export type AccessTokenVerifier = (token: string) => Promise<AccessTokenResult>;

export function createAccessTokenVerifier(options: AccessTokenVerifierOptions): AccessTokenVerifier {
  return async (token) => {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(token, options.jwks, {
        issuer: options.issuer,
        audience: options.audience,
        algorithms: options.algorithms,
        clockTolerance: options.clockToleranceSeconds ?? 5,
      }));
    } catch (error) {
      return { ok: false, reason: classify(error) };
    }

    const sub = payload['sub'];
    if (typeof sub !== 'string' || !UUID.test(sub)) {
      return { ok: false, reason: 'subject_not_uuid' };
    }

    const cnf = payload['cnf'];
    const cnfJkt =
      typeof cnf === 'object' && cnf !== null && typeof (cnf as { jkt?: unknown }).jkt === 'string'
        ? (cnf as { jkt: string }).jkt
        : undefined;

    return {
      ok: true,
      token: {
        sub,
        ...(cnfJkt !== undefined ? { cnfJkt } : {}),
        ...(typeof payload['exp'] === 'number' ? { expiresAt: payload['exp'] } : {}),
      },
    };
  };
}
