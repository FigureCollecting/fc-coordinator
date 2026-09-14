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
