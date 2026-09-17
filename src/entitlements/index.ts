/**
 * src/entitlements — THE PORTABLE ENTITLEMENT MODULE.
 *
 * PORTED FROM fc-backend `src/services/entitlements/` (D6 U6, PR #249, merged at
 * c82fb05) as a DIRECTORY COPY, per plan §C slice 1 item 3. The only edits the
 * port needed were ESM `.js` import specifiers and this header: every rule,
 * every guard and every counter below is the reviewed original. fc-backend's
 * copy is retiring, so this is now the module's single home.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS DIRECTORY IS SELF-CONTAINED AND PORTS VERBATIM.
 *
 * It imports node builtins, `axios`, and `@figurecollecting/ingest-contract`.
 * NOTHING ELSE — no database driver, no ORM, no user model, no application
 * config, no logger of this app's (which is why it writes to `console` and not
 * to platform/logger). It is a directory copy away from its next host, and
 * test/entitlements/portability.test.ts fails the build if that stops being
 * true.
 *
 * WHY THE LINE IS DRAWN HERE. The one thing that genuinely differs between the
 * backend this came from and the one it now runs in is HOW A LOGGED-IN USER
 * BECOMES AN AUTHENTIK UUID. In fc-backend that was a lookup against a Mongo
 * user document; HERE it is the verified OIDC subject, handed over by the
 * identity resolver in src/connect/identity.ts. Everything downstream of that
 * uuid — the Check, the cache, the signature, the header — is identical in
 * both. So the uuid is the seam, and this module starts on the far side of it:
 * it accepts a subject STRING and never asks where it came from.
 *
 * WHAT THE PORT DELETED, rather than carried across:
 *   src/services/entitlementSubject.legacy.ts   the Mongo lookup — GONE
 *   src/models/User.ts `authentikId`            the field it read — GONE
 * The subject now comes straight from the identity resolver, which is the one
 * line the port replaces. The header-attaching client came across too, as
 * src/spine/spineReadClient.ts; it is outside this directory only because it
 * predates it and because it now carries the traceparent interceptor, which
 * this module must never know about.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * USAGE, whole:
 *
 *   import { entitlementHeaderFor, initEntitlementSigning } from './entitlements/index.js';
 *
 *   initEntitlementSigning();                       // once, at boot
 *   const assertion = await entitlementHeaderFor(authentikUuid);
 *   await spineRead.compare(seed, nowIso, assertion);   // null => no header
 *
 * THE SUBJECT IS AN AUTHENTIK USER UUID and the module enforces it — see
 * ./subject.ts. `isEntitlementSubject` is exported so a host application can
 * check its own identity source against the same rule instead of discovering
 * the mismatch as numbers that quietly fail to appear.
 */
export {
  entitlementHeaderFor,
  grantsForSubject,
  entitlementGrantCounters,
  resetEntitlementGrantsForTest,
} from './grants.js';

export { isEntitlementSubject, ENTITLEMENT_SUBJECT_PATTERN } from './subject.js';

export {
  mintEntitlementAssertion,
  initEntitlementSigning,
  entitlementMintCounters,
  resetEntitlementSigningForTest,
  type MintRequest,
} from './assertion.js';

export {
  initOpenFgaAuth,
  describeOpenFgaAuth,
  openFgaAuthMode,
  openFgaTokenCounters,
  resetOpenFgaTokenForTest,
  type OpenFgaAuthMode,
} from './openfgaToken.js';
