// What one import does with every figure it decides (import.proto THE FIGURE DECISION, through
// ./figure.ts): a figure new to the import is added; a settled figure the export changes is
// re-decided against its bases, MFC's change alone written to the copies the app left untouched
// and listed as a change entry with its undo (R3); a conflict is a figure item and nothing of the
// figure is written. Not decided here (`beyond`, refused by the import before it writes): a row
// the spine now resolves to another head than its row base names, a merge or a move. Not built
// yet: divergence items, align-MFC entries and acknowledgements (R4, R8), settlement by a FAVOR
// preference, and the replay of a late edit.
//
// A pure function of the server's state and the export: the service reads the state under the
// user's lock, calls this, and writes the plan through the Push apply path.
import { createHash } from 'node:crypto';
import {
  FIELDS,
  KINDS,
  OUT,
  View,
  byId,
  bytewise,
  decide,
  emptyEffect,
  finalKinds,
  keepEffect,
  lackedRows,
  mergeEffects,
  mfcField,
  stable,
  takeEffect,
  writesAnything,
  type Comps,
  type CopyBase,
  type Decision,
  type Effect,
  type FigureState,
  type OccIdOf,
  type Row,
  type Value,
} from './figure.js';
import type { Field, Kind } from './rows.js';
import { render, type Listed, type Write } from './writes.js';

export { FIELDS, KINDS, stable, type Comps, type CopyBase, type Row, type Write };

export const FIGURE_ITEM_PREFIX = 'imp/mfc/figure/';
export const CHANGE_ITEM_PREFIX = 'imp/mfc/change/';
/** res/mfc/{head_id}: the user's answer to one of the figure's items, synced through Push. */
export const ANSWER_PREFIX = 'res/mfc/';

/** A pending figure item of kind conflict, as the server keeps it beside its facet. */
export interface FigureItem {
  head: string;
  rev: string;
  /** The import that raised this rev. */
  raised: number;
  /** MFC's side as the raising import found it: an import that finds it unchanged keeps the rev. */
  side: string;
  comps: Comps;
}

/** A KNOWING KEEP: a copy kept against MFC's removal, on its figure at its kind. */
export interface KeptCopy {
  head: string;
  kind: Kind;
}

export interface ImportState extends FigureState {
  items: ReadonlyMap<string, FigureItem>;
  kept: ReadonlyMap<string, KeptCopy>;
}

export interface PlanInput {
  state: ImportState;
  /** The export's resolved rows. */
  rows: readonly Row[];
  /** Ids unresolved for invalid_count, count_over_99 or no_product: each one's row base stands. */
  keepIds: readonly string[];
  importNumber: number;
  /** "YYYY-MM-DD": every write is displayed at its midnight UTC. */
  exportDate: string;
  occId: OccIdOf;
}

/** An item of the review set or a change entry: its figure, rev and payload. */
export interface Entry {
  head: string;
  rev: string;
  payload: string;
}

export interface Plan {
  /** In feed order, the marker excluded. */
  writes: Write[];
  /** Row bases that are new or changed. */
  rowBases: Row[];
  /** MFC ids whose row base goes: rows the export dropped from a figure it settled. */
  rowBasesGone: string[];
  copyBases: Map<string, CopyBase>;
  fieldBases: { head: string; field: Field; value: Value | null }[];
  items: { set: FigureItem[]; end: string[] };
  /** Copies whose knowing keep ends. */
  keptGone: string[];
  /** The export's rows as this import read them, rows standing on their base included. */
  exportRows: Row[];
  /** Every figure the import decided (its frame), in head order. */
  figures: string[];
  /** The figures it wrote to or moved a copy or field base of, in head order. */
  settled: string[];
  /** The figures whose decision is a conflict. */
  conflicted: string[];
  /** Figures whose row the spine now resolves to another head: not decided, and the import refuses. */
  beyond: string[];
  /** Every figure item pending after the import, in head order, with its payload. */
  pending: Entry[];
  /** The change entries this import made, in head order. */
  applied: Entry[];
  stats: {
    added: number;
    moved: number;
    unchanged: number;
    removed: number;
    keptNewer: number;
    occurrencesAdded: number;
    occurrencesStatusChanged: number;
    occurrencesRemoved: number;
    conflictsRaised: number;
  };
}

const sameRow = (a: Row | undefined, b: Row): boolean =>
  a !== undefined && a.head === b.head && a.kind === b.kind && a.count === b.count && stable(a.fields) === stable(b.fields);

const group = (rows: Iterable<Row>): Map<string, Row[]> => {
  const out = new Map<string, Row[]>();
  for (const r of rows) out.set(r.head, [...(out.get(r.head) ?? []), r]);
  return out;
};

const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 32);

/** MFC's side for a rev: the export's rows of S by id, and each row base it lacks as lacked (null). */
export const sideOf = (exp: readonly Row[], lacked: readonly Row[]): string =>
  stable(Object.fromEntries([...exp.map((r) => [r.id, [r.kind, r.count, r.fields]] as const), ...lacked.map((r) => [r.id, null] as const)]));

