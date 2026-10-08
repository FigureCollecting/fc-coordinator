// import.proto LATE EDITS AND REPLAY and HELD, the pure half. An import keeps, per figure it
// decides, S as it stood just before it (FRAME): its rows, bases, item, knowing keeps and copies.
// A LATE EDIT (made before an import it had not seen) is replayed just before that import: the
// import's decision of S is taken again with the edit placed, and compared with the decision as
// it was. When the two are the same the edit is placed as it would have been, the import's writes
// standing over it; when they differ the server emits the difference, a REVISION. HELD (ii): an
// edit made after a revision's import and before the revision, which its device had not seen, is
// held when it REACTS to the result the revision withdrew. ./holds.ts runs these in a Push.
import { SERVER_DEVICE_ID, compareVersion, parseVersion } from '@figurecollecting/fc-api-contract';
import type { Facet } from '../sync/store.js';
import { FIELDS, KINDS, bytewise, stable, View, type CopyBase, type OccIdOf, type Value } from './figure.js';
import { CHANGE_ITEM_PREFIX, FIGURE_ITEM_PREFIX, planImport, type FigureItem, type ImportState, type KeptCopy, type Plan, type Row } from './plan.js';
import type { Field } from './rows.js';

/** S as it stood just before an import: what a late edit is replayed against (import_frame.before). */
export interface FrameBefore {
  /** The export's rows the import decided S on, rows standing on their base included. */
  rows: Row[];
  rowBases: Row[];
  copyBases: [string, CopyBase][];
  fieldBases: [Field, Value | null][];
  item: FigureItem | null;
  kept: [string, KeptCopy][];
  /** The copies of S, and every copy whose origin is a row of S (an ordinal is never reused). */
  occs: string[];
}

/** One import's frame of S. */
export interface Frame {
  importNumber: number;
  exportDate: string;
  before: FrameBefore;
}

/** S's LIVE COPIES (each copy's figure and kind, or out) and ITEMS (each by its rev). */
export interface Summary {
  copies: Record<string, string>;
  items: { figure: string | null; change: string | null };
}

/** A revision that changed S's live copies or items: its import's marker, its position, S either side. */
export interface Revision {
  head: string;
  marker: bigint;
  seq: bigint;
  before: Summary;
  after: Summary;
}

const groupByHead = (rows: Iterable<Row>): Map<string, Row[]> => {
  const out = new Map<string, Row[]>();
  for (const r of rows) out.set(r.head, [...(out.get(r.head) ?? []), r]);
  return out;
};

/** Each figure an import decides, as the state it read had it. */
export function frameBefores(st: ImportState, figures: readonly string[], rows: readonly Row[]): Map<string, FrameBefore> {
  const v = new View(st);
  const byOrigin = new Map<string, string[]>();
  for (const [occ, c] of v.copies) if (c.origin !== null) byOrigin.set(c.origin.id, [...(byOrigin.get(c.origin.id) ?? []), occ]);
  const rowsOf = groupByHead(rows);
  const basesOf = groupByHead(st.rowBases.values());
  const out = new Map<string, FrameBefore>();
  for (const S of figures) {
    const exp = rowsOf.get(S) ?? [];
    const rowBases = basesOf.get(S) ?? [];
    const ids = new Set([...exp, ...rowBases].map((r) => r.id));
    const occs = [...new Set([...v.copiesOf(S), ...[...ids].flatMap((id) => byOrigin.get(id) ?? [])])].sort(bytewise);
    out.set(S, {
      rows: exp,
      rowBases,
      copyBases: occs.flatMap((occ): [string, CopyBase][] => {
        const base = st.copyBases.get(occ);
        return base === undefined ? [] : [[occ, base]];
      }),
      fieldBases: [...(st.fieldBases.get(S) ?? new Map<Field, Value | null>())],
      item: st.items.get(S) ?? null,
      kept: [...st.kept].filter(([, k]) => k.head === S),
      occs,
    });
  }
  return out;
}

/** Device edits merge by LWW among themselves: each placed where its version is above the one there. */
export function placeEdits(base: ReadonlyMap<string, Facet>, edits: readonly Facet[]): Map<string, Facet> {
  const out = new Map(base);
  for (const e of edits) {
    const there = out.get(e.facetKey);
    if (there === undefined || compareVersion(e.version, there.version) > 0) out.set(e.facetKey, { facetKey: e.facetKey, version: e.version, op: e.op, payload: e.payload });
  }
  return out;
}

/** The knowing keeps device edits end: a copy moved off the kind or the figure it was kept at. */
export function keptEndedBy(kept: ReadonlyMap<string, KeptCopy>, edits: readonly Facet[]): string[] {
  const ended = new Set<string>();
  for (const e of edits) {
    const m = /^occ\/([^/]+)\/(status|head)$/.exec(e.facetKey);
    const k = m === null ? undefined : kept.get(m[1]!);
    if (k === undefined) continue;
    const value = e.op === 'delete' ? null : (JSON.parse(e.payload) as Record<string, unknown>)[m![2] === 'status' ? 'status' : 'head_id'];
    if (value !== (m![2] === 'status' ? k.kind : k.head)) ended.add(m![1]!);
  }
  return [...ended].sort(bytewise);
}

