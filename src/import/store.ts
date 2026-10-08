// SQL over migrations/0005_import.sql, run inside the import's transaction under lockUser.
import type { Facet, SqlClient } from '../sync/store.js';
import type { Comps, CopyBase, FigureItem, ImportState, Row } from './plan.js';
import type { Field } from './rows.js';

interface FacetRow {
  facet_key: string;
  version: string;
  op: 'upsert' | 'delete';
  payload: string;
}

/** The user's state an import decides on: the facets it reads, the bases and the pending items. */
export async function readImportState(tx: SqlClient, userId: string): Promise<ImportState> {
  const facets = await tx.query<FacetRow>(
    `SELECT facet_key, version, op, payload FROM facet_state
      WHERE user_id = $1 AND (facet_key LIKE 'occ/%' OR facet_key LIKE 'uf/%' OR facet_key LIKE 'imp/mfc/figure/%' OR facet_key LIKE 'res/mfc/%')`,
    [userId],
  );
  const rowBases = await tx.query<{ mfc_id: string; head_id: string; kind: Row['kind']; count: number; fields: Row['fields'] }>(
    'SELECT mfc_id, head_id, kind, count, fields FROM import_row_base WHERE user_id = $1',
    [userId],
  );
  const copyBases = await tx.query<{ occ_id: string; head_id: string; kind: CopyBase['kind'] }>(
    'SELECT occ_id, head_id, kind FROM import_copy_base WHERE user_id = $1',
    [userId],
  );
  const fieldBases = await tx.query<{ head_id: string; field: Field; value: number | string | null }>(
    'SELECT head_id, field, value FROM import_field_base WHERE user_id = $1',
    [userId],
  );
  const items = await tx.query<{ head_id: string; rev: string; raised_import: number; side: string; comps: Comps }>(
    'SELECT head_id, rev, raised_import, side, comps FROM import_figure_item WHERE user_id = $1',
    [userId],
  );
  const byHead = new Map<string, Map<Field, number | string | null>>();
  for (const b of fieldBases.rows) byHead.set(b.head_id, (byHead.get(b.head_id) ?? new Map()).set(b.field, b.value));
  return {
    facets: new Map(
      facets.rows.map((r): [string, Facet] => [r.facet_key, { facetKey: r.facet_key, version: r.version, op: r.op, payload: r.payload }]),
    ),
    rowBases: new Map(rowBases.rows.map((r) => [r.mfc_id, { id: r.mfc_id, head: r.head_id, kind: r.kind, count: r.count, fields: r.fields }])),
    copyBases: new Map(copyBases.rows.map((r) => [r.occ_id, { head: r.head_id, kind: r.kind }])),
    fieldBases: byHead,
    items: new Map(
      items.rows.map((r): [string, FigureItem] => [r.head_id, { head: r.head_id, rev: r.rev, raised: r.raised_import, side: r.side, comps: r.comps }]),
    ),
  };
}

/** The user's last import number; 0 before the first. */
export async function lastImportNumber(tx: SqlClient, userId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>('SELECT coalesce(max(import_number), 0) AS n FROM import_run WHERE user_id = $1', [userId]);
  return rows[0]!.n;
}

export interface RunRecord {
  importNumber: number;
  exportDate: string;
  version: string;
  markerSeq: bigint;
  figures: readonly string[];
  /** The framed figures it wrote to or moved a base of. */
  settled: readonly string[];
}

/** Record an import and the figures it framed, each with whether it settled it. */
export async function recordRun(tx: SqlClient, userId: string, run: RunRecord): Promise<void> {
  await tx.query('INSERT INTO import_run (user_id, import_number, export_date, version, marker_seq) VALUES ($1, $2, $3, $4, $5)', [
    userId,
    run.importNumber,
    run.exportDate,
    run.version,
    run.markerSeq.toString(),
  ]);
  await tx.query(
    'INSERT INTO import_frame (user_id, import_number, head_id, settled) SELECT $1, $2, h, h = ANY($4::uuid[]) FROM unnest($3::uuid[]) AS h',
    [userId, run.importNumber, run.figures, run.settled],
  );
}

/** Move the bases a settlement moved, and the pending figure items. */
export async function saveBases(
  tx: SqlClient,
  userId: string,
  importNumber: number,
  bases: {
    rows: readonly Row[];
    copies: ReadonlyMap<string, CopyBase>;
    fields: readonly { head: string; field: Field; value: number | string | null }[];
    items: { set: readonly FigureItem[]; end: readonly string[] };
  },
): Promise<void> {
  if (bases.rows.length > 0) {
    await tx.query(
      `INSERT INTO import_row_base (user_id, mfc_id, head_id, kind, count, fields, import_number)
       SELECT $1, r.mfc_id, r.head_id, r.kind, r.count, r.fields, $2
         FROM unnest($3::text[], $4::uuid[], $5::text[], $6::int[], $7::jsonb[]) AS r(mfc_id, head_id, kind, count, fields)
       ON CONFLICT (user_id, mfc_id) DO UPDATE
         SET head_id = EXCLUDED.head_id, kind = EXCLUDED.kind, count = EXCLUDED.count, fields = EXCLUDED.fields, import_number = EXCLUDED.import_number`,
      [
        userId,
        importNumber,
        bases.rows.map((r) => r.id),
        bases.rows.map((r) => r.head),
        bases.rows.map((r) => r.kind),
        bases.rows.map((r) => r.count),
        bases.rows.map((r) => JSON.stringify(r.fields)),
      ],
    );
  }
  if (bases.copies.size > 0) {
    const copies = [...bases.copies];
    await tx.query(
      `INSERT INTO import_copy_base (user_id, occ_id, head_id, kind)
       SELECT $1, c.occ_id, c.head_id, c.kind FROM unnest($2::uuid[], $3::uuid[], $4::text[]) AS c(occ_id, head_id, kind)
       ON CONFLICT (user_id, occ_id) DO UPDATE SET head_id = EXCLUDED.head_id, kind = EXCLUDED.kind`,
      [userId, copies.map(([occ]) => occ), copies.map(([, b]) => b.head), copies.map(([, b]) => b.kind)],
    );
  }
  if (bases.fields.length > 0) {
    await tx.query(
      `INSERT INTO import_field_base (user_id, head_id, field, value)
       SELECT $1, f.head_id, f.field, f.value FROM unnest($2::uuid[], $3::text[], $4::jsonb[]) AS f(head_id, field, value)
       ON CONFLICT (user_id, head_id, field) DO UPDATE SET value = EXCLUDED.value`,
      [userId, bases.fields.map((f) => f.head), bases.fields.map((f) => f.field), bases.fields.map((f) => JSON.stringify(f.value))],
    );
  }
  for (const item of bases.items.set) {
    await tx.query(
      `INSERT INTO import_figure_item (user_id, head_id, rev, raised_import, side, comps) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, head_id) DO UPDATE
         SET rev = EXCLUDED.rev, raised_import = EXCLUDED.raised_import, side = EXCLUDED.side, comps = EXCLUDED.comps`,
      [userId, item.head, item.rev, item.raised, item.side, JSON.stringify(item.comps)],
    );
  }
  if (bases.items.end.length > 0) {
    await tx.query('DELETE FROM import_figure_item WHERE user_id = $1 AND head_id = ANY($2::uuid[])', [userId, bases.items.end]);
  }
}
