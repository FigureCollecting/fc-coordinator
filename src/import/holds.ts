// import.proto HELD and LATE EDITS AND REPLAY, in Push. A LATE EDIT is a pushed edit to a copy or a
// figure value of a figure S whose basis is before the marker of an import that settled S (wrote
// to it or moved a base of it): its device made it without having seen that import. It is
// replayed just before the earliest such import, against S as that import found it (./replay.ts):
//
//   * the import decides S the same way: the edit is placed as it would have been. It is STALE
//     where the import (placed after it) wrote its facet, and placed by LWW otherwise;
//   * the import decides S otherwise: a REVISION. The server emits, in the Push's transaction, each
//     difference between S replayed and S as it has emitted it, moves S's bases, item and keeps to
//     the replay's, and records the revision when S's live copies or items change.
//
// A STALE answer is final: only a late edit that stood (APPLIED) is kept, so that a later replay
// places it again. One answered STALE is placed by no later replay or revision; its device was
// told the current value and may edit again.
//
// HELD only for a reaction to the result the replay would withdraw:
//   (i)   another device's edit to S arrived since the import (or rides the same Push), and
//   (iii) an answer on S was accepted since the edit's basis,
// each for a late edit whose replay changes the import's decision; and
//   (ii)  an edit made after a revision's import and before the revision, which its device had not
//         seen, that reacts to the result the revision withdrew (replay.ts `reacts`).
// (iv) never holds: frames are kept for good.
//
// Not built, so held as WK-14a held every late edit: a revision on a figure with other activity
// since the import (another device's edit, an answer, a later import of it), whether or not that
// activity reacts to the result; a revision for an edit late for two settled imports; a late edit
// whose replay leaves the decision as it was while an answer on S came after its basis; a frame
// recorded before migration 0006 (no snapshot); a replica without the import key. A held edit is
// kept with its basis (held_edit) and answered HELD with `current`; the held-edit card that shows
// and answers it is not built yet, though StatusResponse.pending_review counts it.
//
// Not late, as in WK-14a: an edit to a figure an import framed without settling it (a marker-only
// re-import, a conflict it only raised). LWW places it, so one that would have settled the
// conflict, replayed before that import, leaves the item pending.
//
// Units: one push's edits to one copy's head, status, collection and disposal are one unit; every
// other edit is a unit with the push's other edits of its key. A unit is held or replayed whole.
import { SERVER_DEVICE_ID, canonicalVersion, compareVersion, parseUserFacetKey } from '@figurecollecting/fc-api-contract';
import type { HoldPolicy, LateOutcome, PushedEdit } from '../sync/service.js';
import { applyEvent, feedHead, serverNow, type Facet, type FeedTransaction, type SqlClient } from '../sync/store.js';
import { FIELDS, bytewise, stable, type CopyBase, type OccIdOf } from './figure.js';
import { importOccId } from './occ.js';
import type { KeptCopy, Plan, Row } from './plan.js';
import {
  decideAgain,
  figureKeys,
  isServerVersion,
  placeEdits,
  reacts,
  sameDecision,
  summarize,
  keptEndedBy,
  type Frame,
  type FrameBefore,
  type Revision,
  type Summary,
} from './replay.js';
import { figureOccs, saveBases } from './store.js';
import { writeVersion } from './version.js';

const COPY_UNIT = new Set(['occ/head', 'occ/status', 'occ/collection', 'occ/disposal']);

/** A head payload's head_id: every one stored or pushed has passed occ-head.schema.json. */
const headOf = (payload: string): string => (JSON.parse(payload) as { head_id: string }).head_id;

const occOf = (facetKey: string): string | null => /^occ\/([^/]+)\//.exec(facetKey)?.[1] ?? null;

/** A pushed edit, its unit, and the figures it touches. */
interface Placed {
  e: PushedEdit;
  unit: string;
  heads: string[];
  occ: string | null;
}

