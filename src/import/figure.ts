// import.proto THE FIGURE DECISION, for one figure S, as pure functions of the server's state:
// the counts by MATCHING MFC's transitions with the app's and MATERIALIZE, each figure value on
// its own, ONE DECISION PER FIGURE; and what an answer (keep, take, per_copy) makes of a figure
// item, with the REALIGN that follows it. A figure is its spine survivor; a head the spine merged
// or a row it moved is not decided here (./plan.ts names those in `beyond`), so a figure is one
// head and its rows are the rows resolving to it.
import type { Facet } from '../sync/store.js';
import type { Field, FieldValues, Kind } from './rows.js';

export const KINDS: readonly Kind[] = ['owned', 'ordered', 'wished'];
export const FIELDS: readonly Field[] = ['score', 'note', 'wishability'];
export const OUT = 'out';
export type KindOrOut = Kind | typeof OUT;
export type Value = number | string;
export type Counts = Record<Kind, number>;

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
  /** The copy is one an import removed (MATERIALIZE restores it before creating one). */
  removed: boolean;
}

/** What a decision found, part by part: nochange, alike, matched+app-only, apply or conflict. */
export interface Comps {
  counts: string;
  score: string;
  note: string;
  wishability: string;
  details: Partial<Record<Field, { app?: Value; mfc?: Value }>>;
}

/** The state a decision reads. */
export interface FigureState {
  /** occ/*, uf/* and the import's own items, tombstones included. */
  facets: ReadonlyMap<string, Facet>;
  rowBases: ReadonlyMap<string, Row>;
  copyBases: ReadonlyMap<string, CopyBase>;
  /** FIELD BASE per head and field: the value MFC last stated; null when it stated none. */
  fieldBases: ReadonlyMap<string, ReadonlyMap<Field, Value | null>>;
}

export type OccIdOf = (mfcId: string, ordinal: number) => string;

/** A copy the decision creates: origin, head and status, in that order. */
export interface Created {
  occ: string;
  id: string;
  ordinal: number;
  head: string;
  kind: Kind;
}

/** What a part of a decision (or an answer) writes and which bases it moves. */
export interface Effect {
  /** Existing copies' new status (null: a tombstone), by occ. */
  statuses: Map<string, Kind | 'former' | null>;
  created: Created[];
  /** S's figure values written (null: a tombstone). */
  fields: Map<Field, Value | null>;
  copyBases: Map<string, CopyBase>;
  fieldBases: Map<Field, Value | null>;
}

export const emptyEffect = (): Effect => ({ statuses: new Map(), created: [], fields: new Map(), copyBases: new Map(), fieldBases: new Map() });

export function mergeEffects(...effects: Effect[]): Effect {
  const out = emptyEffect();
  for (const e of effects) {
    for (const [k, v] of e.statuses) out.statuses.set(k, v);
    out.created.push(...e.created);
    for (const [k, v] of e.fields) out.fields.set(k, v);
    for (const [k, v] of e.copyBases) out.copyBases.set(k, v);
    for (const [k, v] of e.fieldBases) out.fieldBases.set(k, v);
  }
  return out;
}

export const writesAnything = (e: Effect): boolean => e.statuses.size > 0 || e.created.length > 0 || e.fields.size > 0;

const zero = (): Counts => ({ owned: 0, ordered: 0, wished: 0 });

/** Canonical MFC ids have no leading zeros, so length then text is numeric order. */
export const bytewise = (a: string, b: string): number => Number(a > b) - Number(a < b);
export const byId = (a: { id: string }, b: { id: string }): number => a.id.length - b.id.length || bytewise(a.id, b.id);

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

export interface Copy {
  head: string | null;
  status: string | null;
  origin: { id: string; ordinal: number } | null;
  /** Its filing, "{kind}/{id}", while live. */
  collection: string | null;
}

/** The user's copies and figure values, read from their facets. */
export class View {
  readonly copies = new Map<string, Copy>();
  private readonly byHead = new Map<string, Set<string>>();

  constructor(readonly st: FigureState) {
    for (const facet of st.facets.values()) {
      const m = /^occ\/([^/]+)\/(head|status|origin|collection)$/.exec(facet.facetKey);
      if (m === null) continue;
      const copy = this.copy(m[1]!);
      // Payloads stored here passed their schema; a tombstone is no value.
      const value = this.json(facet) as { head_id?: string; status?: string; native_id: string; ordinal: number; collection?: string } | null;
      if (m[2] === 'head') copy.head = value?.head_id ?? null;
      else if (m[2] === 'status') copy.status = value?.status ?? null;
      else if (m[2] === 'collection') copy.collection = value?.collection ?? null;
      // The origin is server-owned: the import writes it once and never tombstones it.
      else copy.origin = { id: value!.native_id, ordinal: value!.ordinal };
    }
    for (const [occ, base] of st.copyBases) {
      this.copy(occ);
      this.index(base.head, occ);
    }
    for (const [occ, c] of this.copies) if (c.head !== null) this.index(c.head, occ);
  }

