// The figure decision of import.proto THE SERVER DECIDES, as far as WK-14a takes it: the ONE-TIME
// import (MG-1). A figure no earlier import settled (it has no row base) is decided in full:
// counts by matching MFC's transitions with the app's, MATERIALIZE, each figure value on its own,
// one decision per figure, a conflict raised as a figure item and nothing of the figure written.
// A figure an earlier import settled must be one the export leaves unchanged, which is the
// idempotent re-import; any other change to it is the re-import diff of WK-14b, and the plan
// names it in `beyond` so the import can refuse before it writes anything.
//
// A pure function of the server's state and the export: the service reads the state under the
// user's lock, calls this, and writes the plan through the Push apply path.
import { createHash } from 'node:crypto';
import type { Facet } from '../sync/store.js';
import type { Field, FieldValues, Kind } from './rows.js';

export const KINDS: readonly Kind[] = ['owned', 'ordered', 'wished'];
export const FIELDS: readonly Field[] = ['score', 'note', 'wishability'];
const OUT = 'out';
type KindOrOut = Kind | typeof OUT;
type Value = number | string;
type Counts = Record<Kind, number>;

export const FIGURE_ITEM_PREFIX = 'imp/mfc/figure/';

/** A resolved MFC row: its canonical id, the spine head it names, and what it states. */
export interface Row {
  id: string;
  head: string;
  kind: Kind;
  count: number;
  fields: FieldValues;
}

/** COPY BASE: the kind (or out) and head the last settlement gave the copy on MFC's behalf. */
export interface CopyBase {
  head: string;
  kind: KindOrOut;
}

/** What a decision found, part by part, and for a value conflict both sides of it. */
export interface Comps {
  counts: string;
  score: string;
  note: string;
  wishability: string;
  details: Partial<Record<Field, { app: Value; mfc: Value }>>;
}

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

export interface ImportState {
  /** The user's facets an import reads: occ/*, uf/* and imp/mfc/figure/*, tombstones included. */
  facets: ReadonlyMap<string, Facet>;
  rowBases: ReadonlyMap<string, Row>;
  copyBases: ReadonlyMap<string, CopyBase>;
  /** FIELD BASE per head and field: the value MFC last stated; null when it stated none. */
  fieldBases: ReadonlyMap<string, ReadonlyMap<Field, Value | null>>;
  items: ReadonlyMap<string, FigureItem>;
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
  occId: (mfcId: string, ordinal: number) => string;
}

export interface Write {
  facetKey: string;
  op: 'upsert' | 'delete';
  /** JSON text; '' for a tombstone. */
  payload: string;
}

export interface Plan {
  /** In feed order, the marker excluded. */
  writes: Write[];
  rowBases: Row[];
  copyBases: Map<string, CopyBase>;
  fieldBases: { head: string; field: Field; value: Value | null }[];
  items: { set: FigureItem[]; end: string[] };
  /** Every figure the import decided (its frame), in head order. */
  figures: string[];
  /** The figures whose decision is a conflict. */
  conflicted: string[];
  /** Settled figures this export changes: WK-14b's to decide. */
  beyond: string[];
  /** Every figure item pending after the import, in head order, with its payload. */
  pending: { head: string; rev: string; payload: string }[];
  stats: { added: number; unchanged: number; occurrencesAdded: number; conflictsRaised: number };
}

type Op =
  | { op: 'create'; occ: string; id: string; ordinal: number; head: string; kind: Kind }
  | { op: 'cbase'; occ: string; kind: KindOrOut }
  | { op: 'field'; field: Field; value: Value }
  | { op: 'fbase'; field: Field; value: Value };

interface Decision {
  ops: Op[];
  comps: Comps;
  M: Counts;
}

const zero = (): Counts => ({ owned: 0, ordered: 0, wished: 0 });

/** Canonical MFC ids have no leading zeros, so length then text is numeric order. */
const bytewise = (a: string, b: string): number => Number(a > b) - Number(a < b);
const byId = (a: { id: string }, b: { id: string }): number => a.id.length - b.id.length || bytewise(a.id, b.id);