interface FrameRow {
  head: string;
  importNumber: number;
  exportDate: string;
  marker: bigint;
  /** The seq that opened the import's transaction: S just before the import is the feed below it. */
  start: bigint;
  settled: boolean;
  before: FrameBefore | null;
}

/** A late edit replayed and APPLIED, under the earliest import it is late for. */
interface Recorded {
  importNumber: number;
  facet: Facet;
}

type Verdict =
  | { kind: 'hold' }
  /** `stale`: the late edits (by index) a replayed decision wrote over; LWW places the rest. */
  | { kind: 'unchanged'; stale: Set<number> }
  | { kind: 'revise'; write: (feed: FeedTransaction) => Promise<Map<number, LateOutcome>> };

const HOLD: Verdict = { kind: 'hold' };

/** Each edit's unit and figures: a copy's head as stored and as this push writes it. */
async function placeOnFigures(tx: SqlClient, userId: string, edits: readonly PushedEdit[]): Promise<Placed[]> {
  const pushedHeads = new Map<string, string>();
  for (const e of edits) {
    const m = /^occ\/([^/]+)\/head$/.exec(e.facetKey);
    if (m !== null && e.op === 'upsert') pushedHeads.set(m[1]!, headOf(e.payload));
  }
  const occs = [...new Set(edits.flatMap((e) => occOf(e.facetKey) ?? []))];
  const { rows: stored } = await tx.query<{ facet_key: string; payload: string }>(
    "SELECT facet_key, payload FROM facet_state WHERE user_id = $1 AND facet_key = ANY($2::text[]) AND op = 'upsert'",
    [userId, occs.map((occ) => `occ/${occ}/head`)],
  );
  const storedHeads = new Map(stored.map((r) => [r.facet_key.split('/')[1]!, headOf(r.payload)]));
  return edits.map((e) => {
    const key = parseUserFacetKey(e.facetKey)!;
    if (key.family.startsWith('uf/')) return { e, unit: e.facetKey, heads: [(key as { headId: string }).headId], occ: null };
    const occ = occOf(e.facetKey);
    if (occ === null) return { e, unit: e.facetKey, heads: [], occ: null };
    // A copy moved out of a figure is an edit to that figure as much as one moved into it.
    const heads = [...new Set([storedHeads.get(occ), pushedHeads.get(occ)].filter((h): h is string => h !== undefined))];
    return { e, unit: COPY_UNIT.has(key.family) ? `occ/${occ}` : e.facetKey, heads, occ };
  });
}

/**
 * The frames of `heads` whose import marker is after `after` (the push's oldest basis). A frame whose
 * marker is the basis itself was seen; reading it too would change nothing, since an edit is late
 * only before a marker above its basis and replayFigure counts only those.
 */
async function readFrames(tx: SqlClient, userId: string, heads: readonly string[], after: bigint): Promise<FrameRow[]> {
  const { rows } = await tx.query<{ head_id: string; import_number: number; export_date: string; marker: string; start: string; settled: boolean; before: FrameBefore | null }>(
    `SELECT f.head_id, f.import_number, to_char(r.export_date, 'YYYY-MM-DD') AS export_date, r.marker_seq AS marker, f.settled, f.before,
            (SELECT max(e.seq) FROM feed_event e WHERE e.user_id = r.user_id AND e.opens_txn AND e.seq <= r.marker_seq) AS start
       FROM import_frame f JOIN import_run r ON r.user_id = f.user_id AND r.import_number = f.import_number
      WHERE f.user_id = $1 AND f.head_id = ANY($2::uuid[]) AND r.marker_seq > $3
      ORDER BY r.marker_seq`,
    [userId, heads, after.toString()],
  );
  return rows.map((r) => ({
    head: r.head_id,
    importNumber: r.import_number,
    exportDate: r.export_date,
    marker: BigInt(r.marker),
    start: BigInt(r.start),
    settled: r.settled,
    before: r.before,
  }));
}

type FacetRow = { facet_key: string; version: string; op: 'upsert' | 'delete'; payload: string };
const toFacets = (rows: FacetRow[]) => new Map(rows.map((r): [string, Facet] => [r.facet_key, { facetKey: r.facet_key, version: r.version, op: r.op, payload: r.payload }]));

