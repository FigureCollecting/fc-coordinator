// SQL over migrations/0005_import.sql and 0006_import_reimport.sql, run inside the import's or the
// Push's transaction under lockUser.
import type { Facet, SqlClient } from '../sync/store.js';
import type { Comps, CopyBase, FigureItem, ImportState, KeptCopy, Row } from './plan.js';
import type { FrameBefore } from './replay.js';
import type { Field } from './rows.js';

interface FacetRow {
  facet_key: string;
  version: string;
  op: 'upsert' | 'delete';
  payload: string;
}

type RowBaseRow = { mfc_id: string; head_id: string; kind: Row['kind']; count: number; fields: Row['fields'] };
type CopyBaseRow = { occ_id: string; head_id: string; kind: CopyBase['kind']; import_removed: boolean };
type FieldBaseRow = { head_id: string; field: Field; value: number | string | null };
type ItemRow = { head_id: string; rev: string; raised_import: number; side: string; comps: Comps };
type KeptRow = { occ_id: string; head_id: string; kind: KeptCopy['kind'] };

function assemble(facets: FacetRow[], rowBases: RowBaseRow[], copyBases: CopyBaseRow[], fieldBases: FieldBaseRow[], items: ItemRow[], kept: KeptRow[]): ImportState {
  const byHead = new Map<string, Map<Field, number | string | null>>();
  for (const b of fieldBases) byHead.set(b.head_id, (byHead.get(b.head_id) ?? new Map()).set(b.field, b.value));
  return {
    facets: new Map(facets.map((r): [string, Facet] => [r.facet_key, { facetKey: r.facet_key, version: r.version, op: r.op, payload: r.payload }])),
    rowBases: new Map(rowBases.map((r) => [r.mfc_id, { id: r.mfc_id, head: r.head_id, kind: r.kind, count: r.count, fields: r.fields }])),
    copyBases: new Map(copyBases.map((r) => [r.occ_id, { head: r.head_id, kind: r.kind, removed: r.import_removed }])),
    fieldBases: byHead,
    items: new Map(items.map((r): [string, FigureItem] => [r.head_id, { head: r.head_id, rev: r.rev, raised: r.raised_import, side: r.side, comps: r.comps }])),
    kept: new Map(kept.map((r) => [r.occ_id, { head: r.head_id, kind: r.kind }])),
  };
}

const ROW_BASES = 'SELECT mfc_id, head_id, kind, count, fields FROM import_row_base WHERE user_id = $1';
const COPY_BASES = 'SELECT occ_id, head_id, kind, import_removed FROM import_copy_base WHERE user_id = $1';
const FIELD_BASES = 'SELECT head_id, field, value FROM import_field_base WHERE user_id = $1';
const ITEMS = 'SELECT head_id, rev, raised_import, side, comps FROM import_figure_item WHERE user_id = $1';
const KEPT = 'SELECT occ_id, head_id, kind FROM import_kept_copy WHERE user_id = $1';

/** The user's whole state an import decides on: the facets it reads, the bases, items and keeps. */
export async function readImportState(tx: SqlClient, userId: string): Promise<ImportState> {
  const facets = await tx.query<FacetRow>(
    `SELECT facet_key, version, op, payload FROM facet_state
      WHERE user_id = $1 AND (facet_key LIKE 'occ/%' OR facet_key LIKE 'uf/%' OR facet_key LIKE 'imp/mfc/figure/%' OR facet_key LIKE 'imp/mfc/change/%')`,
    [userId],
  );
  return assemble(
    facets.rows,
    (await tx.query<RowBaseRow>(ROW_BASES, [userId])).rows,
    (await tx.query<CopyBaseRow>(COPY_BASES, [userId])).rows,
    (await tx.query<FieldBaseRow>(FIELD_BASES, [userId])).rows,
    (await tx.query<ItemRow>(ITEMS, [userId])).rows,
    (await tx.query<KeptRow>(KEPT, [userId])).rows,
  );
}

/** Every copy whose head or base is S or whose origin is one of `ids` (the rows of S). */
export async function figureOccs(tx: SqlClient, userId: string, S: string, ids: readonly string[]): Promise<string[]> {
  const { rows } = await tx.query<{ occ: string }>(
    `SELECT split_part(facet_key, '/', 2) AS occ FROM facet_state
      WHERE user_id = $1 AND facet_key LIKE 'occ/%/head' AND (CASE WHEN op = 'upsert' THEN payload::jsonb ->> 'head_id' END) = $2
     UNION
     SELECT split_part(facet_key, '/', 2) FROM facet_state
      WHERE user_id = $1 AND facet_key LIKE 'occ/%/origin' AND (CASE WHEN op = 'upsert' THEN payload::jsonb ->> 'native_id' END) = ANY($3::text[])
     UNION
     SELECT occ_id::text FROM import_copy_base WHERE user_id = $1 AND head_id::text = $2`,
    [userId, S, ids],
  );
  return rows.map((r) => r.occ);
}

/**
 * The state of one figure S, all an answer decides on: S's row bases, item, figure values and
 * items, and every copy whose head or base is S or whose origin is one of `ids` (the rows of S, so
 * an ordinal is never reused).
 */
