/**
 * subject.ts — WHAT COUNTS AS A SUBJECT, in one place, for the whole module.
 *
 * THE SUBJECT IS AN AUTHENTIK USER UUID. Not a numeric pk, not an email, not a
 * username, and not this or any other application's own user id. That is what
 * fc-infra's `grant-inventory-levels.sh` writes as
 * `app:figurecollecting#inventory_levels_direct@user:<uuid>`, and what the
 * assertion's `sub` must carry for the two sides to be talking about the same
 * person.
 *
 * WHY IT IS ENFORCED AND NOT MERELY DOCUMENTED. OpenFGA stores a subject string
 * VERBATIM and never resolves it. A wrong-shaped subject is therefore not an
 * error at any layer: the Check returns `false` for a user id that will never
 * exist, the caller dutifully sends no header, and the read comes back with the
 * numbers quietly missing. Every symptom points at the gate and none points at
 * the identifier. Meanwhile the WRITE side does refuse a non-uuid, so an
 * unguarded read side is an asymmetry that can only ever be discovered the
 * hard way.
 *
 * IT IS ALSO THE MODULE'S ONLY STATEMENT ABOUT IDENTITY. Everything upstream of
 * the uuid — a session claim, a database lookup, an OIDC subject — belongs to
 * the host application and differs between the one this runs in today and the
 * one it is destined for. A host that hands over the wrong kind of identifier
 * gets told so here, at the boundary, rather than by its users.
 *
 * BYTES ARE BOUNDED BY THE SHAPE, deliberately. A uuid is 36 characters, so an
 * accepted subject can never produce a header near the verifier's 4096-byte
 * limit — no separate length check is needed, and adding one would be a guard
 * that can never fire. Relax the pattern and the bound goes with it.
 *
 * CASE IS PRESERVED, NEVER FOLDED. Both spellings are accepted because both are
 * legal uuids, but the value is passed on verbatim: OpenFGA compares subjects
 * byte for byte, and an identifier that folds two spellings onto one turns two
 * people into one.
 */

/** The accepted subject shape. Same expression as fc-infra `grant-inventory-levels.sh`. */
export const ENTITLEMENT_SUBJECT_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Is this a usable entitlement subject?
 *
 * Takes `unknown` on purpose. The module is published as a portable unit and
 * will be called from code TypeScript has not checked; a type annotation is not
 * a runtime guarantee, and this is the boundary where that stops being an
 * academic point.
 */
export function isEntitlementSubject(value: unknown): value is string {
  return typeof value === 'string' && ENTITLEMENT_SUBJECT_PATTERN.test(value);
}