  private copy(occ: string): Copy {
    let c = this.copies.get(occ);
    if (c === undefined) this.copies.set(occ, (c = { head: null, status: null, origin: null, collection: null }));
    return c;
  }

  private index(head: string, occ: string): void {
    let set = this.byHead.get(head);
    if (set === undefined) this.byHead.set(head, (set = new Set()));
    set.add(occ);
  }

  json(facet: Facet | undefined): Record<string, unknown> | null {
    return facet === undefined || facet.op === 'delete' ? null : (JSON.parse(facet.payload) as Record<string, unknown>);
  }

  /** The copies of S: its head is S, or its base's is. In occ-id order. */
  copiesOf(S: string): string[] {
    return [...(this.byHead.get(S) ?? [])].sort(bytewise);
  }

  curKind(occ: string, S: string): KindOrOut {
    const c = this.copies.get(occ)!;
    return c.head === S && (KINDS as readonly (string | null)[]).includes(c.status) ? (c.status as Kind) : OUT;
  }

  baseKind(occ: string, S: string): KindOrOut {
    const b = this.st.copyBases.get(occ);
    return b !== undefined && b.head === S ? b.kind : OUT;
  }

  removedByImport(occ: string): boolean {
    return this.st.copyBases.get(occ)?.removed === true;
  }

  /** What the app shows for S's field (sync.proto rule 6, on S's own head); null for none. */
  field(S: string, f: Field): Value | null {
    const value = this.json(this.st.facets.get(`uf/${S}/${f}`))?.[f];
    return value === undefined ? null : (value as Value);
  }