/** `keys` as the feed had them just before `seq`. */
async function facetsBefore(tx: SqlClient, userId: string, keys: readonly string[], seq: bigint): Promise<Map<string, Facet>> {
  const { rows } = await tx.query<FacetRow>(
    `SELECT DISTINCT ON (facet_key) facet_key, version, op, payload FROM feed_event
      WHERE user_id = $1 AND facet_key = ANY($2::text[]) AND seq < $3 ORDER BY facet_key, seq DESC`,
    [userId, keys, seq.toString()],
  );
  return toFacets(rows);
}

async function facetsNow(tx: SqlClient, userId: string, keys: readonly string[]): Promise<Map<string, Facet>> {
  const { rows } = await tx.query<FacetRow>('SELECT facet_key, version, op, payload FROM facet_state WHERE user_id = $1 AND facet_key = ANY($2::text[])', [userId, keys]);
  return toFacets(rows);
}

async function readLateEdits(tx: SqlClient, userId: string, S: string): Promise<Recorded[]> {
  const { rows } = await tx.query<FacetRow & { import_number: number }>(
    'SELECT import_number, facet_key, version, op, payload FROM import_late_edit WHERE user_id = $1 AND head_id = $2',
    [userId, S],
  );
  return rows.map((r) => ({ importNumber: r.import_number, facet: { facetKey: r.facet_key, version: r.version, op: r.op, payload: r.payload } }));
}

async function readRevisions(tx: SqlClient, userId: string, after: bigint): Promise<Revision[]> {
  const { rows } = await tx.query<{ head_id: string; marker: string; seq: string; before: Summary; after: Summary }>(
    `SELECT v.head_id, r.marker_seq AS marker, v.seq, v.before, v.after FROM import_revision v
       JOIN import_run r ON r.user_id = v.user_id AND r.import_number = v.import_number
      WHERE v.user_id = $1 AND v.seq > $2`,
    [userId, after.toString()],
  );
  return rows.map((r) => ({ head: r.head_id, marker: BigInt(r.marker), seq: BigInt(r.seq), before: r.before, after: r.after }));
}

/**
 * HELD (ii): the units with an edit made after a revision's import and before the revision, which
 * reacts to the result the revision withdrew.
 */
async function reactions(tx: SqlClient, userId: string, placed: readonly Placed[]): Promise<Set<string>> {
  const units = new Set<string>();
  const touching = placed.filter((t) => t.heads.length > 0 || t.occ !== null);
  if (touching.length === 0) return units;
  const minBasis = touching.reduce((m, t) => (t.e.basisSeq < m ? t.e.basisSeq : m), touching[0]!.e.basisSeq);
  const revisions = await readRevisions(tx, userId, minBasis);
  for (const t of touching) {
    for (const r of revisions) {
      if (t.e.basisSeq < r.marker || t.e.basisSeq >= r.seq) continue;
      const onFigure = t.heads.includes(r.head);
      // A copy the revision summarised is S's whatever its head is now: the revision may have taken it out.
      // Both summaries are taken over the same copies (reviseOrHold), so either side names it; both are read.
      if (!onFigure && !(t.occ !== null && (t.occ in r.before.copies || t.occ in r.after.copies))) continue;
      const headOrStatus = /^occ\/[^/]+\/(head|status)$/.test(t.e.facetKey);
      const hadHead = !(onFigure && headOrStatus) || (await hadHeadBy(tx, userId, t.occ!, r.marker));
      const saw = onFigure && headOrStatus ? await itemsSeen(tx, userId, r.head, t.e.basisSeq) : [];
      if (reacts(r, t.e.facetKey, onFigure, hadHead, saw)) units.add(t.unit);
    }
  }
  return units;
}

/**
 * Whether the server had emitted a head of the copy by `seq` (the import's marker). The event at the
 * marker is the import's marker facet, never a head, so `<=` and `<` read the same.
 */