export async function readFigureState(tx: SqlClient, userId: string, S: string, ids: readonly string[]): Promise<ImportState> {
  const occIds = await figureOccs(tx, userId, S, ids);
  const keys = [
    ...occIds.flatMap((occ) => ['head', 'status', 'origin', 'collection'].map((f) => `occ/${occ}/${f}`)),
    ...['score', 'note', 'wishability'].map((f) => `uf/${S}/${f}`),
    `imp/mfc/figure/${S}`,
    `imp/mfc/change/${S}`,
  ];
  const facets = await tx.query<FacetRow>('SELECT facet_key, version, op, payload FROM facet_state WHERE user_id = $1 AND facet_key = ANY($2::text[])', [userId, keys]);
  return assemble(
    facets.rows,
    (await tx.query<RowBaseRow>(`${ROW_BASES} AND head_id = $2`, [userId, S])).rows,
    (await tx.query<CopyBaseRow>(`${COPY_BASES} AND occ_id = ANY($2::uuid[])`, [userId, occIds])).rows,
    (await tx.query<FieldBaseRow>(`${FIELD_BASES} AND head_id = $2`, [userId, S])).rows,
    (await tx.query<ItemRow>(`${ITEMS} AND head_id = $2`, [userId, S])).rows,
    (await tx.query<KeptRow>(`${KEPT} AND head_id = $2`, [userId, S])).rows,
  );
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
  /** Each framed figure as it stood just before the import. */
  before: ReadonlyMap<string, FrameBefore>;
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
    `INSERT INTO import_frame (user_id, import_number, head_id, settled, before)
     SELECT $1, $2, f.h, f.h = ANY($4::uuid[]), f.before FROM unnest($3::uuid[], $5::jsonb[]) AS f(h, before)`,
    [userId, run.importNumber, run.figures, run.settled, run.figures.map((S) => JSON.stringify(run.before.get(S)))],
  );
}

export interface BaseMoves {
  rows: readonly Row[];
  rowsGone: readonly string[];
  copies: ReadonlyMap<string, CopyBase>;
  /** Copies whose base goes: a copy a revision's replay never based. */
  copiesGone?: readonly string[];
  fields: readonly { head: string; field: Field; value: number | string | null }[];
  items: { set: readonly FigureItem[]; end: readonly string[] };
  kept: { add: ReadonlyMap<string, KeptCopy>; gone: readonly string[] };
}

/** Move the bases a settlement or an answer moved, the pending figure items and the knowing keeps. */
export async function saveBases(tx: SqlClient, userId: string, importNumber: number, bases: BaseMoves): Promise<void> {
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
  if (bases.rowsGone.length > 0) {
    await tx.query('DELETE FROM import_row_base WHERE user_id = $1 AND mfc_id = ANY($2::text[])', [userId, bases.rowsGone]);
  }
  if (bases.copies.size > 0) {
    const copies = [...bases.copies];
    await tx.query(
      `INSERT INTO import_copy_base (user_id, occ_id, head_id, kind, import_removed)
       SELECT $1, c.occ_id, c.head_id, c.kind, c.removed FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::boolean[]) AS c(occ_id, head_id, kind, removed)
       ON CONFLICT (user_id, occ_id) DO UPDATE SET head_id = EXCLUDED.head_id, kind = EXCLUDED.kind, import_removed = EXCLUDED.import_removed`,
      [userId, copies.map(([occ]) => occ), copies.map(([, b]) => b.head), copies.map(([, b]) => b.kind), copies.map(([, b]) => b.removed)],
    );
  }
  if (bases.copiesGone !== undefined && bases.copiesGone.length > 0) {
    await tx.query('DELETE FROM import_copy_base WHERE user_id = $1 AND occ_id = ANY($2::uuid[])', [userId, bases.copiesGone]);
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
  await saveKept(tx, userId, bases.kept.add, bases.kept.gone);
}

/** Record the knowing keeps added, and drop those that end. */
export async function saveKept(tx: SqlClient, userId: string, add: ReadonlyMap<string, KeptCopy>, gone: readonly string[]): Promise<void> {
  for (const [occ, k] of add) {
    await tx.query(
      `INSERT INTO import_kept_copy (user_id, occ_id, head_id, kind) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, occ_id) DO UPDATE SET head_id = EXCLUDED.head_id, kind = EXCLUDED.kind`,
      [userId, occ, k.head, k.kind],
    );
  }
  if (gone.length > 0) {
    await tx.query('DELETE FROM import_kept_copy WHERE user_id = $1 AND occ_id = ANY($2::uuid[])', [userId, gone]);
  }
}

/** The latest export's rows, which the full discrepancy report compares the collection with. */
export async function saveExportRows(tx: SqlClient, userId: string, rows: readonly Row[]): Promise<void> {
  await tx.query('DELETE FROM import_export_row WHERE user_id = $1', [userId]);
  await tx.query(
    `INSERT INTO import_export_row (user_id, mfc_id, head_id, kind, count)
     SELECT $1, r.mfc_id, r.head_id, r.kind, r.count FROM unnest($2::text[], $3::uuid[], $4::text[], $5::int[]) AS r(mfc_id, head_id, kind, count)`,
    [userId, rows.map((r) => r.id), rows.map((r) => r.head), rows.map((r) => r.kind), rows.map((r) => r.count)],
  );
}

/** StatusResponse.pending_review: the figure items awaiting an answer and the edits held for review. */
export async function pendingReview(db: SqlClient, userId: string): Promise<bigint> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM import_figure_item WHERE user_id = $1) + (SELECT count(*) FROM held_edit WHERE user_id = $1) AS n`,
    [userId],
  );
  return BigInt(rows[0]!.n);
}