  fieldBase(S: string, f: Field): Value | null {
    return this.st.fieldBases.get(S)?.get(f) ?? null;
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

/** MFC's value of a field: the first row, in id order, that states one; null for none. */
export const mfcField = (exp: readonly Row[], f: Field): Value | null => exp.find((r) => r.fields[f] !== undefined)?.fields[f] ?? null;

type Transition = readonly [KindOrOut, KindOrOut];

/**
 * MFC's change split into TRANSITIONS: d_k = M_k - B_k gives, in this order, ordered->owned,
 * wished->ordered and wished->owned, as many as both sides allow, then k->out for each remaining
 * negative d_k and out->k for each remaining positive d_k.
 */
export function transitionsOf(M: Counts, B: Counts): Transition[] {
  const d = { owned: M.owned - B.owned, ordered: M.ordered - B.ordered, wished: M.wished - B.wished };
  const out: Transition[] = [];
  const convert = (x: Kind, y: Kind): void => {
    const n = Math.min(Math.max(0, -d[x]), Math.max(0, d[y]));
    for (let i = 0; i < n; i += 1) out.push([x, y]);
    d[x] += n;
    d[y] -= n;
  };
  convert('ordered', 'owned');
  convert('wished', 'ordered');
  convert('wished', 'owned');
  for (const k of KINDS) for (let i = 0; i < -d[k]; i += 1) out.push([k, OUT]);
  for (const k of KINDS) for (let i = 0; i < d[k]; i += 1) out.push([OUT, k]);
  return out;
}

const kindsOf = (t: Transition): KindOrOut[] => t.filter((k) => k !== OUT);
const shareKind = (a: Transition, b: Transition): boolean => kindsOf(a).some((k) => kindsOf(b).includes(k));

/** A copy's working state while a decision or an answer simulates its writes. */
class Work {
  readonly cur: Map<string, KindOrOut>;
  readonly removed = new Set<string>();
  readonly restored = new Set<string>();
  readonly created: Created[] = [];
  private readonly made = new Map<string, Set<number>>();

  constructor(
    readonly v: View,
    readonly S: string,
    readonly cs: readonly string[],
  ) {
    this.cur = new Map(cs.map((c) => [c, v.curKind(c, S)]));
  }

  /** The live copies of kind k whose origin is row `id`, created ones included. */
  live(id: string, k: Kind): number {
    const existing = this.cs.filter((c) => this.cur.get(c) === k && this.v.copies.get(c)!.origin?.id === id).length;
    return existing + this.created.filter((c) => c.id === id && c.kind === k).length;
  }

  create(row: Row, kind: Kind, occId: OccIdOf): Created {
    const taken = this.made.get(row.id) ?? new Set<number>();
    const ordinal = this.v.ordinal(row.id, taken);
    this.made.set(row.id, taken.add(ordinal));
    const c: Created = { occ: occId(row.id, ordinal), id: row.id, ordinal, head: this.S, kind };
    this.created.push(c);
    return c;
  }

  remove(c: string): void {
    this.cur.set(c, OUT);
    this.removed.add(c);
    this.restored.delete(c);
  }

  restore(c: string, k: Kind): void {
    this.cur.set(c, k);
    if (!this.removed.delete(c)) this.restored.add(c);
  }

  /** The net status writes: each copy whose kind now differs from the one it had. */
  statuses(): Map<string, Kind | null> {
    const out = new Map<string, Kind | null>();
    for (const c of this.cs) {
      const now = this.cur.get(c)!;
      if (now !== this.v.curKind(c, this.S)) out.set(c, now === OUT ? null : now);
    }
    return out;
  }
}

/** Removal order: a copy with an origin before one without, then the highest occ id. */
const removalOrder =
  (v: View) =>
  (a: string, b: string): number =>
    Number(v.copies.get(a)!.origin === null) - Number(v.copies.get(b)!.origin === null) || bytewise(b, a);

/**
 * MATERIALIZE, on the copies the app left unchanged (base equal to current state), for each MFC
 * transition left.
 */
function materialize(v: View, S: string, exp: readonly Row[], B: Counts, Lm: readonly Transition[], occId: OccIdOf): Work {
  const cs = v.copiesOf(S);
  const w = new Work(v, S, cs);
  const unchanged = new Set(cs.filter((c) => v.baseKind(c, S) === v.curKind(c, S)));
  const P = zero();
  for (const k of KINDS) P[k] = Math.max(0, B[k] - cs.filter((c) => v.baseKind(c, S) === k).length);
  const used = new Set<string>();
  const free = (c: string) => unchanged.has(c) && !used.has(c);

  for (const [x, y] of Lm) {
    if (x !== OUT && y !== OUT) {
      if (P[x] > 0) {
        P[x] -= 1;
        P[y] += 1;
        continue;
      }
      // MATCHING leaves one: every copy based x that the app changed is paired (an unpaired one
      // would share x with this transition, a conflict), so MFC's transitions from x left number
      // at most x's placeholders and unchanged copies. Only the dry run for removals skips.
      const c = cs.find((o) => free(o) && w.cur.get(o) === x)!;
      used.add(c);
      w.cur.set(c, y);
    } else if (y === OUT) {
      if (P[x as Kind] > 0) {
        P[x as Kind] -= 1;
        continue;
      }
      const c = cs.filter((o) => free(o) && w.cur.get(o) === x).sort(removalOrder(v))[0];
      // A conflict's dry run for its removals (A COPY KEPT AGAINST MFC'S REMOVAL) may find none.
      if (c === undefined) continue;
      used.add(c);
      w.remove(c);
    } else {
      // The lowest-id copy an import removed that is still unchanged, removed by this decision included.
      const c = cs.find(
        (o) => w.cur.get(o) === OUT && v.copies.get(o)!.head === S && (w.removed.has(o) || (free(o) && v.removedByImport(o))),
      );
      if (c !== undefined) {
        used.add(c);
        w.restore(c, y);
        continue;
      }
      const rows = exp.filter((r) => r.kind === y);
      // Some row of kind y exists: d_y > 0 means MFC counts y on a row of S.
      const r = rows.find((row) => row.count - w.live(row.id, y) > 0) ?? rows[0]!;
      w.create(r, y, occId);
    }
  }
  return w;
}

/**
 * The effect of a simulated set of writes on S: statuses, creations, and each touched copy's base
 * at its new kind, with whether it is one an import removed (an answer's REALIGN moves the bases
 * again, and reads only that flag).
 */
function workEffect(w: Work, S: string): Effect {
  const e = emptyEffect();
  for (const [c, k] of w.statuses()) {
    e.statuses.set(c, k);
    e.copyBases.set(c, { head: S, kind: k ?? OUT, removed: w.removed.has(c) || (!w.restored.has(c) && w.v.removedByImport(c)) });
  }
  for (const c of w.created) {
    e.created.push(c);
    e.copyBases.set(c.occ, { head: S, kind: c.kind, removed: false });
  }
  return e;
}

export interface Decision {
  M: Counts;
  B: Counts;
  A: Counts;
  comps: Comps;
  conflict: boolean;
  /** What the counts part writes and moves, when the figure is not a conflict. */
  counts: Effect;
  /** What each figure value writes and moves, when the figure is not a conflict. */
  fields: Map<Field, Effect>;
  /** The copies MATERIALIZE would remove for MFC's unmatched transitions to out (A COPY KEPT AGAINST MFC'S REMOVAL). */
  removals: string[];
}

/** The rows of S as MFC states them now: the export's, and each row base it lacks as no value. */
export function lackedRows(exp: readonly Row[], baseRows: readonly Row[]): Row[] {
  const ids = new Set(exp.map((r) => r.id));
  return baseRows.filter((r) => !ids.has(r.id)).sort(byId);
}

/**
 * THE FIGURE DECISION for S: `exp` are the export's rows of S (rows unresolved for their Count or
 * product stand on their row base), `baseRows` the row bases of S.
 */
export function decide(v: View, S: string, exp: readonly Row[], baseRows: readonly Row[], occId: OccIdOf): Decision {
  const M = zero();
  const B = zero();
  const A = zero();
  for (const r of exp) M[r.kind] += r.count;
  for (const r of baseRows) B[r.kind] += r.count;
  const cs = v.copiesOf(S);
  for (const c of cs) {
    const k = v.curKind(c, S);
    if (k !== OUT) A[k] += 1;
  }
  const comps: Comps = { counts: 'nochange', score: 'nochange', note: 'nochange', wishability: 'nochange', details: {} };
  let counts = emptyEffect();
  let Lm: Transition[] = [];
  const atCurrent = (cbs: Effect, c: string): void => {
    cbs.copyBases.set(c, { head: S, kind: v.curKind(c, S), removed: v.removedByImport(c) });
  };

  if (KINDS.every((k) => M[k] === B[k])) {
    comps.counts = 'nochange';
  } else if (KINDS.every((k) => A[k] === M[k])) {
    comps.counts = 'alike';
    for (const c of cs) if (v.baseKind(c, S) !== v.curKind(c, S)) atCurrent(counts, c);
  } else {
    const app = cs.filter((c) => v.baseKind(c, S) !== v.curKind(c, S)).map((c) => ({ occ: c, t: [v.baseKind(c, S), v.curKind(c, S)] as Transition }));
    const paired = new Set<string>();
    for (const m of transitionsOf(M, B)) {
      const a = app.find((x) => !paired.has(x.occ) && x.t[0] === m[0] && x.t[1] === m[1]);
      if (a === undefined) Lm.push(m);
      else paired.add(a.occ);
    }
    const La = app.filter((x) => !paired.has(x.occ));
    for (const c of paired) atCurrent(counts, c);
    if (Lm.length === 0) {
      comps.counts = 'matched+app-only';
    } else if (!La.some((a) => Lm.some((m) => shareKind(a.t, m)))) {
      comps.counts = 'apply';
      counts = mergeEffects(counts, workEffect(materialize(v, S, exp, B, Lm, occId), S));
    } else {
      comps.counts = 'conflict';
    }
  }
  const removals = [...materialize(v, S, exp, B, Lm.filter((t) => t[1] === OUT), occId).removed];

  // The fields, each on its own, against each row's own base.
  const fields = new Map<Field, Effect>();
  const lacked = lackedRows(exp, baseRows);
  for (const f of FIELDS) {
    const baseOf = (id: string): Value | null => v.st.rowBases.get(id)?.fields[f] ?? null;
    const changed = [...exp.map((r) => [r.id, r.fields[f] ?? null] as const), ...lacked.map((r) => [r.id, null] as const)].filter(
      ([id, value]) => value !== baseOf(id),
    );
    if (changed.length === 0) continue;
    const values = [...new Set(changed.map(([, value]) => value))];
    if (values.length > 1) {
      comps[f] = 'conflict';
      continue;
    }
    const value = values[0]!;
    const app = v.field(S, f);
    const e = emptyEffect();
    if (app === value) {
      comps[f] = 'alike';
    } else if (app === v.fieldBase(S, f)) {
      comps[f] = 'apply';
      e.fields.set(f, value);
    } else {
      comps[f] = 'conflict';
      comps.details[f] = { ...(app !== null ? { app } : {}), ...(value !== null ? { mfc: value } : {}) };
      continue;
    }
    e.fieldBases.set(f, value);
    fields.set(f, e);
  }

  const conflict = comps.counts === 'conflict' || FIELDS.some((f) => comps[f] === 'conflict');
  return { M, B, A, comps, conflict, counts, fields, removals };
}

/**
 * keep: every part the rev lists as disputed stays at the app's side; a part the rev found only
 * MFC changed is applied where, decided again now (`d`), it is still MFC's change alone.
 */
export function keepEffect(found: Comps, d: Decision): Effect {
  const parts: Effect[] = [];
  if (found.counts === 'apply' && d.comps.counts === 'apply') parts.push(d.counts);
  for (const f of FIELDS) if (found[f] === 'apply' && d.comps[f] === 'apply') parts.push(d.fields.get(f)!);
  return mergeEffects(...parts);
}

/** The conversions take makes, arrivals first. */
const CONVERSIONS: readonly (readonly [Kind, Kind])[] = [
  ['ordered', 'owned'],
  ['wished', 'ordered'],
  ['wished', 'owned'],
  ['owned', 'ordered'],
  ['owned', 'wished'],
  ['ordered', 'wished'],
];

/**
 * take: MFC's side made true on the copies MFC tracks (a live base): conversions first, arrivals
 * first, lowest occ id; then removals (an origin before none, then the highest occ id); then
 * restoring a copy that is out, a tracked one first and one whose base is the kind first, then one
 * an import removed, lowest occ id; then new copies, each for the lowest-numbered row of the kind
 * at its lowest unused ordinal. A copy with no base is never changed, but for one an import
 * removed. Each field the rev found changed by MFC or disputed takes MFC's value.
 */
export function takeEffect(v: View, S: string, exp: readonly Row[], found: Comps, occId: OccIdOf): Effect {
  const cs = v.copiesOf(S);
  const w = new Work(v, S, cs);
  const M = zero();
  for (const r of exp) M[r.kind] += r.count;
  const tracked = cs.filter((c) => v.baseKind(c, S) !== OUT);
  const count = (k: Kind) => tracked.filter((c) => w.cur.get(c) === k).length + w.created.filter((c) => c.kind === k).length;
  for (const [x, y] of CONVERSIONS) {
    while (count(x) > M[x] && count(y) < M[y]) w.cur.set(tracked.find((c) => w.cur.get(c) === x)!, y);
  }
  for (const x of KINDS) {
    while (count(x) > M[x]) w.remove(tracked.filter((c) => w.cur.get(c) === x).sort(removalOrder(v))[0]!);
  }
  for (const y of KINDS) {
    while (count(y) < M[y]) {
      const out = cs.filter((c) => w.cur.get(c) === OUT && v.copies.get(c)!.head === S);
      const c =
        out.find((o) => tracked.includes(o) && v.baseKind(o, S) === y) ??
        out.find((o) => tracked.includes(o)) ??
        out.find((o) => v.removedByImport(o) && !tracked.includes(o));
      if (c === undefined) break;
      if (!tracked.includes(c)) tracked.push(c);
      w.restore(c, y);
    }
    const row = exp.filter((r) => r.kind === y).sort(byId)[0];
    while (count(y) < M[y]) w.create(row!, y, occId);
  }
  const e = workEffect(w, S);
  for (const f of FIELDS) {
    if (found[f] !== 'apply' && found[f] !== 'conflict') continue;
    const value = mfcField(exp, f);
    if (v.field(S, f) !== value) e.fields.set(f, value);
  }
  return e;
}

/**
 * REALIGN after an answer: the row bases become the export's rows, the field bases MFC's values,
 * and per kind the live copies with the lowest occ ids, up to MFC's Count, get that base; other
 * copies get base out. `final` is each copy's kind once the answer's writes land.
 */
export function realign(S: string, exp: readonly Row[], final: ReadonlyMap<string, KindOrOut>, removed: (occ: string) => boolean): Effect {
  const e = emptyEffect();
  const M = zero();
  for (const r of exp) M[r.kind] += r.count;
  const occs = [...final.keys()].sort(bytewise);
  for (const k of KINDS) {
    occs.filter((c) => final.get(c) === k).forEach((c, i) => e.copyBases.set(c, { head: S, kind: i < M[k] ? k : OUT, removed: removed(c) }));
  }
  for (const c of occs) if (final.get(c) === OUT) e.copyBases.set(c, { head: S, kind: OUT, removed: removed(c) });
  for (const f of FIELDS) e.fieldBases.set(f, mfcField(exp, f));
  return e;
}

/** Each copy of S's kind once `effect` lands: what REALIGN and the knowing keeps read. */
export function finalKinds(v: View, S: string, effect: Effect): Map<string, KindOrOut> {
  const out = new Map(v.copiesOf(S).map((c) => [c, v.curKind(c, S)]));
  // Every status an effect writes is of a copy of S on S: a decision's, or one per_copy lists.
  for (const [c, k] of effect.statuses) out.set(c, k === null || k === 'former' ? OUT : k);
  for (const c of effect.created) out.set(c.occ, c.kind);
  return out;
}