/** JSON with every object's keys sorted, so an unchanged value is byte-identical. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

interface Copy {
  head: string | null;
  status: string | null;
  origin: { id: string; ordinal: number } | null;
}

/** The user's copies and figure values, read from their facets. */
class View {
  readonly copies = new Map<string, Copy>();

  constructor(readonly st: ImportState) {
    for (const facet of st.facets.values()) {
      const m = /^occ\/([^/]+)\/(head|status|origin)$/.exec(facet.facetKey);
      if (m === null) continue;
      const copy = this.copy(m[1]!);
      // Payloads stored here passed their schema; a head or status tombstone is no value.
      const value = this.json(facet) as { head_id?: string; status?: string; native_id: string; ordinal: number } | null;
      if (m[2] === 'head') copy.head = value?.head_id ?? null;
      else if (m[2] === 'status') copy.status = value?.status ?? null;
      // The origin is server-owned: the import writes it once and never tombstones it.
      else copy.origin = { id: value!.native_id, ordinal: value!.ordinal };
    }
    for (const occ of st.copyBases.keys()) this.copy(occ);
  }

  private copy(occ: string): Copy {
    let c = this.copies.get(occ);
    if (c === undefined) this.copies.set(occ, (c = { head: null, status: null, origin: null }));
    return c;
  }

  json(facet: Facet | undefined): Record<string, unknown> | null {
    return facet === undefined || facet.op === 'delete' ? null : (JSON.parse(facet.payload) as Record<string, unknown>);
  }

  /** The copies of S: its head is S, or its base's is. In occ-id order. */
  copiesOf(S: string): string[] {
    return [...this.copies]
      .filter(([occ, c]) => c.head === S || this.st.copyBases.get(occ)?.head === S)
      .map(([occ]) => occ)
      .sort(bytewise);
  }

  curKind(occ: string, S: string): KindOrOut {
    const c = this.copies.get(occ)!;
    return c.head === S && (KINDS as readonly (string | null)[]).includes(c.status) ? (c.status as Kind) : OUT;
  }

  baseKind(occ: string, S: string): KindOrOut {
    const b = this.st.copyBases.get(occ);
    return b !== undefined && b.head === S ? b.kind : OUT;
  }

  /** What the app shows for S's field (sync.proto rule 6, on S's own head). */
  field(S: string, f: Field): Value | null {
    const value = this.json(this.st.facets.get(`uf/${S}/${f}`))?.[f];
    return value === undefined ? null : (value as Value);
  }

  /** The lowest ordinal of row `id` that no copy holds and `taken` does not list. */
  ordinal(id: string, taken: ReadonlySet<number>): number {
    const used = new Set(taken);
    for (const c of this.copies.values()) if (c.origin?.id === id) used.add(c.origin.ordinal);
    let n = 1;
    while (used.has(n)) n += 1;
    return n;
  }
}

/** MFC's value of a field: the first row, in id order, that states one. */
const mfcField = (exp: readonly Row[], f: Field): Value | undefined => exp.find((r) => r.fields[f] !== undefined)?.fields[f];

/** The copies to create, kind by kind, each for the lowest-numbered row of the kind its copies do not fill. */
function materialize(v: View, exp: readonly Row[], cs: readonly string[], cur: Map<string, KindOrOut>, rm: Counts, occId: PlanInput['occId']): Op[] {
  const ops: Op[] = [];
  const made = new Map<string, Set<number>>();
  for (const k of KINDS) {
    const rows = exp.filter((r) => r.kind === k);
    for (let i = 0; i < rm[k]; i += 1) {
      const live = (id: string) => cs.filter((c) => cur.get(c) === k && v.copies.get(c)!.origin?.id === id).length;
      // Some row always has room: the app's copies of k number fewer than MFC's Counts of k.
      const r = rows.find((row) => row.count - live(row.id) - (made.get(row.id)?.size ?? 0) > 0)!;
      const taken = made.get(r.id) ?? new Set<number>();
      const ordinal = v.ordinal(r.id, taken);
      made.set(r.id, taken.add(ordinal));
      const occ = occId(r.id, ordinal);
      ops.push({ op: 'create', occ, id: r.id, ordinal, head: r.head, kind: k }, { op: 'cbase', occ, kind: k });
    }
  }
  return ops;
}