/** The export's rows of S a side states, in id order: what an answer decides against. */
export function rowsOfSide(side: string, S: string): Row[] {
  const parsed = JSON.parse(side) as Record<string, [Kind, number, Row['fields']] | null>;
  return Object.entries(parsed)
    .flatMap(([id, r]) => (r === null ? [] : [{ id, head: S, kind: r[0], count: r[1], fields: r[2] }]))
    .sort(byId);
}

/** Whether the live copies of S, as `final` has them, are MFC's Counts kind by kind. */
const countsEqual = (final: ReadonlyMap<string, string>, exp: readonly Row[]): boolean =>
  KINDS.every((k) => [...final.values()].filter((x) => x === k).length === exp.filter((r) => r.kind === k).reduce((n, r) => n + r.count, 0));

/**
 * The knowing keeps of S that end: every one when the counts are equal as the decision leaves
 * them, else each copy no longer live at its kind on S, or given a live base (MFC counts it again).
 */
export function keptEnding(st: ImportState, S: string, exp: readonly Row[], final: ReadonlyMap<string, string>, bases: ReadonlyMap<string, CopyBase>): string[] {
  const kept = [...st.kept].filter(([, k]) => k.head === S);
  const equal = countsEqual(final, exp);
  return kept
    .filter(([occ, k]) => equal || final.get(occ) !== k.kind || (bases.get(occ)?.kind ?? OUT) !== OUT)
    .map(([occ]) => occ);
}

export function planImport(input: PlanInput): Plan {
  const { state: st, importNumber, exportDate, occId } = input;
  const v = new View(st);
  const shown = { edited_at: `${exportDate}T00:00:00Z`, tz: 'UTC' };
  const plan: Plan = {
    writes: [],
    rowBases: [],
    rowBasesGone: [],
    copyBases: new Map(),
    fieldBases: [],
    items: { set: [], end: [] },
    keptGone: [],
    exportRows: [],
    figures: [],
    settled: [],
    conflicted: [],
    beyond: [],
    pending: [],
    applied: [],
    stats: { added: 0, moved: 0, unchanged: 0, removed: 0, keptNewer: 0, occurrencesAdded: 0, occurrencesStatusChanged: 0, occurrencesRemoved: 0, conflictsRaised: 0 },
  };

  // An id unresolved for its Count or product states nothing new: its row base stands for it.
  const standing = input.keepIds.flatMap((id) => {
    const base = st.rowBases.get(id);
    return base === undefined ? [] : [base];
  });
  const rows = [...input.rows, ...standing];
  plan.exportRows = [...rows].sort(byId);
  const rowsOf = group(rows);
  const basesOf = group(st.rowBases.values());
  const resolvedOf = group(input.rows);
  // A row whose base names another head was merged or moved by the spine: both figures wait.
  const moved = new Set<string>();
  for (const r of input.rows) {
    const base = st.rowBases.get(r.id);
    if (base !== undefined && base.head !== r.head) moved.add(r.head).add(base.head);
  }
  const heads = [...new Set([...rowsOf.keys(), ...basesOf.keys()])].sort(bytewise);

  for (const S of heads) {
    plan.figures.push(S);
    if (moved.has(S)) {
      plan.beyond.push(S);
      continue;
    }
    const exp = (rowsOf.get(S) ?? []).sort(byId);
    const baseRows = basesOf.get(S) ?? [];
    const lacked = lackedRows(exp, baseRows);
    const resolved = resolvedOf.get(S)?.length ?? 0;
    const isNew = baseRows.length === 0;
    const d = decide(v, S, exp, baseRows, occId);
    const existing = st.items.get(S);

    if (d.conflict) {
      if (isNew) plan.stats.added += resolved;
      else plan.stats.keptNewer += resolved;
      const side = sideOf(exp, lacked);
      const keep = existing !== undefined && existing.side === side;
      const item: FigureItem = keep ? existing : { head: S, rev: `i${importNumber}.${digest(side)}`, raised: importNumber, side, comps: d.comps };
      if (!keep) plan.stats.conflictsRaised += 1;
      const payload = figurePayload(v, S, exp, item, d, occId);
      const facetKey = `${FIGURE_ITEM_PREFIX}${S}`;
      const stored = st.facets.get(facetKey);
      if (stored?.op !== 'upsert' || stored.payload !== payload) plan.writes.push({ facetKey, op: 'upsert', payload });
      plan.items.set.push(item);
      plan.conflicted.push(S);
      plan.keptGone.push(...keptEnding(st, S, exp, finalKinds(v, S, emptyEffect()), new Map()));
      continue;
    }

    if (existing !== undefined) {
      plan.writes.push({ facetKey: `${FIGURE_ITEM_PREFIX}${S}`, op: 'delete', payload: '' });
      plan.items.end.push(S);
    }
    const effect = mergeEffects(d.counts, ...d.fields.values());
    const out = render(v, S, effect, shown);
    plan.writes.push(...out.writes);
    plan.stats.occurrencesAdded += out.counts.added;
    plan.stats.occurrencesStatusChanged += out.counts.statusChanged;
    plan.stats.occurrencesRemoved += out.counts.removed;
    if (isNew) plan.stats.added += resolved;
    else if (effect.statuses.size > 0 || effect.created.length > 0) plan.stats.moved += resolved;
    else plan.stats.unchanged += resolved;
    if (out.counts.removed > 0) plan.stats.removed += lacked.length;
    if (!isNew && writesAnything(effect)) {
      const entry = changeEntry(S, importNumber, out.done, out.undo);
      plan.writes.push({ facetKey: `${CHANGE_ITEM_PREFIX}${S}`, op: 'upsert', payload: entry.payload });
      plan.applied.push(entry);
    }

    // Every op writes to S or moves a copy or field base of it; a row that states nothing new has none.
    if (writesAnything(effect) || effect.copyBases.size > 0 || effect.fieldBases.size > 0) plan.settled.push(S);
    for (const [occ, base] of effect.copyBases) {
      // A copy a device moved between two figures this import decides: its base on the figure it
      // is now on stands over an out base on the one it left.
      const set = plan.copyBases.get(occ);
      if (base.kind === OUT && set !== undefined && set.head !== S) continue;
      plan.copyBases.set(occ, base);
    }
    for (const [field, value] of effect.fieldBases) plan.fieldBases.push({ head: S, field, value });
    plan.rowBases.push(...exp.filter((r) => !sameRow(st.rowBases.get(r.id), r)));
    plan.rowBasesGone.push(...lacked.map((r) => r.id));
    plan.keptGone.push(...keptEnding(st, S, exp, finalKinds(v, S, effect), effect.copyBases));
  }

  // Pending after the import: the items this import kept or raised, and every other one standing.
  const decided = new Set(plan.figures);
  const written = new Map(plan.writes.map((w) => [w.facetKey, w.payload]));
  const others = [...st.items.values()].filter((i) => !decided.has(i.head));
  for (const item of others.concat(plan.items.set).sort((a, b) => bytewise(a.head, b.head))) {
    const facetKey = `${FIGURE_ITEM_PREFIX}${item.head}`;
    plan.pending.push({ head: item.head, rev: item.rev, payload: written.get(facetKey) ?? st.facets.get(facetKey)!.payload });
  }
  return plan;
}

