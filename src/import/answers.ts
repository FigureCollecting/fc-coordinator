// import.proto ITEMS AND ANSWERS, in Push. The user answers an item by writing res/mfc/{S}
// through Push, naming the item, its rev and a choice. An answer is accepted only while that item
// of S is pending with that rev and the choice is one the item allows; otherwise it is STALE, with
// `current`, and nothing is written. An accepted answer is applied in the Push's own transaction:
// the res facet, the answer's writes (each minted above the facet's current version, displayed at
// the answer's own time) and the item's tombstone.
//
//   figure item  keep: what the rev found MFC alone changed is applied where it is still MFC's
//                alone; take: MFC's side made true on the copies MFC tracks; per_copy: keep's part,
//                then the listed statuses and the side named per disputed field. Then the bases
//                REALIGN to MFC's side. A keep or per_copy on a rev that found the counts disputed
//                or changed by MFC alone is a KNOWING KEEP of each copy MATERIALIZE would remove
//                for MFC's unmatched transitions to out that the answer leaves live.
//   change entry undo: each facet the import wrote back to its value before, while every write
//                still holds what the import wrote (else STALE); a copy it removed that the undo
//                restores is a knowing keep. Moves no base. dismiss: the entry goes.
//
// Not built yet: held-edit cards and align-MFC entries (an answer naming one is STALE) and the
// acknowledgement a keep or an undo records.
import { canonicalVersion, SERVER_DEVICE_ID } from '@figurecollecting/fc-api-contract';
import { applyEvent, readFacet, serverNow, type Facet, type FeedTransaction, type SqlClient } from '../sync/store.js';
import { decide, emptyEffect, finalKinds, keepEffect, keptByAnswer, keptEndedByRealign, KINDS, lackedRows, mergeEffects, mfcField, realign, takeEffect, View, type Effect } from './figure.js';
import { importOccId } from './occ.js';
import { CHANGE_ITEM_PREFIX, FIGURE_ITEM_PREFIX, rowsOfSide, type KeptCopy } from './plan.js';
import type { Field, Kind } from './rows.js';
import type { HoldPolicy } from '../sync/service.js';
import { createLatePolicy } from './holds.js';
import { keptEndedBy } from './replay.js';
import { pendingReview, readFigureState, saveBases, saveKept } from './store.js';
import { writeVersion } from './version.js';
import { render, type Listed, type Shown, type Write } from './writes.js';

interface Answer {
  item: 'figure' | 'held' | 'change' | 'align';
  rev: string;
  choice: 'keep' | 'take' | 'per_copy' | 'undo' | 'dismiss';
  copies?: { occ: string; status: Kind | 'former' | 'removed' }[];
  fields?: Partial<Record<Field, 'app' | 'mfc'>>;
  edited_at: string;
  tz: string;
}

export interface ImportHooks {
  /**
   * An upsert of res/mfc/{S}: accepted and applied, or STALE, in the Push transaction under the
   * user lock. Undefined for any other edit, which the Push places by LWW.
   */
  answer(tx: SqlClient, userId: string, edit: Facet, feed: FeedTransaction): Promise<{ applied: boolean; current: Facet | undefined } | undefined>;
  /** After a Push's edits are applied: a knowing keep the user's own edit ends (the copy left its kind or figure). */
  applied(tx: SqlClient, userId: string, edits: readonly Facet[]): Promise<void>;
  /** StatusResponse.pending_review. */
  pendingReview(db: SqlClient, userId: string): Promise<bigint>;
  /** HELD and the replay of a late edit (./holds.ts), with the import's own key. */
  late: HoldPolicy;
}

const ANSWER_KEY = /^res\/mfc\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Whether every write a change entry lists still holds what the import wrote. */
function stillHolds(v: View, S: string, done: Listed): boolean {
  for (const c of done.copies) {
    const copy = v.copies.get(c.occ);
    if (copy === undefined) return false;
    if ((copy.status ?? 'removed') !== c.status) return false;
    if (c.head_id !== undefined && copy.head !== c.head_id) return false;
    if (c.collection !== undefined && copy.collection !== c.collection) return false;
  }
  return done.fields.every((f) => v.field(S, f.field) === (f[f.field] ?? null));
}