/**
 * A figure with no row base. B, the row-base Counts, is zero and no copy of S has a base, so
 * MFC's transitions are OUT->k, M_k of each, and the app's are one OUT->k per live copy: matching
 * pairs the app's copies of k, lowest occ id first, and what is left of MFC's is materialized.
 * The two sides never leave transitions that share a kind, so the counts never conflict here.
 */
function decideNew(v: View, S: string, exp: readonly Row[], occId: PlanInput['occId']): Decision {
  const M = zero();
  for (const r of exp) M[r.kind] += r.count;
  const cs = v.copiesOf(S);
  const cur = new Map(cs.map((c) => [c, v.curKind(c, S)]));
  const A = zero();
  for (const k of cur.values()) if (k !== OUT) A[k] += 1;
  const ops: Op[] = [];
  const comps: Comps = { counts: 'nochange', score: 'nochange', note: 'nochange', wishability: 'nochange', details: {} };

  if (KINDS.every((k) => M[k] === 0)) {
    comps.counts = 'nochange';
  } else if (KINDS.every((k) => A[k] === M[k])) {
    comps.counts = 'alike';
    for (const c of cs) ops.push({ op: 'cbase', occ: c, kind: cur.get(c)! });
  } else {
    const rm = zero();
    for (const k of KINDS) {
      const live = cs.filter((c) => cur.get(c) === k);
      const paired = Math.min(M[k], live.length);
      for (const c of live.slice(0, paired)) ops.push({ op: 'cbase', occ: c, kind: k });
      rm[k] = M[k] - paired;
    }
    if (KINDS.every((k) => rm[k] === 0)) {
      comps.counts = 'matched+app-only';
    } else {
      comps.counts = 'apply';
      ops.push(...materialize(v, exp, cs, cur, rm, occId));
    }
  }

  for (const f of FIELDS) {
    const stated = exp.filter((r) => r.fields[f] !== undefined).map((r) => r.fields[f]!);
    if (stated.length === 0) continue;
    if (new Set(stated).size > 1) {
      comps[f] = 'conflict';
      continue;
    }
    const value = stated[0]!;
    const app = v.field(S, f);
    if (app === value) {
      comps[f] = 'alike';
      ops.push({ op: 'fbase', field: f, value });
    } else if (app === null) {
      comps[f] = 'apply';
      ops.push({ op: 'field', field: f, value }, { op: 'fbase', field: f, value });
    } else {
      comps[f] = 'conflict';
      comps.details[f] = { app, mfc: value };
    }
  }
  return { ops, comps, M };
}

const sameRow = (a: Row | undefined, b: Row): boolean =>
  a !== undefined && a.head === b.head && a.kind === b.kind && a.count === b.count && stable(a.fields) === stable(b.fields);