/** A change entry of kind applied (schemas/imp-change.schema.json): what the import wrote and its undo. */
export function changeEntry(S: string, importNumber: number, done: Listed, undo: Listed, kind = 'applied'): Entry {
  const rev = `i${importNumber}.${digest(stable({ kind, writes: done, undo }))}`;
  return { head: S, rev, payload: stable({ rev, kind, import: importNumber, writes: done, undo }) };
}

// ---------------------------------------------------------------------------------------------
// The figure item (schemas/imp-figure.schema.json) and the writes each answer would make now.
// ---------------------------------------------------------------------------------------------

/** Exactly what an effect would write, as a preview lists it. */
function preview(v: View, S: string, e: Effect): Listed {
  const listed = render(v, S, e, { edited_at: '1970-01-01T00:00:00Z', tz: 'UTC' }).done;
  // In facet-key order, as the writes would land.
  listed.fields.sort((a, b) => bytewise(a.field, b.field));
  return listed;
}

function figurePayload(v: View, S: string, exp: readonly Row[], item: FigureItem, d: Decision, occId: OccIdOf): string {
  const counts = Object.fromEntries(KINDS.map((k) => [k, { base: d.B[k], app: d.A[k], mfc: d.M[k] }]));
  const fields = Object.fromEntries(
    FIELDS.map((f) => {
      const found = item.comps.details[f];
      return [
        f,
        {
          status: item.comps[f],
          base: v.fieldBase(S, f) ?? undefined,
          app: found?.app ?? v.field(S, f) ?? undefined,
          mfc: found?.mfc ?? mfcField(exp, f) ?? undefined,
        },
      ];
    }),
  );
  const copies = v.copiesOf(S).map((c) => {
    const status = v.copies.get(c)!.status;
    // A copy out of S is shown without a status, but a former one, which is kept.
    const shown = v.curKind(c, S) !== OUT || status === 'former';
    return { occ: c, ...(shown ? { status } : {}), tracked: v.baseKind(c, S) !== OUT };
  });
  return stable({
    rev: item.rev,
    kind: 'conflict',
    import: item.raised,
    counts,
    fields,
    copies,
    mfc_rows: exp.map((r) => ({ mfc_id: r.id, kind: r.kind, count: r.count })),
    preview: { keep: preview(v, S, keepEffect(item.comps, d)), take: preview(v, S, takeEffect(v, S, exp, item.comps, occId)) },
  });
}
