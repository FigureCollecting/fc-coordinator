// ============================================================================
// THE IDENTITY SEAM — one declaration, read by two branches.
//
// The OIDC + DPoP edge decides whether a request is authentic and whose it is.
// The entitlement path decides what that person may see. They share exactly one
// value, the Authentik uuid, and `sub` is that same uuid in the OIDC token, in
// the OpenFGA tuple, in the minted assertion and in `app_user.id` (plan §A.2).
//
// THIS FILE EXISTS BECAUSE THE TWO SIDES WERE BUILT ON SEPARATE BRANCHES and
// each had its own string literal for the property name. They did not match.
// The failure mode is silent and safe-looking: the entitlement resolver finds
// nothing, every caller reads as unauthenticated, and every Compare comes back
// redacted — indistinguishable from a real denial, with both unit suites green
// because each side tests through its own fake. One constant and one interface,
// imported by both, makes that disagreement impossible to reintroduce.
//
// It deliberately imports NOTHING but Fastify's types: neither the auth module
// nor the connect module may depend on the other, and this is the only thing
// they are allowed to share.
// ============================================================================

/**
 * The Fastify request property the edge decorates and the entitlement path
 * reads. Never write the literal anywhere else.
 */
export const CALLER_IDENTITY_DECORATOR = 'callerIdentity';

/** The minimum the entitlement path needs. It reads `sub` and nothing else. */
export interface CallerIdentity {
  /** The Authentik user uuid. Passed on VERBATIM — never trimmed, never folded. */
  sub: string;
}

/**
 * What the DPoP edge actually establishes: the subject, plus which device
 * proved it. The entitlement path ignores the extra fields; the edge needs them
 * for revocation and for its own diagnostics. ONE property carries both, so the
 * two branches never decorate the same request twice.
 */
export interface AuthenticatedCaller extends CallerIdentity {
  /**
   * The enrolled device that signed the proof.
   *
   * `null` in exactly ONE place: inside the enrolment bootstrap, between the
   * proof being verified and the device row existing. Every guarded route sees
   * a string.
   */
  deviceId: string | null;
  /** RFC 7638 thumbprint of the device key that signed this request's proof. */
  jkt: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** `null` until the edge authenticates the request. */
    callerIdentity: AuthenticatedCaller | null;
  }
}
