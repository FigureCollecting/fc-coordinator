// ============================================================================
// The ONE seam onto @figurecollecting/fc-shared (plan §A.5).
//
// Every other module in src/ imports the shared baseline FROM HERE, never from
// the package directly — enforced by a test in shared.test.ts. Two reasons:
//
//   1. fc-shared 1.6.0 exports only the barrel ("." and "./package.json"), so
//      importing `getTraceContext` from it drags in axios, zustand and — via
//      zustand — react, none of which belong in a Postgres-only service. Today
//      that cost is paid once, here.
//   2. fc-shared 1.7.0 adds the stateless subpaths ./utils/trace,
//      ./utils/sanitize, ./utils/logger and ./types. Switching to them is then
//      a one-file change with no call sites to chase.
//
// TODO(fc-shared 1.7.0): replace the single barrel import below with the four
// subpath imports, and replace tsconfig.json's inlined compilerOptions with
// "extends": "@figurecollecting/fc-shared/tsconfig.base.json".
//
// DELIBERATELY NOT RE-EXPORTED (§A.5, "what it must NOT import"):
//   api/client, api/figures, api/scraper, api/transforms — the axios client for
//     calling LEGACY fc-backend. The coordinator serves; it never calls that.
//   stores/auth, stores/sync — fc-mobile's client-side zustand singletons.
//   Figure, User — Mongo-shaped (`_id`, "Schema v3.0"); never served from here.
// ============================================================================
export {
  configureLogger,
  DEFAULT_SECRET_VALUE_PATTERNS,
  DEFAULT_SENSITIVE_KEY_PATTERN,
  getActiveTraceIds,
  getTraceContext,
  redactAttributes,
  redactString,
  redactValue,
  sanitizeLogValue,
} from '@figurecollecting/fc-shared';

export type { AttributeValue, RedactOptions } from '@figurecollecting/fc-shared';
