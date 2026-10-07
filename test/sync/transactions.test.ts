// Contract 0.3.0's sync rules through the real Fastify app on a real database: rule 7 (a server
// transaction's events are consecutive and its last carries commit_cursor), SyncEvent.basis
// (required on Push; REJECTED basis_missing when absent) and the HELD outcome (import.proto HELD),
// with a stand-in hold policy and an import-shaped transaction written by the store's own writers.
import { randomUUID } from 'node:crypto';
import {
  PushOutcome,
  SERVER_DEVICE_ID,
  SyncOp,
  canonicalVersion,
  importMarkerKey,
  occFacetKey,
  occTagKey,
  ufFacetKey,
  type PushResult,
  type SyncEvent,
} from '@figurecollecting/fc-api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/sync/cursor.js';
import type { HoldPolicy, PushedEdit } from '../../src/sync/service.js';
import { FeedTransaction, applyEvent, lockUser, serverNow, transaction } from '../../src/sync/store.js';
import { Replica } from '../helpers/syncReplica.js';
import { DISPLAY, ok, startSyncApp, SyncCaller, type SyncApp } from '../helpers/syncClient.js';
import { startSyncDatabase, type SyncDatabase } from '../helpers/syncDatabase.js';

let db: SyncDatabase;
let h: SyncApp;
/** A replica whose hold policy is `frame` below: it holds an edit made before an import it is late for. */
let held: SyncApp;

/** The import frame the stand-in policy holds against: its marker's seq and the keys it decided. */
let frame: { userId: string; seq: bigint; keys: Set<string> } | undefined;
/** Every batch the stand-in policy was shown. */
const shown: PushedEdit[][] = [];
const lateForFrame: HoldPolicy = async (_tx, userId, edits) => {
  shown.push([...edits]);
  const f = frame;
  if (f === undefined || f.userId !== userId) return new Set();
  return new Set(edits.filter((e) => e.basisSeq < f.seq && f.keys.has(e.facetKey)).map((e) => e.index));
};

beforeAll(async () => {
  db = await startSyncDatabase();
  h = await startSyncApp(db.app);
  held = await startSyncApp(db.app, h.issuer, undefined, lateForFrame);
}, 240_000);

afterAll(async () => {
  await held?.close();
  await h?.close();
  await db?.close();
});

const status = (s: string) => JSON.stringify({ status: s, ...DISPLAY });
const head = (id: string) => JSON.stringify({ head_id: id, ...DISPLAY });
const score = (n: number) => JSON.stringify({ score: n, ...DISPLAY });
const tag = () => JSON.stringify({ ...DISPLAY });

/** A version for `caller`, `offsetMs` from now. */
const mint = (caller: SyncCaller, counter = 0, offsetMs = -60_000) =>
  canonicalVersion({ instant: new Date(Date.now() + offsetMs), counter, deviceId: caller.deviceId });

/** An UPSERT minted on `basis`; `null` leaves the basis unset. */
const edit = (facetKey: string, version: string, payload: string, basis: string | null = '') => ({
  facetKey,
  version,
  op: SyncOp.UPSERT,
  payload,
  ...(basis === null ? {} : { basis }),
});

const outcomes = (results: PushResult[]) => results.map((r) => [r.outcome, r.reason.split(':')[0]]);

async function drain(caller: SyncCaller, cursor = '', limit = 0): Promise<{ events: SyncEvent[]; cursor: string }> {
  const events: SyncEvent[] = [];
  for (;;) {
    const page = ok(await caller.delta({ cursor, limit }));
    events.push(...page.events);
    cursor = page.nextCursor;
    if (!page.hasMore) return { events, cursor };
  }
}

async function feedCount(userId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>('SELECT count(*) AS n FROM feed_event WHERE user_id = $1', [userId]);
  return Number(rows[0]!.n);
}

/** A new occurrence's head, status and a tag: three events, one Push, one transaction. */
function copy(caller: SyncCaller, basis = ''): ReturnType<typeof edit>[] {
  const occ = randomUUID();
  const [v1, v2, v3] = [mint(caller, 1), mint(caller, 2), mint(caller, 3)];
  return [
    edit(occFacetKey(occ, 'head'), v1, head(randomUUID()), basis),
    edit(occFacetKey(occ, 'status'), v2, status('owned'), basis),
    edit(occTagKey(occ, randomUUID()), v3, tag(), basis),
  ];
}

