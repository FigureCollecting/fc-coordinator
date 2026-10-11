// ============================================================================
// Where display restrictions come from: the coordinator's display_restriction
// table (migration 0007). Data, never code (catalog.proto DISPLAY RESTRICTIONS).
//
// The table's CHECKs are the WRITER's rules (four scopes, three levels, a
// subject that is not empty and neither begins nor ends with white space); the
// reader takes every row verbatim and src/display/restrictions.ts fails closed
// on anything it does not recognise, so a row written around the CHECKs (a
// hand-edited dump, a later migration that relaxes one) still withholds.
//
// A PRODUCT subject names a head through the spine's ER: a restriction written
// against a product that has since merged covers the survivor's images. Every
// product subject (and every subject of an unrecognised level) shaped like a
// spine product id is resolved to the head it names today, once per cache
// period, so productIdsFor(head) lists the head and every such subject.
//
// One read per cache period (default 30 s): a restriction added now withholds
// within that period, and a client drops what a fresh list no longer carries.
// A failed read is never cached: the caller answers UNAVAILABLE and retries,
// and an image is never served unevaluated.
// ============================================================================
import { DISPLAY_LEVELS, foldAsciiCase, type DisplayRestriction } from './restrictions.js';

export interface DisplayRestrictionSet {
  readonly restrictions: readonly DisplayRestriction[];
  /** The head, then every restriction subject that resolves to it. */
  productIdsFor(headId: string): readonly string[];
}

export interface DisplayRestrictionSource {
  current(): Promise<DisplayRestrictionSet>;
}

/** Product ids (folded) -> the head each resolves to today; an id that resolves to nothing is absent. */
export type HeadResolver = (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;

export const DEFAULT_RESTRICTION_TTL_MS = 30_000;

const PRODUCT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const setOf = (restrictions: readonly DisplayRestriction[], aliases: ReadonlyMap<string, readonly string[]>): DisplayRestrictionSet => ({
  restrictions,
  productIdsFor: (headId) => [headId, ...(aliases.get(foldAsciiCase(headId)) ?? [])],
});

export const NO_DISPLAY_RESTRICTIONS: DisplayRestrictionSource = Object.freeze({
  current: async () => setOf([], new Map()),
});

/** The one query this needs: the coordinator's pool satisfies it. */
export interface RestrictionDb {
  query(text: string): Promise<{ rows: readonly unknown[] }>;
}

interface RestrictionRow {
  rule_id: string;
  level: string;
  subject: string;
  scope: string;
}

const SELECT = 'SELECT rule_id, level, subject, scope FROM display_restriction ORDER BY rule_id';

export function createDbDisplayRestrictionSource(options: {
  db: RestrictionDb;
  resolveHeads: HeadResolver;
  ttlMs?: number;
  now?: () => number;
}): DisplayRestrictionSource {
  const ttl = options.ttlMs ?? DEFAULT_RESTRICTION_TTL_MS;
  const now = options.now ?? (() => Date.now());
  let cached: { at: number; set: DisplayRestrictionSet } | null = null;
  let inFlight: Promise<DisplayRestrictionSet> | null = null;

  const load = async (): Promise<DisplayRestrictionSet> => {
    const rows = (await options.db.query(SELECT)).rows as readonly RestrictionRow[];
    const restrictions = rows.map((r) => ({ rule: r.rule_id, level: r.level, subject: r.subject, scope: r.scope }));
    const subjects = new Set<string>();
    for (const r of restrictions) {
      if (r.level === 'product' || !(DISPLAY_LEVELS as readonly string[]).includes(r.level)) {
        const folded = foldAsciiCase(r.subject);
        if (PRODUCT_ID.test(folded)) subjects.add(folded);
      }
    }
    const aliases = new Map<string, string[]>();
    if (subjects.size > 0) {
      const heads = await options.resolveHeads([...subjects]);
      for (const [subject, head] of heads) {
        const key = foldAsciiCase(head);
        if (key === subject) continue;
        aliases.set(key, [...(aliases.get(key) ?? []), subject]);
      }
    }
    return setOf(restrictions, aliases);
  };

  return {
    current: async () => {
      const at = now();
      if (cached !== null && at - cached.at < ttl) return cached.set;
      inFlight ??= load().finally(() => {
        inFlight = null;
      });
      const set = await inFlight;
      cached = { at, set };
      return set;
    },
  };
}