/** The writes of a listed set of copy and field values (a change entry's undo). */
function listedWrites(listed: Listed, shown: Shown): Write[] {
  const writes: Write[] = [];
  const upsert = (facetKey: string, body: object) => writes.push({ facetKey, op: 'upsert', payload: JSON.stringify({ ...body, ...shown }) });
  for (const c of listed.copies) {
    if (c.collection !== undefined) upsert(`occ/${c.occ}/collection`, { collection: c.collection });
    if (c.status === 'removed') writes.push({ facetKey: `occ/${c.occ}/status`, op: 'delete', payload: '' });
    else upsert(`occ/${c.occ}/status`, { status: c.status });
  }
  for (const f of listed.fields) {
    const value = f[f.field];
    if (value === undefined) writes.push({ facetKey: `uf/${f.head_id}/${f.field}`, op: 'delete', payload: '' });
    else upsert(`uf/${f.head_id}/${f.field}`, { [f.field]: value });
  }
  return writes;
}

const isKind = (s: string | undefined): s is Kind => (KINDS as readonly (string | undefined)[]).includes(s);

export function createImportHooks(occIdKey: Uint8Array | null): ImportHooks {
  return {
    async answer(tx, userId, edit, feed) {
      const m = ANSWER_KEY.exec(edit.facetKey);
      if (m === null || edit.op !== 'upsert') return undefined;
      const S = m[1]!;
      const stale = async () => ({ applied: false, current: await readFacet(tx, userId, edit.facetKey) });
      // Every pushed res payload has passed res-answer.schema.json.
      const ans = JSON.parse(edit.payload) as Answer;
      // Without the import key no import ran here, and a take could not name a copy it creates.
      if (occIdKey === null) return stale();
      const occId = (mfcId: string, ordinal: number) => importOccId(occIdKey, userId, mfcId, ordinal);

      const head = await tx.query<{ side: string }>('SELECT side FROM import_figure_item WHERE user_id = $1 AND head_id = $2', [userId, S]);
      const sideIds = head.rows.length > 0 ? Object.keys(JSON.parse(head.rows[0]!.side) as object) : [];
      const st = await readFigureState(tx, userId, S, [...sideIds, ...(await rowIdsOf(tx, userId, S))]);
      const v = new View(st);
      const shown = { edited_at: ans.edited_at, tz: ans.tz };

      if (ans.item === 'figure') {
        const item = st.items.get(S);
        if (item === undefined || item.rev !== ans.rev || !['keep', 'take', 'per_copy'].includes(ans.choice)) return stale();
        const res = await applyEvent(tx, userId, edit, feed);
        if (!res.applied) return { applied: false, current: res.current };

        const exp = rowsOfSide(item.side, S);
        const baseRows = [...st.rowBases.values()];
        const d = decide(v, S, exp, baseRows, occId);
        let effect: Effect;
        if (ans.choice === 'take') {
          effect = takeEffect(v, S, exp, item.comps, occId);
        } else {
          effect = keepEffect(item.comps, d);
          if (ans.choice === 'per_copy') {
            const listed = emptyEffect();
            // res-answer.schema.json requires copies with per_copy.
            for (const c of ans.copies!) {
              // Only a copy of S, on S: per_copy decides this figure's copies.
              if (v.copies.get(c.occ)?.head !== S) continue;
              const status = c.status === 'removed' ? null : c.status;
              if ((v.copies.get(c.occ)!.status ?? null) !== status) listed.statuses.set(c.occ, status);
            }
            for (const [f, side] of Object.entries(ans.fields ?? {}) as [Field, 'app' | 'mfc'][]) {
              if (side !== 'mfc' || item.comps[f] !== 'conflict') continue;
              const value = mfcField(exp, f);
              if (v.field(S, f) !== value) listed.fields.set(f, value);
            }
            effect = mergeEffects(effect, listed);
          }
        }
        const out = render(v, S, effect, shown);
        const version = await answerVersion(tx);
        for (const w of out.writes) await applyEvent(tx, userId, { ...w, version: writeVersion(version, st.facets.get(w.facetKey)?.version) }, feed);
        const itemKey = `${FIGURE_ITEM_PREFIX}${S}`;
        await applyEvent(tx, userId, { facetKey: itemKey, op: 'delete', payload: '', version: writeVersion(version, st.facets.get(itemKey)?.version) }, feed);

        // REALIGN, and the knowing keeps: added by keep or per_copy, dropped once MFC counts them.
        const final = finalKinds(v, S, effect);
        const bases = realign(S, exp, final, (c) => effect.copyBases.get(c)?.removed ?? v.removedByImport(c));
        const add = new Map<string, KeptCopy>([...keptByAnswer(ans.choice, item.comps, d.removals, final)].map(([c, kind]) => [c, { head: S, kind }]));
        const gone = keptEndedByRealign(new Map([...st.kept, ...add]), final, bases.copyBases);
        await saveBases(tx, userId, item.raised, {
          rows: exp,
          rowsGone: lackedRows(exp, baseRows).map((r) => r.id),
          copies: bases.copyBases,
          fields: [...bases.fieldBases].map(([field, value]) => ({ head: S, field, value })),
          items: { set: [], end: [S] },
          kept: { add: new Map([...add].filter(([c]) => !gone.includes(c))), gone: gone.filter((c) => st.kept.has(c)) },
        });
        return { applied: true, current: edit };
      }

      if (ans.item === 'change') {
        const key = `${CHANGE_ITEM_PREFIX}${S}`;
        const entry = v.json(st.facets.get(key)) as { rev: string; writes: Listed; undo: Listed } | null;
        if (entry === null || entry.rev !== ans.rev || !['undo', 'dismiss'].includes(ans.choice)) return stale();
        if (ans.choice === 'undo' && !stillHolds(v, S, entry.writes)) return stale();
        const res = await applyEvent(tx, userId, edit, feed);
        if (!res.applied) return { applied: false, current: res.current };
        const version = await answerVersion(tx);
        const add = new Map<string, KeptCopy>();
        if (ans.choice === 'undo') {
          for (const w of listedWrites(entry.undo, shown)) {
            await applyEvent(tx, userId, { ...w, version: writeVersion(version, st.facets.get(w.facetKey)?.version) }, feed);
          }
          // Each copy the change removed that the undo restores is kept against MFC's removal.
          for (const c of entry.writes.copies) {
            const back = entry.undo.copies.find((u) => u.occ === c.occ)?.status;
            if (c.status === 'removed' && isKind(back)) add.set(c.occ, { head: S, kind: back });
          }
        }
        await applyEvent(tx, userId, { facetKey: key, op: 'delete', payload: '', version: writeVersion(version, st.facets.get(key)?.version) }, feed);
        await saveKept(tx, userId, add, []);
        return { applied: true, current: edit };
      }
      // A held-edit card or an align-MFC entry: none is kept yet, so none is pending.
      return stale();
    },

    async applied(tx, userId, edits) {
      const occs = [...new Set(edits.flatMap((e) => /^occ\/([^/]+)\/(?:status|head)$/.exec(e.facetKey)?.slice(1, 2) ?? []))];
      if (occs.length === 0) return;
      const { rows } = await tx.query<{ occ_id: string; head_id: string; kind: Kind }>(
        'SELECT occ_id, head_id, kind FROM import_kept_copy WHERE user_id = $1 AND occ_id = ANY($2::uuid[])',
        [userId, occs],
      );
      const gone = keptEndedBy(new Map(rows.map((k) => [k.occ_id, { head: k.head_id, kind: k.kind }])), edits);
      if (gone.length > 0) await tx.query('DELETE FROM import_kept_copy WHERE user_id = $1 AND occ_id = ANY($2::uuid[])', [userId, gone]);
    },

    pendingReview,

    late: createLatePolicy(occIdKey),
  };
}

/** An answer's writes: the server's clock, the reserved server device, minted above each facet. */
async function answerVersion(tx: SqlClient): Promise<string> {
  return canonicalVersion({ instant: (await serverNow(tx)).iso, counter: 0, deviceId: SERVER_DEVICE_ID });
}

async function rowIdsOf(tx: SqlClient, userId: string, S: string): Promise<string[]> {
  const { rows } = await tx.query<{ mfc_id: string }>('SELECT mfc_id FROM import_row_base WHERE user_id = $1 AND head_id = $2', [userId, S]);
  return rows.map((r) => r.mfc_id);
}