describe('rule 7: commit_cursor on Delta', () => {
  it('(c) carries commit_cursor on the last event of a multi-event transaction only, and it is the cursor just after it', async () => {
    const a = await SyncCaller.enrol(h);
    const events = copy(a);
    expect(outcomes(ok(await a.push({ clientId: randomUUID(), events })).results)).toEqual(events.map(() => [PushOutcome.APPLIED, '']));

    const page = ok(await a.delta({}));
    expect(page.events.map((e) => e.facetKey)).toEqual(events.map((e) => e.facetKey));
    const [first, second, last] = page.events;
    expect([first!.commitCursor, second!.commitCursor]).toEqual(['', '']);
    expect(last!.commitCursor).not.toBe('');
    expect(last!.commitCursor).toBe(page.nextCursor);
    const { rows } = await db.admin.query<{ seq: string }>('SELECT max(seq) AS seq FROM feed_event WHERE user_id = $1', [a.userId]);
    expect(decodeCursor(last!.commitCursor)).toBe(BigInt(rows[0]!.seq));
    // Delta carries no basis; a commit_cursor is a legal DeltaRequest.cursor.
    expect(page.events.every((e) => e.basis === undefined)).toBe(true);
    expect(ok(await a.delta({ cursor: last!.commitCursor }))).toMatchObject({ events: [], hasMore: false });
  });

  it('marks each transaction of a page, a page that ends inside one, and one resumed from inside', async () => {
    const a = await SyncCaller.enrol(h);
    const one = copy(a);
    const single = [edit(ufFacetKey(randomUUID(), 'score'), mint(a, 9), score(4))];
    const two = copy(a);
    for (const events of [one, single, two]) ok(await a.push({ clientId: randomUUID(), events }));

    const marks = (events: SyncEvent[]) => events.map((e) => e.commitCursor !== '');
    expect(marks(ok(await a.delta({})).events)).toEqual([false, false, true, true, false, false, true]);

    const p1 = ok(await a.delta({ limit: 2 }));
    expect([marks(p1.events), p1.hasMore]).toEqual([[false, false], true]);
    const p2 = ok(await a.delta({ cursor: p1.nextCursor, limit: 3 }));
    expect([marks(p2.events), p2.hasMore]).toEqual([[true, true, false], true]);
    const p3 = ok(await a.delta({ cursor: p2.nextCursor, limit: 2 }));
    expect([marks(p3.events), p3.hasMore]).toEqual([[false, true], false]);
    // Each commit_cursor is the next_cursor of a page that ends there.
    expect(p2.events[1]!.commitCursor).toBe(ok(await a.delta({ limit: 4 })).nextCursor);
  });

  it('closes a Push transaction on its last written event when later events of the batch write nothing', async () => {
    const a = await SyncCaller.enrol(h);
    const [h1, s1, t1] = copy(a);
    const missing = edit(t1!.facetKey, t1!.version, t1!.payload, null);
    const res = ok(await a.push({ clientId: randomUUID(), events: [h1!, edit(s1!.facetKey, s1!.version, '{}'), missing, edit(occTagKey(randomUUID(), randomUUID()), mint(a, 7), tag())] }));
    expect(outcomes(res.results)).toEqual([
      [PushOutcome.APPLIED, ''],
      [PushOutcome.REJECTED, 'payload_invalid'],
      [PushOutcome.REJECTED, 'basis_missing'],
      [PushOutcome.APPLIED, ''],
    ]);
    // A STALE last event writes nothing either.
    const stale = ok(await a.push({ clientId: randomUUID(), events: [edit(occTagKey(randomUUID(), randomUUID()), mint(a, 1), tag()), edit(h1!.facetKey, h1!.version, h1!.payload)] }));
    expect(outcomes(stale.results)).toEqual([[PushOutcome.APPLIED, ''], [PushOutcome.STALE, '']]);

    const events = ok(await a.delta({})).events;
    expect(events.map((e) => e.commitCursor !== '')).toEqual([false, true, true]);
    // `current` on a PushResult is no Delta event: it never carries commit_cursor.
    expect(res.results[0]!.current?.commitCursor).toBe('');
  });

  it('keeps another user out of a transaction: each user reads only its own feed', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.enrol(h);
    const ea = copy(a);
    const eb = copy(b);
    (await Promise.all([a.push({ clientId: randomUUID(), events: ea }), b.push({ clientId: randomUUID(), events: eb })])).forEach(ok);
    for (const caller of [a, b]) {
      expect(ok(await caller.delta({})).events.map((e) => e.commitCursor !== '')).toEqual([false, false, true]);
    }
  });
});