async function hadHeadBy(tx: SqlClient, userId: string, occ: string, seq: bigint): Promise<boolean> {
  const { rows } = await tx.query("SELECT 1 FROM feed_event WHERE user_id = $1 AND facet_key = $2 AND op = 'upsert' AND seq <= $3 LIMIT 1", [userId, `occ/${occ}/head`, seq.toString()]);
  return rows.length > 0;
}

/** The revs of S's items pending as a device whose basis is `seq` saw them. */
async function itemsSeen(tx: SqlClient, userId: string, S: string, seq: bigint): Promise<string[]> {
  const facets = await facetsBefore(tx, userId, [`imp/mfc/figure/${S}`, `imp/mfc/change/${S}`], seq + 1n);
  return [...facets.values()].flatMap((f) => (f.op === 'upsert' ? [(JSON.parse(f.payload) as { rev: string }).rev] : []));
}

const keyOf = (f: Facet): string => f.facetKey;
const occsOf = (fs: readonly Facet[]): string[] => fs.flatMap((f) => occOf(f.facetKey) ?? []);
const unique = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
const sameValue = (a: Facet | undefined, b: Facet | undefined): boolean => (a?.op ?? 'delete') === (b?.op ?? 'delete') && (a?.payload ?? '') === (b?.payload ?? '');