/**
 * The import's decision of S taken again on S's facets just before it (`pre`), with `late` placed
 * by LWW, against S's bases, item and keeps as they stood then.
 */
export function decideAgain(frame: Frame, S: string, pre: ReadonlyMap<string, Facet>, late: readonly Facet[], occId: OccIdOf): Plan {
  const b = frame.before;
  const kept = new Map(b.kept);
  for (const occ of keptEndedBy(kept, late)) kept.delete(occ);
  return planImport({
    state: {
      facets: placeEdits(pre, late),
      rowBases: new Map(b.rowBases.map((r) => [r.id, r])),
      copyBases: new Map(b.copyBases),
      fieldBases: new Map([[S, new Map(b.fieldBases)]]),
      items: new Map(b.item === null ? [] : [[S, b.item]]),
      kept,
    },
    rows: b.rows,
    keepIds: [],
    importNumber: frame.importNumber,
    exportDate: frame.exportDate,
    occId,
  });
}

/**
 * Whether two decisions of one figure are the same: the same writes, bases and keeps, and the same
 * items by rev. A figure item that only shows the app's side anew is the same item.
 * The replay compares two decisions of one frame and one export, which differ only in the app's
 * side: the rows gone, the field bases and the item ended then differ only where one decision is
 * a conflict and the other not, and so do the items set. They are compared all the same.
 */
export function sameDecision(a: Plan, b: Plan): boolean {
  const of = (p: Plan) =>
    stable({
      writes: p.writes.filter((w) => !(w.facetKey.startsWith(FIGURE_ITEM_PREFIX) && w.op === 'upsert')),
      rowBases: p.rowBases,
      rowBasesGone: p.rowBasesGone,
      copyBases: [...p.copyBases],
      fieldBases: p.fieldBases,
      items: p.items.set.map((i) => i.rev),
      end: p.items.end,
      keptGone: p.keptGone,
    });
  return of(a) === of(b);
}

const COPY_FACETS = ['head', 'status', 'origin', 'collection'] as const;

/** The facets of S a decision reads or writes: its copies', its figure values and its items. */
export const figureKeys = (S: string, occs: Iterable<string>): string[] => [
  ...[...occs].flatMap((occ) => COPY_FACETS.map((f) => `occ/${occ}/${f}`)),
  ...FIELDS.map((f) => `uf/${S}/${f}`),
  `${FIGURE_ITEM_PREFIX}${S}`,
  `${CHANGE_ITEM_PREFIX}${S}`,
];

/** A stored head, status or item payload's field: each passed its schema, which requires it. */
const live = (f: Facet | undefined, field: string): string | null => (f === undefined || f.op === 'delete' ? null : (JSON.parse(f.payload) as Record<string, string>)[field]!);

/** S's live copies and items, as `facets` have them. */
export function summarize(S: string, facets: ReadonlyMap<string, Facet>, occs: Iterable<string>): Summary {
  const copies: Record<string, string> = {};
  for (const occ of occs) {
    const head = live(facets.get(`occ/${occ}/head`), 'head_id');
    const status = live(facets.get(`occ/${occ}/status`), 'status');
    copies[occ] = head !== null && (KINDS as readonly (string | null)[]).includes(status) ? `${head}/${status}` : 'out';
  }
  return {
    copies,
    items: { figure: live(facets.get(`${FIGURE_ITEM_PREFIX}${S}`), 'rev'), change: live(facets.get(`${CHANGE_ITEM_PREFIX}${S}`), 'rev') },
  };
}

/**
 * HELD (ii): whether an edit to `facetKey`, made after the revision's import and before the
 * revision, reacts to the result the revision withdrew. It writes a copy whose live state the
 * revision changed; or it writes the head or status of a copy of S (`onFigure`) that had no head
 * when the import ran (`hadHead` false); or it writes the head or status of a copy of S while its
 * device saw an item (`saw`: the revs it saw pending) that S had pending before the revision and
 * has not after.
 * A figure value is never a reaction.
 */
export function reacts(rev: Revision, facetKey: string, onFigure: boolean, hadHead: boolean, saw: readonly string[]): boolean {
  const m = /^occ\/([^/]+)\/(.+)$/.exec(facetKey);
  if (m === null) return false;
  const occ = m[1]!;
  if ((rev.before.copies[occ] ?? 'out') !== (rev.after.copies[occ] ?? 'out')) return true;
  if (!onFigure || (m[2] !== 'head' && m[2] !== 'status')) return false;
  if (!hadHead) return true;
  const pending = (s: Summary) => saw.some((r) => s.items.figure === r || s.items.change === r);
  return pending(rev.before) && !pending(rev.after);
}

/** A write by the server (an import, an answer or a revision): its version names the reserved device. */
export const isServerVersion = (version: string): boolean => parseVersion(version)?.deviceId === SERVER_DEVICE_ID;