describe('(a) a 0.3.0 client', () => {
  it('applies a Push transaction only once the event carrying commit_cursor arrives, and exactly once', async () => {
    const a = await SyncCaller.enrol(h);
    const b = new Replica(await SyncCaller.sibling(h, a));
    const events = copy(a);
    ok(await a.push({ clientId: randomUUID(), events }));

    expect(await b.pull(1)).toBe(true);
    expect([b.local.size, b.staged.length, b.basis]).toEqual([0, 1, '']);
    expect(await b.pull(1)).toBe(true);
    expect([b.local.size, b.staged.length, b.basis]).toEqual([0, 2, '']);
    expect(await b.pull(1)).toBe(false);
    expect([b.local.size, b.staged.length]).toEqual([3, 0]);
    expect(b.basis).not.toBe('');

    // Nothing is fetched or applied again: the commit_cursor is where the client stands, and it is
    // the head Status reports, so a caught-up client is not shown as behind.
    await b.pullAll(1);
    expect(b.processed).toEqual(events.map((e) => `${e.facetKey}@${e.version}`));
    expect(b.commits).toHaveLength(1);
    expect(ok(await b.caller.status()).cursor).toBe(b.basis);
  });

  it('is caught up on an empty feed: Status and next_cursor are the empty cursor it stands on, whatever its Pushes were answered', async () => {
    const a = await SyncCaller.enrol(held);
    const b = new Replica(a);
    await b.pullAll();
    const caughtUp = async () => {
      expect([ok(await a.delta({})).nextCursor, ok(await a.status()).cursor]).toEqual([b.basis, b.basis]);
    };
    expect(b.basis).toBe('');
    await caughtUp();

    // A Push that writes nothing to the feed leaves it empty: every edit REJECTED, or every edit HELD.
    const key = occFacetKey(randomUUID(), 'status');
    const rejected = ok(await a.push({ clientId: randomUUID(), events: [edit(key, mint(a, 0), status('owned'), null)] }));
    expect(outcomes(rejected.results)).toEqual([[PushOutcome.REJECTED, 'basis_missing']]);
    frame = { userId: a.userId, seq: 1n << 40n, keys: new Set([key]) };
    try {
      const kept = ok(await a.push({ clientId: randomUUID(), events: [edit(key, mint(a, 1), status('owned'), b.basis)] }));
      expect(outcomes(kept.results)).toEqual([[PushOutcome.HELD, '']]);
    } finally {
      frame = undefined;
    }
    expect(await feedCount(a.userId)).toBe(0);
    expect(await b.pull()).toBe(false);
    expect([b.basis, b.processed]).toEqual(['', []]);
    await caughtUp();

    // Its first transaction moves both to that transaction's commit_cursor.
    ok(await a.push({ clientId: randomUUID(), events: copy(a, b.basis) }));
    await b.pullAll();
    expect(b.basis).not.toBe('');
    await caughtUp();
  });

  it('after a restart mid-transaction fetches the staged events again and still applies each once', async () => {
    const a = await SyncCaller.enrol(h);
    const b = new Replica(await SyncCaller.sibling(h, a));
    const first = copy(a);
    ok(await a.push({ clientId: randomUUID(), events: first }));
    await b.pullAll();
    const committed = b.basis;

    const second = copy(a, committed);
    ok(await a.push({ clientId: randomUUID(), events: second }));
    await b.pull(2);
    expect(b.staged).toHaveLength(2);
    b.restart();
    expect(b.basis).toBe(committed);
    await b.pullAll(1);

    expect(b.processed).toEqual([...first, ...second].map((e) => `${e.facetKey}@${e.version}`));
    expect(new Set(b.commits).size).toBe(2);
    expect(b.basis).toBe(encodeCursor(decodeCursor(committed)! + 3n));
  });
});

