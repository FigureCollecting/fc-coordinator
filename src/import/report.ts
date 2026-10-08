// import.proto FULL DISCREPANCY REPORT (Ross, 2026-10-05): every live copy MFC's latest export
// cannot account for, whatever kept it (an undo, a keep, per_copy, an acknowledged or dismissed
// item, richness). Per figure S and kind, the app's live copies of that kind beyond the export's
// Counts of it on S's rows, those whose row (by its origin) the export lacks or lists at Count 0
// first, then by occ id. So a copy kept against MFC's removal is counted until MFC counts it
// again, and one MFC has come to count on another row is not. `kept` names the knowing keeps of
// that figure and kind, which raise no align-MFC entry but are listed here.
//
// The server half only: contract 0.3.0 defines no RPC that carries the report ("when the contract
// adds one"), so nothing serves it yet.
import { bytewise, KINDS, View, type Row } from './figure.js';
import type { Kind } from './rows.js';
import type { SqlClient } from '../sync/store.js';
import type { KeptCopy } from './plan.js';

export interface Discrepancy {
  head: string;
  kind: Kind;
  /** The app's live copies of the kind. */
  app: number;
  /** The export's Counts of the kind on the figure's rows. */
  mfc: number;
  /** As many copies as the export cannot account for, in the report's order. */
  copies: string[];
  /** The figure's copies of the kind kept against MFC's removal. */
  kept: string[];
}

export function discrepancies(v: View, rows: readonly Row[], kept: ReadonlyMap<string, KeptCopy>): Discrepancy[] {
  const counted = new Map(rows.map((r) => [r.id, r.count]));
  const heads = new Set(rows.map((r) => r.head));
  for (const c of v.copies.values()) if (c.head !== null) heads.add(c.head);
  const out: Discrepancy[] = [];
  for (const S of [...heads].sort(bytewise)) {
    for (const k of KINDS) {
      const live = v.copiesOf(S).filter((c) => v.curKind(c, S) === k);
      const mfc = rows.filter((r) => r.head === S && r.kind === k).reduce((n, r) => n + r.count, 0);
      if (live.length <= mfc) continue;
      const uncounted = (c: string) => {
        const id = v.copies.get(c)!.origin?.id;
        return id !== undefined && (counted.get(id) ?? 0) === 0;
      };
      const order = [...live.filter(uncounted), ...live.filter((c) => !uncounted(c))];
      out.push({
        head: S,
        kind: k,
        app: live.length,
        mfc,
        copies: order.slice(0, live.length - mfc),
        kept: live.filter((c) => kept.get(c)?.kind === k),
      });
    }
  }
  return out;
}

/** The report for a user now: their copies against the rows of their latest import. */
export async function readDiscrepancyReport(db: SqlClient, userId: string): Promise<Discrepancy[]> {
  const facets = await db.query<{ facet_key: string; version: string; op: 'upsert' | 'delete'; payload: string }>(
    "SELECT facet_key, version, op, payload FROM facet_state WHERE user_id = $1 AND facet_key LIKE 'occ/%'",
    [userId],
  );
  const rows = await db.query<{ mfc_id: string; head_id: string; kind: Kind; count: number }>(
    'SELECT mfc_id, head_id, kind, count FROM import_export_row WHERE user_id = $1',
    [userId],
  );
  const kept = await db.query<{ occ_id: string; head_id: string; kind: Kind }>('SELECT occ_id, head_id, kind FROM import_kept_copy WHERE user_id = $1', [userId]);
  const v = new View({
    facets: new Map(facets.rows.map((r) => [r.facet_key, { facetKey: r.facet_key, version: r.version, op: r.op, payload: r.payload }])),
    rowBases: new Map(),
    copyBases: new Map(),
    fieldBases: new Map(),
  });
  return discrepancies(
    v,
    rows.rows.map((r) => ({ id: r.mfc_id, head: r.head_id, kind: r.kind, count: r.count, fields: {} })),
    new Map(kept.rows.map((r) => [r.occ_id, { head: r.head_id, kind: r.kind }])),
  );
}
