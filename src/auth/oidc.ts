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
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

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
}

/**
 * The production key resolver. jose refetches on an unknown `kid` (rate-limited
 * by the cooldown), so ROTATION needs no restart and no configuration: publish
 * the new key in Authentik, and the first token signed with it pulls the set.
 */
export function createRemoteJwks(url: URL, options: RemoteJwksOptions = {}): JWTVerifyGetKey {
  return createRemoteJWKSet(url, {
    cacheMaxAge: options.cacheMaxAgeMs ?? 600_000,
    cooldownDuration: options.cooldownMs ?? 30_000,
    timeoutDuration: options.timeoutMs ?? 5_000,
  });
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