describe('(b) SyncEvent.basis on Push', () => {
  it('rejects an event with no basis as basis_missing, writes nothing, and repeats it on a replay', async () => {
    const a = await SyncCaller.enrol(h);
    const key = ufFacetKey(randomUUID(), 'score');
    ok(await a.push({ clientId: randomUUID(), events: [edit(key, mint(a, 1), score(3))] }));
    const before = await feedCount(a.userId);

    const clientId = randomUUID();
    const batch = { clientId, events: [edit(key, mint(a, 2), score(9), null)] };
    const [res] = ok(await a.push(batch)).results;
    expect([res!.outcome, res!.reason]).toEqual([PushOutcome.REJECTED, 'basis_missing: the event carries no basis']);
    // The key is user-owned and held, so `current` is the server's facet.
    expect(res!.current).toMatchObject({ facetKey: key, payload: score(3) });
    expect(await feedCount(a.userId)).toBe(before);
    const [again] = ok(await a.push(batch)).results;
    expect([again!.outcome, again!.reason]).toEqual([PushOutcome.REJECTED, 'basis_missing: the event carries no basis']);
  });

  it('takes an empty basis (no transaction applied yet) as a basis', async () => {
    const a = await SyncCaller.enrol(h);
    const [res] = ok(await a.push({ clientId: randomUUID(), events: [edit(ufFacetKey(randomUUID(), 'score'), mint(a), score(5), '')] })).results;
    expect(res!.outcome).toBe(PushOutcome.APPLIED);
  });

  it('rejects a basis that is not a cursor this server issues as basis_missing', async () => {
    const a = await SyncCaller.enrol(h);
    const key = ufFacetKey(randomUUID(), 'score');
    const unreadable = ['not-a-cursor', Buffer.from('v1:007').toString('base64url'), Buffer.from('v2:1').toString('base64url')];
    const res = ok(await a.push({ clientId: randomUUID(), events: unreadable.map((basis, i) => edit(key, mint(a, i), score(2), basis)) }));
    expect(res.results.map((r) => r.reason)).toEqual(unreadable.map(() => 'basis_missing: the basis is not a cursor'));
    expect(await feedCount(a.userId)).toBe(0);
  });

  it("refuses the start of the feed spelled as a seq: the server issues it only as ''", async () => {
    const a = await SyncCaller.enrol(h);
    const zero = Buffer.from('v1:0').toString('base64url');
    const [res] = ok(await a.push({ clientId: randomUUID(), events: [edit(ufFacetKey(randomUUID(), 'score'), mint(a), score(5), zero)] })).results;
    expect([res!.outcome, res!.reason]).toEqual([PushOutcome.REJECTED, 'basis_missing: the basis is not a cursor']);
    expect(await a.delta({ cursor: zero })).toMatchObject({ ok: false, status: 400, code: 'invalid_argument' });
  });

  it('places an edit on a stale basis by LWW while no import frame exists: STALE when older, APPLIED when newer', async () => {
    const a = await SyncCaller.enrol(h);
    const b = new Replica(await SyncCaller.sibling(h, a));
    const key = ufFacetKey(randomUUID(), 'score');
    ok(await a.push({ clientId: randomUUID(), events: [edit(key, mint(a, 0, -60_000), score(1))] }));
    await b.pullAll();
    const staleBasis = b.basis;
    ok(await a.push({ clientId: randomUUID(), events: [edit(key, mint(a, 0, -30_000), score(2), staleBasis)] }));

    // b has not seen a's second transaction: its basis is stale.
    const older = ok(await b.caller.push({ clientId: randomUUID(), events: [edit(key, mint(b.caller, 0, -45_000), score(7), staleBasis)] }));
    expect(older.results[0]).toMatchObject({ outcome: PushOutcome.STALE, current: { payload: score(2) } });
    const newer = ok(await b.caller.push({ clientId: randomUUID(), events: [edit(key, mint(b.caller, 0, -10_000), score(8), staleBasis)] }));
    expect(newer.results[0]).toMatchObject({ outcome: PushOutcome.APPLIED, current: { payload: score(8) } });
    // A basis past the head (an outbox minted before a restore) is still a basis.
    const past = ok(await b.caller.push({ clientId: randomUUID(), events: [edit(key, mint(b.caller, 1, -5_000), score(9), encodeCursor(2n ** 62n))] }));
    expect(past.results[0]!.outcome).toBe(PushOutcome.APPLIED);
  });

  it('runs basis_missing last in the listed check order', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.enrol(h);
    const key = ufFacetKey(randomUUID(), 'score');
    const res = ok(
      await a.push({
        clientId: randomUUID(),
        events: [
          edit(key, 'not-a-version', score(1), null),
          edit(key, mint(a, 0, 3_600_000), score(1), null),
          edit('holding/x/status', mint(a), score(1), null),
          edit(key, mint(b), score(1), null),
          edit(key, mint(a, 1), '{}', null),
          { facetKey: key, version: mint(a, 2), op: SyncOp.DELETE, payload: '' },
          edit(key, mint(a, 3), score(1), 'bad basis'),
        ],
      }),
    );
    expect(outcomes(res.results)).toEqual([
      [PushOutcome.REJECTED, 'version_malformed'],
      [PushOutcome.REJECTED, 'version_future'],
      [PushOutcome.REJECTED, 'facet_key_not_user_owned'],
      [PushOutcome.REJECTED, 'device_mismatch'],
      [PushOutcome.REJECTED, 'payload_invalid'],
      [PushOutcome.REJECTED, 'basis_missing'],
      [PushOutcome.REJECTED, 'basis_missing'],
    ]);
  });
});