export function planImport(input: PlanInput): Plan {
  const { state: st, importNumber, exportDate, occId } = input;
  const v = new View(st);
  const shown = { edited_at: `${exportDate}T00:00:00Z`, tz: 'UTC' };
  const plan: Plan = {
    writes: [],
    rowBases: [],
    copyBases: new Map(),
    fieldBases: [],
    items: { set: [], end: [] },
    figures: [],
    conflicted: [],
    beyond: [],
    pending: [],
    stats: { added: 0, unchanged: 0, occurrencesAdded: 0, conflictsRaised: 0 },
  };
  const userWrite = (facetKey: string, body: object): void => {
    plan.writes.push({ facetKey, op: 'upsert', payload: JSON.stringify({ ...body, ...shown }) });
  };
  const figureOf = (rows: readonly Row[]) => new Set(rows.map((r) => r.head));

  // An id unresolved for its Count or product states nothing new: its row base stands for it.
  const kept = input.keepIds.flatMap((id) => {
    const base = st.rowBases.get(id);
    return base === undefined ? [] : [base];
  });
  const rows = [...input.rows, ...kept];
  const heads = [...new Set([...figureOf(rows), ...figureOf([...st.rowBases.values()])])].sort(bytewise);

  for (const S of heads) {
    plan.figures.push(S);
    const exp = rows.filter((r) => r.head === S).sort(byId);
    const resolved = input.rows.filter((r) => r.head === S).length;
    const baseRows = [...st.rowBases.values()].filter((r) => r.head === S);

    if (baseRows.length > 0) {
      const unchanged = exp.length === baseRows.length && exp.every((r) => sameRow(st.rowBases.get(r.id), r));
      if (unchanged) plan.stats.unchanged += resolved;
      else plan.beyond.push(S);
      continue;
    }
    if (v.copiesOf(S).some((c) => v.baseKind(c, S) !== OUT)) {
      plan.beyond.push(S);
      continue;
    }

    plan.stats.added += resolved;
    const d = decideNew(v, S, exp, occId);
    const existing = st.items.get(S);
    const conflict = FIELDS.some((f) => d.comps[f] === 'conflict');
    if (conflict) {
      const side = stable(Object.fromEntries(exp.map((r) => [r.id, [r.kind, r.count, r.fields]])));
      const keep = existing !== undefined && existing.side === side;
      const item: FigureItem = keep
        ? existing
        : { head: S, rev: `i${importNumber}.${createHash('sha256').update(side).digest('hex').slice(0, 32)}`, raised: importNumber, side, comps: d.comps };
      if (!keep) plan.stats.conflictsRaised += 1;
      const payload = figurePayload(v, S, exp, item, d, occId);
      const facetKey = `${FIGURE_ITEM_PREFIX}${S}`;
      const stored = st.facets.get(facetKey);
      if (stored?.op !== 'upsert' || stored.payload !== payload) plan.writes.push({ facetKey, op: 'upsert', payload });
      plan.items.set.push(item);
      plan.conflicted.push(S);
      continue;
    }

    if (existing !== undefined) {
      plan.writes.push({ facetKey: `${FIGURE_ITEM_PREFIX}${S}`, op: 'delete', payload: '' });
      plan.items.end.push(S);
    }
    for (const op of d.ops) {
      if (op.op === 'create') {
        // The origin is server-owned and carries no display time.
        plan.writes.push({ facetKey: `occ/${op.occ}/origin`, op: 'upsert', payload: JSON.stringify({ site: 'mfc', native_id: op.id, ordinal: op.ordinal }) });
        userWrite(`occ/${op.occ}/head`, { head_id: op.head });
        userWrite(`occ/${op.occ}/status`, { status: op.kind });
        plan.stats.occurrencesAdded += 1;
      } else if (op.op === 'cbase') {
        plan.copyBases.set(op.occ, { head: S, kind: op.kind });
      } else if (op.op === 'field') {
        userWrite(`uf/${S}/${op.field}`, { [op.field]: op.value });
      } else {
        plan.fieldBases.push({ head: S, field: op.field, value: op.value });
      }
    }
    plan.rowBases.push(...exp);
  }

  // Pending after the import: the items this import kept or raised, and every other one standing.
  const decided = new Set(plan.figures);
  const written = new Map(plan.writes.map((w) => [w.facetKey, w.payload]));
  for (const item of [...st.items.values()].filter((i) => !decided.has(i.head)).concat(plan.items.set).sort((a, b) => bytewise(a.head, b.head))) {
    const facetKey = `${FIGURE_ITEM_PREFIX}${item.head}`;
    plan.pending.push({ head: item.head, rev: item.rev, payload: written.get(facetKey) ?? st.facets.get(facetKey)!.payload });
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// The figure item (schemas/imp-figure.schema.json) and the writes each answer would make now.
// ---------------------------------------------------------------------------------------------

type PreviewCopy = { occ: string; status?: string; head_id?: string; origin?: { site: string; native_id: string; ordinal: number } };
type PreviewField = { head_id: string; field: Field } & Partial<Record<Field, Value>>;

function preview(S: string, ops: readonly Op[]): { copies: PreviewCopy[]; fields: PreviewField[] } {
  const copies: PreviewCopy[] = [];
  const fields: PreviewField[] = [];
  for (const op of ops) {
    // keep and take preview only creates and figure values.
    if (op.op === 'create') {
      copies.push({ occ: op.occ, status: op.kind, head_id: op.head, origin: { site: 'mfc', native_id: op.id, ordinal: op.ordinal } });
    } else {
      const field = op as Extract<Op, { op: 'field' }>;
      fields.push({ head_id: S, field: field.field, [field.field]: field.value });
    }
  }
  // In facet-key order, as the writes would land.
  copies.sort((a, b) => bytewise(a.occ, b.occ));
  fields.sort((a, b) => bytewise(a.field, b.field));
  return { copies, fields };
}

/**
 * keep: a disputed part stays the app's; a part the rev found only MFC changed is applied where
 * the app has not changed it since (decided again, it is still MFC's change alone).
 */
function keepOps(item: FigureItem, d: Decision): Op[] {
  // `d` writes a create or a field only where, decided again, that part is still MFC's alone.
  const ops: Op[] = [];
  if (item.comps.counts === 'apply') ops.push(...d.ops.filter((op) => op.op === 'create'));
  for (const f of FIELDS) {
    if (item.comps[f] === 'apply') ops.push(...d.ops.filter((op) => op.op === 'field' && op.field === f));
  }
  return ops;
}

/**
 * take: MFC's side made true on the copies MFC tracks. A figure with no row base has none, so it
 * is a new copy per Count, each for the lowest-numbered row of its kind, and MFC's value on every
 * field it changed or disputes.
 */
function takeOps(v: View, exp: readonly Row[], d: Decision, occId: PlanInput['occId']): Op[] {
  const ops: Op[] = [];
  for (const k of KINDS) {
    const r = exp.find((row) => row.kind === k);
    const taken = new Set<number>();
    for (let i = 0; i < d.M[k]; i += 1) {
      const ordinal = v.ordinal(r!.id, taken);
      taken.add(ordinal);
      ops.push({ op: 'create', occ: occId(r!.id, ordinal), id: r!.id, ordinal, head: r!.head, kind: k });
    }
  }
  for (const f of FIELDS) {
    if (d.comps[f] === 'apply' || d.comps[f] === 'conflict') ops.push({ op: 'field', field: f, value: mfcField(exp, f)! });
  }
  return ops;
}

function figurePayload(v: View, S: string, exp: readonly Row[], item: FigureItem, d: Decision, occId: PlanInput['occId']): string {
  const cs = v.copiesOf(S);
  const app = zero();
  for (const c of cs) {
    const k = v.curKind(c, S);
    if (k !== OUT) app[k] += 1;
  }
  const counts = Object.fromEntries(KINDS.map((k) => [k, { base: 0, app: app[k], mfc: d.M[k] }]));
  const fields = Object.fromEntries(
    FIELDS.map((f) => {
      const found = item.comps.details[f];
      return [f, { status: item.comps[f], app: found?.app ?? v.field(S, f) ?? undefined, mfc: found?.mfc ?? mfcField(exp, f) }];
    }),
  );
  const copies = cs.map((c) => {
    const status = v.copies.get(c)!.status;
    // A copy out of S is shown without a status, but a former one, which is kept.
    const shown = v.curKind(c, S) !== OUT || status === 'former';
    // MFC tracks no copy of a figure with no row base: the plan refuses one whose copies carry a base.
    return { occ: c, ...(shown ? { status } : {}), tracked: false };
  });
  return stable({
    rev: item.rev,
    kind: 'conflict',
    import: item.raised,
    counts,
    fields,
    copies,
    mfc_rows: exp.map((r) => ({ mfc_id: r.id, kind: r.kind, count: r.count })),
    preview: { keep: preview(S, keepOps(item, d)), take: preview(S, takeOps(v, exp, d, occId)) },
  });
}