export function createLatePolicy(occIdKey: Uint8Array | null): HoldPolicy {
  return async (tx, userId, edits, feed) => {
    const out = new Map<number, LateOutcome>();
    const { rows: last } = await tx.query<{ seq: string | null }>('SELECT max(marker_seq) AS seq FROM import_run WHERE user_id = $1', [userId]);
    if (last[0]!.seq === null) return out;

    const placed = await placeOnFigures(tx, userId, edits);
    const held = await reactions(tx, userId, placed);

    // The late edits, by figure: an edit is late on S when its basis is before a settled frame of S.
    const framed = placed.filter((t) => t.heads.length > 0);
    const minBasis = framed.reduce((m, t) => (t.e.basisSeq < m ? t.e.basisSeq : m), BigInt(last[0]!.seq));
    const frames = await readFrames(tx, userId, unique(framed.flatMap((t) => t.heads)), minBasis);
    const lateOn = new Map<string, Placed[]>();
    const figuresOfUnit = new Map<string, Set<string>>();
    for (const t of framed) {
      for (const S of t.heads) {
        if (!frames.some((f) => f.head === S && f.settled && t.e.basisSeq < f.marker)) continue;
        lateOn.set(S, [...(lateOn.get(S) ?? []), t]);
        figuresOfUnit.set(t.unit, (figuresOfUnit.get(t.unit) ?? new Set()).add(S));
      }
    }

    const occId: OccIdOf | null = occIdKey === null ? null : (mfcId, ordinal) => importOccId(occIdKey, userId, mfcId, ordinal);
    const revisions: { S: string; units: string[]; write: (feed: FeedTransaction) => Promise<Map<number, LateOutcome>> }[] = [];
    const replayed: { S: string; e: PushedEdit }[] = [];
    for (const S of [...lateOn.keys()].sort(bytewise)) {
      const late = lateOn.get(S)!;
      const units = unique(late.map((t) => t.unit));
      const knowing = framed.some((t) => t.heads.includes(S) && !late.includes(t));
      const verdict = occId === null ? HOLD : await replayFigure(tx, userId, S, late.map((t) => t.e), frames.filter((f) => f.head === S), knowing, occId);
      if (verdict.kind === 'hold') {
        for (const u of units) held.add(u);
      } else if (verdict.kind === 'revise') {
        revisions.push({ S, units, write: verdict.write });
      } else {
        for (const index of verdict.stale) out.set(index, 'stale');
        replayed.push(...late.map((t) => ({ S, e: t.e })));
      }
    }
    // A revision replays its figure's late units alone and whole: one held for another reason, or
    // late on another figure too, holds them all.
    for (const r of revisions) {
      if (r.units.some((u) => held.has(u) || figuresOfUnit.get(u)!.size > 1)) {
        for (const u of r.units) held.add(u);
        continue;
      }
      for (const [index, outcome] of await r.write(feed)) out.set(index, outcome);
      replayed.push(...lateOn.get(r.S)!.map((t) => ({ S: r.S, e: t.e })));
    }

    for (const t of placed) if (held.has(t.unit)) out.set(t.e.index, 'held');
    // A late edit no replay answered (a decision left as it was, its facet not written) is placed
    // here by LWW, in push order, and once though it is late on two figures (the outcome set the
    // first time skips it): its outcome is known before it is kept. The service places the push's
    // other edits after these, so one ahead of a late edit in the push, to its key at a higher
    // version, makes it STALE here, as push order would.
    const lateIndex = new Set(replayed.map((r) => r.e.index));
    const newerAhead = (e: PushedEdit) => edits.some((o) => o.index < e.index && !lateIndex.has(o.index) && o.facetKey === e.facetKey && compareVersion(o.version, e.version) > 0);
    for (const e of replayed.map((r) => r.e).sort((p, q) => p.index - q.index)) {
      if (!out.has(e.index)) out.set(e.index, newerAhead(e) || !(await applyEvent(tx, userId, e, feed)).applied ? 'stale' : 'applied');
    }
    // A STALE answer is final: only a late edit that stood is kept, under its earliest import, so a
    // later replay places it before that import and each later one.
    for (const { S, e } of replayed) {
      if (out.get(e.index) !== 'applied') continue;
      const f = frames.find((x) => x.head === S && x.settled && e.basisSeq < x.marker)!;
      await tx.query(
        `INSERT INTO import_late_edit (user_id, import_number, head_id, facet_key, version, op, payload) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [userId, f.importNumber, S, e.facetKey, e.version, e.op, e.payload],
      );
    }
    return out;
  };
}

/** The replay of S's late edits in one Push: held, the decision as it was, or a revision. */
async function replayFigure(
  tx: SqlClient,
  userId: string,
  S: string,
  late: readonly PushedEdit[],
  framesOfS: readonly FrameRow[],
  knowing: boolean,
  occId: OccIdOf,
): Promise<Verdict> {
  const minBasis = late.reduce((m, e) => (e.basisSeq < m ? e.basisSeq : m), late[0]!.basisSeq);
  const settled = framesOfS.filter((f) => f.settled && f.marker > minBasis);
  if (settled.some((f) => f.before === null)) return HOLD;
  // An answer on S since the edits were made: HELD (iii) when the replay changes the decision; a
  // replay through an answer is not built, so held either way.
  const { rows: answers } = await tx.query('SELECT 1 FROM feed_event WHERE user_id = $1 AND facet_key = $2 AND seq > $3 LIMIT 1', [userId, `res/mfc/${S}`, minBasis.toString()]);
  if (answers.length > 0) return HOLD;
  const recorded = await readLateEdits(tx, userId, S);

  // Each late edit an earlier frame's decision wrote over: STALE, and placed before no later import.
  // Per edit: one made after that import is not written over by it.
  const stale = new Set<number>();
  for (const f of settled) {
    const frame: Frame = { importNumber: f.importNumber, exportDate: f.exportDate, before: f.before! };
    const here = late.filter((e) => e.basisSeq < f.marker && !stale.has(e.index));
    // Each late edit that stood is placed just before its own import and each later one: it is on
    // the feed before any import that ran after it was applied, which wrote it, if at all, at a
    // version above it (version.ts writeVersion), so placing it there leaves what the feed had.
    const placedBefore = recorded.filter((r) => r.importNumber <= f.importNumber).map((r) => r.facet);
    const occs = unique([...f.before!.occs, ...occsOf(here), ...occsOf(placedBefore)]);
    const pre = await facetsBefore(tx, userId, unique([...figureKeys(S, occs), ...here.map(keyOf), ...placedBefore.map(keyOf)]), f.start);
    const as = decideAgain(frame, S, pre, placedBefore, occId);
    const again = decideAgain(frame, S, pre, [...placedBefore, ...here], occId);
    if (!sameDecision(as, again)) {
      // A revision is built for one import whose figure nothing else touched since.
      if (settled.length > 1 || knowing) return HOLD;
      return reviseOrHold(tx, userId, S, f, frame, late, placedBefore, recorded, pre, again);
    }
    // The same decision: `as` writes these keys too (sameDecision leaves out only item upserts, and
    // a late edit is never to an item).
    const written = new Set(again.writes.map((w) => w.facetKey));
    for (const e of here) if (written.has(e.facetKey)) stale.add(e.index);
  }
  return { kind: 'unchanged', stale };
}

/**
 * A REVISION of S for import `f`, when nothing touched S since `f` but the late edits already
 * replayed: no later import framed it, and every edit to it since is a replayed late edit or a
 * revision's own write. Else HELD (i): another device's edit since may be a reaction.
 */
async function reviseOrHold(
  tx: SqlClient,
  userId: string,
  S: string,
  f: FrameRow,
  frame: Frame,
  late: readonly PushedEdit[],
  placedBefore: readonly Facet[],
  recorded: readonly Recorded[],
  pre: ReadonlyMap<string, Facet>,
  again: Plan,
): Promise<Verdict> {
  const { rows: later } = await tx.query(
    `SELECT 1 FROM import_frame x JOIN import_run r ON r.user_id = x.user_id AND r.import_number = x.import_number
      WHERE x.user_id = $1 AND x.head_id = $2 AND r.marker_seq > $3 LIMIT 1`,
    [userId, S, f.marker.toString()],
  );
  if (later.length > 0) return HOLD;
  const b = frame.before;
  const ids = unique([...b.rows, ...b.rowBases].map((r) => r.id));
  const occs = unique([...b.occs, ...occsOf(late), ...occsOf(recorded.map((r) => r.facet)), ...(await figureOccs(tx, userId, S, ids))]).sort(bytewise);
  const keys = figureKeys(S, occs);
  const { rows: since } = await tx.query<{ facet_key: string; version: string }>(
    `SELECT facet_key, version FROM feed_event
      WHERE user_id = $1 AND seq > $2 AND (facet_key = ANY($3::text[]) OR (facet_key LIKE 'occ/%' AND split_part(facet_key, '/', 2) = ANY($4::text[])))`,
    [userId, f.marker.toString(), [...keys, `res/mfc/${S}`], occs],
  );
  const replayedHere = new Set(recorded.map((r) => `${r.facet.facetKey}\n${r.facet.version}`));
  if (since.some((e) => !isServerVersion(e.version) && !replayedHere.has(`${e.facet_key}\n${e.version}`))) return HOLD;

  return {
    kind: 'revise',
    write: async (feed) => {
      // S replayed: its facets just before the import, every late edit for it placed, then the import's decision.
      const replay = placeEdits(pre, [...placedBefore, ...late]);
      for (const w of again.writes) replay.set(w.facetKey, { facetKey: w.facetKey, version: '', op: w.op, payload: w.payload });
      const lateKeys = unique(late.map(keyOf));
      const all = unique([...lateKeys, ...again.writes.map((w) => w.facetKey), ...[...keys].sort(bytewise)]);
      const current = await facetsNow(tx, userId, all);
      const version = canonicalVersion({ instant: (await serverNow(tx)).iso, counter: 0, deviceId: SERVER_DEVICE_ID });
      for (const key of all) {
        const value = replay.get(key);
        const now = current.get(key);
        // The origin is server-owned: never tombstoned, even for a copy the replay does not create.
        if (sameValue(value, now) || (value === undefined && key.endsWith('/origin'))) continue;
        const mine = late.find((e) => e.facetKey === key && e.version === value?.version);
        // A version names one edit: `now` at mine's version is mine, which sameValue skipped above.
        if (mine !== undefined && (now === undefined || compareVersion(mine.version, now.version) > 0)) {
          await applyEvent(tx, userId, { facetKey: key, version: mine.version, op: mine.op, payload: mine.payload }, feed);
        } else {
          await applyEvent(tx, userId, { facetKey: key, op: value?.op ?? 'delete', payload: value?.payload ?? '', version: writeVersion(version, now?.version) }, feed);
        }
      }
      await moveBases(tx, userId, S, f.importNumber, b, occs, again, [...placedBefore, ...late]);

      // What the revision changed of S's live copies and items, the late edits' own writes left out.
      const after = new Map(replay);
      for (const key of lateKeys) {
        const now = current.get(key);
        if (now === undefined) after.delete(key);
        else after.set(key, now);
      }
      const before = summarize(S, current, occs);
      const changed = summarize(S, after, occs);
      if (stable(before) !== stable(changed)) {
        await tx.query('INSERT INTO import_revision (user_id, import_number, head_id, seq, before, after) VALUES ($1, $2, $3, $4, $5, $6)', [
          userId,
          f.importNumber,
          S,
          (await feedHead(tx, userId)).toString(),
          JSON.stringify(before),
          JSON.stringify(changed),
        ]);
      }
      return new Map(late.map((e): [number, LateOutcome] => [e.index, replay.get(e.facetKey)?.version === e.version ? 'applied' : 'stale']));
    },
  };
}

/** S's bases, item and knowing keeps, as the replayed decision leaves them. */
async function moveBases(tx: SqlClient, userId: string, S: string, importNumber: number, b: FrameBefore, occs: readonly string[], again: Plan, placed: readonly Facet[]): Promise<void> {
  const ids = unique([...b.rows, ...b.rowBases].map((r) => r.id));
  const rows = new Map(b.rowBases.map((r) => [r.id, r]));
  for (const r of again.rowBases) rows.set(r.id, r);
  for (const id of again.rowBasesGone) rows.delete(id);
  const { rows: stored } = await tx.query<{ mfc_id: string; head_id: string; kind: Row['kind']; count: number; fields: Row['fields'] }>(
    'SELECT mfc_id, head_id, kind, count, fields FROM import_row_base WHERE user_id = $1 AND (head_id = $2 OR mfc_id = ANY($3::text[]))',
    [userId, S, ids],
  );
  const now = new Map(stored.map((r) => [r.mfc_id, stable({ id: r.mfc_id, head: r.head_id, kind: r.kind, count: r.count, fields: r.fields })]));

  const copies = new Map<string, CopyBase>(b.copyBases);
  for (const [occ, base] of again.copyBases) copies.set(occ, base);
  const { rows: based } = await tx.query<{ occ_id: string }>('SELECT occ_id FROM import_copy_base WHERE user_id = $1 AND occ_id = ANY($2::uuid[])', [userId, occs]);

  const fields = new Map(b.fieldBases);
  for (const fb of again.fieldBases) fields.set(fb.field, fb.value);

  const kept = new Map<string, KeptCopy>(b.kept);
  for (const occ of [...keptEndedBy(kept, placed), ...again.keptGone]) kept.delete(occ);
  const { rows: keptNow } = await tx.query<{ occ_id: string }>('SELECT occ_id FROM import_kept_copy WHERE user_id = $1 AND head_id = $2', [userId, S]);

  await saveBases(tx, userId, importNumber, {
    rows: [...rows.values()].filter((r) => now.get(r.id) !== stable(r)),
    rowsGone: [...now.keys()].filter((id) => !rows.has(id)),
    copies,
    copiesGone: based.map((r) => r.occ_id).filter((occ) => !copies.has(occ)),
    fields: FIELDS.map((field) => ({ head: S, field, value: fields.get(field) ?? null })),
    // A replay that raises no item ends S's: an earlier revision of the same import may have raised one.
    items: again.items.set.length > 0 ? { set: again.items.set, end: [] } : { set: [], end: [S] },
    kept: { add: kept, gone: keptNow.map((r) => r.occ_id).filter((occ) => !kept.has(occ)) },
  });
}