/**
 * An import-shaped server transaction, written the way the import will write one: under the user
 * lock, every write through the store's apply path at a server version, the marker last.
 */
async function importTransaction(userId: string, writes: { facetKey: string; payload: string }[]): Promise<bigint> {
  return transaction(db.app, async (tx) => {
    await lockUser(tx, userId);
    const now = await serverNow(tx);
    const feed = new FeedTransaction();
    const at = (counter: number) => canonicalVersion({ instant: now.iso, counter, deviceId: SERVER_DEVICE_ID });
    for (const [i, w] of writes.entries()) await applyEvent(tx, userId, { ...w, version: at(i), op: 'upsert' }, feed);
    await applyEvent(tx, userId, { facetKey: importMarkerKey('mfc'), version: now.iso, op: 'upsert', payload: '{"import":1}' }, feed);
    const { rows } = await tx.query<{ seq: string }>('SELECT max(seq) AS seq FROM feed_event WHERE user_id = $1', [userId]);
    return BigInt(rows[0]!.seq);
  });
}

describe('(d) HELD', () => {
  it('holds a late edit to what an import decided: kept, not applied, answered with the import\'s value, HELD again on a replay', async () => {
    const a = await SyncCaller.enrol(held);
    const b = new Replica(await SyncCaller.sibling(held, a));
    const deviceA = new Replica(a);
    const occ = randomUUID();
    const statusKey = occFacetKey(occ, 'status');
    ok(await a.push({ clientId: randomUUID(), events: [edit(occFacetKey(occ, 'head'), mint(a, 0), head(randomUUID())), edit(statusKey, mint(a, 1), status('wished'))] }));
    await deviceA.pullAll();
    const before = deviceA.basis;

    // The import moves the copy to owned, and writes its marker last: one transaction.
    const marker = await importTransaction(a.userId, [{ facetKey: statusKey, payload: status('owned') }]);
    frame = { userId: a.userId, seq: marker, keys: new Set([statusKey]) };
    await b.pull(1);
    expect([b.local.has(statusKey), b.staged.length]).toEqual([false, 1]);
    await b.pullAll(1);
    expect(b.local.get(statusKey)?.payload).toBe(status('owned'));
    expect(b.basis).toBe(encodeCursor(marker));

    // Device A edits offline on its old basis: the status is late for the import, the tag is not framed.
    const tagKey = occTagKey(occ, randomUUID());
    // Its version is above the import's, so LWW alone would apply it.
    const lateVersion = mint(a, 0, 1_000);
    const batch = { clientId: randomUUID(), events: [edit(statusKey, lateVersion, status('ordered'), before), edit(tagKey, mint(a, 1, 1_000), tag(), before)] };
    shown.length = 0;
    const feedBefore = await feedCount(a.userId);
    const res = ok(await a.push(batch));
    expect(outcomes(res.results)).toEqual([[PushOutcome.HELD, ''], [PushOutcome.APPLIED, '']]);
    expect(res.results[0]!.current).toMatchObject({ facetKey: statusKey, payload: status('owned') });
    expect(res.results[0]!.version).toBe(res.results[0]!.current!.version);
    expect(shown).toEqual([[expect.objectContaining({ index: 0, facetKey: statusKey, basisSeq: decodeCursor(before) }), expect.objectContaining({ index: 1, facetKey: tagKey })]]);

    // Not applied: the facet keeps the import's value and only the tag reached the feed, as its own transaction.
    const state = await db.admin.query<{ payload: string }>('SELECT payload FROM facet_state WHERE user_id = $1 AND facet_key = $2', [a.userId, statusKey]);
    expect(state.rows[0]!.payload).toBe(status('owned'));
    expect(await feedCount(a.userId)).toBe(feedBefore + 1);
    const tail = (await drain(a, encodeCursor(marker))).events;
    expect(tail.map((e) => [e.facetKey, e.commitCursor !== ''])).toEqual([[tagKey, true]]);

    // Kept: the held edit is on the server with the basis it was made on.
    const kept = await db.admin.query('SELECT client_id, ordinal, facet_key, version, op, payload, basis_seq FROM held_edit WHERE user_id = $1', [a.userId]);
    expect(kept.rows).toEqual([
      { client_id: batch.clientId, ordinal: 0, facet_key: statusKey, version: lateVersion, op: 'upsert', payload: status('ordered'), basis_seq: String(decodeCursor(before)) },
    ]);

    // A replay repeats HELD (never DUPLICATE) with `current` read now; nothing is kept twice.
    const replay = ok(await a.push(batch));
    expect(outcomes(replay.results)).toEqual([[PushOutcome.HELD, ''], [PushOutcome.DUPLICATE, '']]);
    expect(replay.results[0]!.current).toMatchObject({ payload: status('owned') });
    expect((await db.admin.query('SELECT 1 FROM held_edit WHERE user_id = $1', [a.userId])).rows).toHaveLength(1);

    // A knowing edit (made on the import's commit) is applied.
    const knowing = ok(await b.caller.push({ clientId: randomUUID(), events: [edit(statusKey, mint(b.caller, 0, 2_000), status('former'), b.basis)] }));
    expect(outcomes(knowing.results)).toEqual([[PushOutcome.APPLIED, '']]);
  });

  it('decides HELD only among events that pass every REJECTED check, and answers HELD with no current where the server holds none', async () => {
    const a = await SyncCaller.enrol(held);
    const fresh = occFacetKey(randomUUID(), 'status');
    frame = { userId: a.userId, seq: 1n << 40n, keys: new Set([fresh]) };
    shown.length = 0;
    const res = ok(await a.push({ clientId: randomUUID(), events: [edit(fresh, mint(a, 0), '{}'), edit(fresh, mint(a, 1), status('owned'))] }));
    expect(outcomes(res.results)).toEqual([[PushOutcome.REJECTED, 'payload_invalid'], [PushOutcome.HELD, '']]);
    expect(res.results[1]!.current).toBeUndefined();
    expect(shown).toEqual([[expect.objectContaining({ index: 1 })]]);
    expect(await feedCount(a.userId)).toBe(0);
    // Kept under its place in the Push.
    const kept = await db.admin.query('SELECT ordinal, basis_seq FROM held_edit WHERE user_id = $1', [a.userId]);
    expect(kept.rows).toEqual([{ ordinal: 1, basis_seq: '0' }]);
    frame = undefined;
  });

  it('holds nothing by default: with no import there is no frame, so every edit is placed by LWW', async () => {
    const a = await SyncCaller.enrol(h);
    const key = occFacetKey(randomUUID(), 'status');
    const res = ok(await a.push({ clientId: randomUUID(), events: [edit(key, mint(a), status('owned'), '')] }));
    expect(outcomes(res.results)).toEqual([[PushOutcome.APPLIED, '']]);
  });
});
