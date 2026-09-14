// ============================================================================
// The ONE seam onto @figurecollecting/fc-shared (plan §A.5).
//
// Every other module in src/ imports the shared baseline FROM HERE, never from
// the package directly — enforced by a test in shared.test.ts.
//
// The imports below are the 1.7.0 STATELESS SUBPATHS, not the barrel. The
// barrel is one esbuild bundle that also contains the axios client for legacy
// fc-backend and fc-mobile's zustand stores, so importing `getTraceContext`
// from it pulls axios, zustand and react into a Postgres-only service.
// test/import-graph.test.ts measures the real module graph of the built output
// in a child process and fails if any of the three is ever resolved again.
//
// Only stateless modules have subpaths in 1.7.0, and that is deliberate: the
// zustand stores hold module state, so a subpath for them could hand two
// importers two separate store instances. Nothing here holds state, except the
// logger's module-level config — which fc-shared tests for instance identity
// across both import paths.
//
// DELIBERATELY NOT IMPORTED (§A.5, "what it must NOT import"):
//   ./api/*    — the axios client for calling LEGACY fc-backend. The
//                coordinator serves; it never calls that. (No subpath exists.)
//   ./stores/* — fc-mobile's client-side zustand singletons. (No subpath.)
//   ./types    — a real 1.7.0 subpath, but nothing here needs it yet:
//                PaginatedResponse and friends arrive with slice 2, and
//                Figure/User are Mongo-shaped and never served from here.
// ============================================================================
export { getActiveTraceIds, getTraceContext } from '@figurecollecting/fc-shared/utils/trace';

export {
  DEFAULT_SECRET_VALUE_PATTERNS,
  DEFAULT_SENSITIVE_KEY_PATTERN,
  redactAttributes,
  redactString,
  redactValue,
} from '@figurecollecting/fc-shared/utils/sanitize';

export { configureLogger, sanitizeLogValue } from '@figurecollecting/fc-shared/utils/logger';

export type {
  AttributeValue,
  RedactOptions,
} from '@figurecollecting/fc-shared/utils/sanitize';

// ---------------------------------------------------------------------------
// LOCAL EXTENSION — DPoP (plan §A.4), carried forward from the slice-1a review.
//
// fc-shared's DEFAULT_SENSITIVE_KEY_PATTERN matches neither `dpop` nor
// `dpop_nonce`. For the PROOF that is survivable: a proof is a compact JWS, so
// the shared VALUE pattern (/eyJ[A-Za-z0-9._-]{10,}/) masks it wherever it
// appears. For the NONCE it is not: a nonce is opaque base64url, of a shape no
// value pattern can distinguish from an ordinary id or hash, so the KEY name is
// the ONLY thing that can catch it.
//
// Composed from the shared source rather than rewritten, so a future fc-shared
// release that adds a pattern is inherited automatically. `nonce` is included
// bare: it also covers an OIDC `nonce` claim, which is equally not for logs.
//
// A one-line fc-shared PR follows to move `dpop` into the shared baseline; this
// stays afterwards as the composition point, harmlessly duplicating it.
// ---------------------------------------------------------------------------
import {
  DEFAULT_SENSITIVE_KEY_PATTERN as SHARED_SENSITIVE_KEY_PATTERN,
  type RedactOptions as SharedRedactOptions,
} from '@figurecollecting/fc-shared/utils/sanitize';

// Anchored to the FINAL key segment on purpose. A bare `|dpop` alternative also
// swallows `app.dpop.attempts` and every other DPoP metric, which destroys the
// operational signal the redaction exists to protect. Matching only a key that
// IS the secret — `dpop`, `dpop_nonce`, `http.request.header.dpop` — keeps the
// counters legible and the values gone.
export const COORDINATOR_SENSITIVE_KEY_PATTERN = new RegExp(
  `${SHARED_SENSITIVE_KEY_PATTERN.source}|(?:^|[.\\-_])(?:dpop|nonce|dpop[-_]?nonce)$`,
  'i',
);

/** Pass these wherever fc-shared redaction is invoked from this service. */
export const COORDINATOR_REDACT_OPTIONS: SharedRedactOptions = {
  sensitiveKeyPattern: COORDINATOR_SENSITIVE_KEY_PATTERN,
};
