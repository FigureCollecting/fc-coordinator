// WK-14b: a re-import of a changed export, the answers to its items, and the full discrepancy
// report, through the real Fastify app (OIDC + DPoP edge, Connect) on a real migrated Postgres,
// against a fake SpineRead on h2c. Never prod.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  ImportAnswer,
  ImportReviewKind,
  PushOutcome,
  SyncOp,
  canonicalVersion,
  type ImportMfcExportResponse,
  type SyncEvent,
} from '@figurecollecting/fc-api-contract';
import { GetProductsResponseSchema } from '@figurecollecting/ingest-contract/read';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importOccId } from '../../src/import/occ.js';
import { readDiscrepancyReport } from '../../src/import/report.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';
import { DISPLAY, ok, startSyncApp, SyncCaller, type Rpc, type SyncApp } from '../helpers/syncClient.js';
import { startSyncDatabase, type SyncDatabase } from '../helpers/syncDatabase.js';
import { headFor, mfcCsv, type FixtureRow } from './fixture.js';

const require = createRequire(import.meta.url);
const KEY = new Uint8Array(
  Buffer.from(
    (JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/golden/key-vectors.json'), 'utf8')) as { mfcImportOccTestKey: { hex: string } })
      .mfcImportOccTestKey.hex,
    'hex',
  ),
);
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schema = (name: string) =>
  ajv.compile(JSON.parse(readFileSync(require.resolve(`@figurecollecting/fc-api-contract/schemas/${name}.schema.json`), 'utf8')) as object);
const changeSchema = schema('imp-change');
const figureSchema = schema('imp-figure');

const DATE_A = '2026-09-09';
const DATE_B = '2026-09-20';

let db: SyncDatabase;
let spine: FakeSpineRead;
let h: SyncApp;
const unknown = new Set<string>();
/** An id the spine now resolves to another head than headFor(id): a merge or a move. */
const remapped = new Map<string, string>();
let spineDown = false;

beforeAll(async () => {
  db = await startSyncDatabase();
  spine = await startFakeSpineRead({
    keys: new Map(),
    respondProducts: ({ request }) => {
      if (spineDown) throw new ConnectError('down', Code.Unavailable);
      const ids = request.refs.map((r) => (r.ref.case === 'sourceItem' ? r.ref.value.nativeId : ''));
      const known = ids.filter((i) => !unknown.has(i));
      return create(GetProductsResponseSchema, {
        productsJson: JSON.stringify({
          products: known.map((id) => ({ productId: remapped.get(id) ?? headFor(id), requestedAs: [{ sourceItem: { site: 'mfc', nativeId: id } }] })),
          unresolved: ids.filter((i) => unknown.has(i)).map((nativeId) => ({ sourceItem: { site: 'mfc', nativeId } })),
          coverage: {},
        }),
        nextPageToken: '',
      });
    },
  });
  h = await startSyncApp(db.app, undefined, undefined, undefined, {
    import: { db: db.app, spineRead: new SpineReadClient(spine.baseUrl), occIdKey: KEY },
  });
}, 240_000);

afterAll(async () => {
  await h?.close();
  await spine?.close();
  await db?.close();
});

const nextId = (() => {
  let n = 5_000_000;
  return () => String((n += 1));
})();

const row = (id: string, status: FixtureRow['status'], extra: Partial<FixtureRow> = {}): FixtureRow => ({
  id,
  status,
  count: '1',
  score: '',
  wishability: '0',
  note: '',
  ...extra,
});

async function drain(caller: SyncCaller, cursor = ''): Promise<{ events: SyncEvent[]; cursor: string }> {
  const events: SyncEvent[] = [];
  for (;;) {
    const page = ok(await caller.delta({ cursor, limit: 1000 }));
    events.push(...page.events);
    cursor = page.nextCursor;
    if (!page.hasMore) return { events, cursor };
  }
}

const imported = (caller: SyncCaller, rows: FixtureRow[], exportDate = DATE_A) => caller.importMfcExport({ csvText: mfcCsv(rows), exportDate }).then(ok);

/** Each event as [key with the copy's id named, op], so a test reads which copy it touched. */
const shape = (events: readonly SyncEvent[], names: Record<string, string>) =>
  events.map((e) => [Object.entries(names).reduce((k, [id, name]) => k.replace(id, name), e.facetKey), e.op === SyncOp.DELETE ? 'DELETE' : 'UPSERT'] as const);

let counter = 0;
const later = (c: SyncCaller) => canonicalVersion({ instant: new Date(Date.now() + 1000), counter: (counter += 1), deviceId: c.deviceId });
const edit = (c: SyncCaller, facetKey: string, body: object | null, basis: string) => ({
  facetKey,
  version: later(c),
  op: body === null ? SyncOp.DELETE : SyncOp.UPSERT,
  payload: body === null ? '' : JSON.stringify({ ...body, ...DISPLAY }),
  basis,
});
const answer = (c: SyncCaller, head: string, body: object, basis: string) => edit(c, `res/mfc/${head}`, body, basis);
const pushed = async (c: SyncCaller, events: ReturnType<typeof edit>[]) => ok(await c.push({ clientId: randomUUID(), events }));

const failed = <T>(rpc: Rpc<T>): { code: string; message: string } => {
  if (rpc.ok) throw new Error('expected the call to fail');
  return { code: rpc.code, message: rpc.message };
};

async function feedCount(userId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>('SELECT count(*) AS n FROM feed_event WHERE user_id = $1', [userId]);
  return Number(rows[0]!.n);
}

const payloadOf = (events: readonly SyncEvent[], key: string) => JSON.parse(events.filter((e) => e.facetKey === key).at(-1)!.payload) as Record<string, unknown>;

describe('acceptance (b) to (e): a re-import of a changed export', () => {
  it('(b) one row removed and one moved Owned to Wished: one status DELETE and one status UPSERT, each listed with its undo; (c) the same export again writes only its marker', async () => {
    const a = await SyncCaller.enrol(h);
    const [x, y, z] = [nextId(), nextId(), nextId()];
    const [cx, cy] = [importOccId(KEY, a.userId, x, 1), importOccId(KEY, a.userId, y, 1)];
    ok(await a.importMfcExport({ csvText: mfcCsv([row(x, 'Owned'), row(y, 'Owned'), row(z, 'Wished', { wishability: '3' })]), exportDate: DATE_A }));
    const { cursor } = await drain(a);

    const b = await imported(a, [row(x, 'Wished'), row(z, 'Wished', { wishability: '3' })], DATE_B);
    const { events, cursor: after } = await drain(a, cursor);
    const names = { [cx]: 'X', [cy]: 'Y', [headFor(x)]: 'HX', [headFor(y)]: 'HY' };
    const user = events.filter((e) => !e.facetKey.startsWith('imp/'));
    expect(shape(user, names)).toEqual([
      ['occ/X/status', 'UPSERT'],
      ['occ/Y/status', 'DELETE'],
    ]);
    expect(payloadOf(events, `occ/${cx}/status`)).toEqual({ status: 'wished', edited_at: `${DATE_B}T00:00:00Z`, tz: 'UTC' });
    // What the contract adds beside them: a change entry per figure it wrote to (R3), the marker last.
    expect(shape(events.filter((e) => e.facetKey.startsWith('imp/')), names)).toEqual([
      ['imp/mfc/change/HX', 'UPSERT'],
      ['imp/mfc/change/HY', 'UPSERT'],
      ['imp/mfc/import', 'UPSERT'],
    ]);
    expect(b).toMatchObject({
      resolved: 2,
      added: 0,
      moved: 1,
      unchanged: 1,
      removed: 1,
      keptNewer: 0,
      occurrencesAdded: 0,
      occurrencesStatusChanged: 1,
      occurrencesRemoved: 1,
      conflictsRaised: 0,
      conflictsPending: 0,
      facetsWritten: 5,
      importNumber: 2,
      review: [],
    });
    const [changeX, changeY] = [headFor(x), headFor(y)].sort().map((head) => b.applied.find((i) => i.headId === head)!);
    for (const item of b.applied) {
      expect(item.answers).toEqual([ImportAnswer.UNDO, ImportAnswer.DISMISS]);
      const payload = JSON.parse(item.payload) as object;
      expect(changeSchema(payload)).toBe(true);
      expect(payload).toMatchObject({ rev: item.rev, kind: 'applied', import: 2 });
      expect(payloadOf(events, item.facetKey)).toEqual(payload);
    }
    expect(b.applied.map((i) => i.headId)).toEqual([headFor(x), headFor(y)].sort());
    const entry = (item: typeof changeX) => JSON.parse(item!.payload) as { writes: object; undo: object };
    const byHead = new Map([[headFor(x), cx], [headFor(y), cy]]);
    expect(entry(b.applied.find((i) => byHead.get(i.headId) === cx))).toMatchObject({
      writes: { copies: [{ occ: cx, status: 'wished' }], fields: [] },
      undo: { copies: [{ occ: cx, status: 'owned' }], fields: [] },
    });
    expect(entry(b.applied.find((i) => byHead.get(i.headId) === cy))).toMatchObject({
      writes: { copies: [{ occ: cy, status: 'removed' }], fields: [] },
      undo: { copies: [{ occ: cy, status: 'owned' }], fields: [] },
    });
    void changeY;

    // (c) The same export again: its marker and nothing else.
    const before = await feedCount(a.userId);
    const again = await imported(a, [row(x, 'Wished'), row(z, 'Wished', { wishability: '3' })], DATE_B);
    expect(again).toMatchObject({ facetsWritten: 1, moved: 0, removed: 0, unchanged: 2, applied: [], review: [] });
    expect(await feedCount(a.userId)).toBe(before + 1);
    expect(shape((await drain(a, after)).events, names)).toEqual([['imp/mfc/import', 'UPSERT']]);
  });

  it('(d) keeps device edits made after the export date that the export does not contradict, and writes beside them what MFC alone changed', async () => {
    const a = await SyncCaller.enrol(h);
    const [x, y] = [nextId(), nextId()];
    const cy = importOccId(KEY, a.userId, y, 1);
    await imported(a, [row(x, 'Owned', { score: '7/10', note: 'first' }), row(y, 'Owned')]);
    const { cursor } = await drain(a);
    // Made after the import was pulled, and stamped after either export's date.
    const edits = await pushed(a, [edit(a, `uf/${headFor(x)}/score`, { score: 9 }, cursor), edit(a, `occ/${cy}/status`, { status: 'former' }, cursor)]);
    expect(edits.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.APPLIED]);
    const { cursor: edited } = await drain(a, cursor);

    // MFC changed only x's note; the app's score and sale stand, and nothing conflicts.
    const b = await imported(a, [row(x, 'Owned', { score: '7/10', note: 'second' }), row(y, 'Owned')], DATE_B);
    expect(b).toMatchObject({ conflictsRaised: 0, conflictsPending: 0, moved: 0, unchanged: 2, facetsWritten: 3 });
    const { events } = await drain(a, edited);
    expect(shape(events, { [headFor(x)]: 'HX' })).toEqual([
      ['uf/HX/note', 'UPSERT'],
      ['imp/mfc/change/HX', 'UPSERT'],
      ['imp/mfc/import', 'UPSERT'],
    ]);
    const state = new Map((await drain(a)).events.map((e) => [e.facetKey, e]));
    expect(JSON.parse(state.get(`uf/${headFor(x)}/score`)!.payload)).toMatchObject({ score: 9 });
    expect(JSON.parse(state.get(`occ/${cy}/status`)!.payload)).toMatchObject({ status: 'former' });
    expect(JSON.parse(state.get(`uf/${headFor(x)}/note`)!.payload)).toMatchObject({ note: 'second' });
  });

  it('(e) lists the unresolved rows with their count and writes nothing for them: a row the spine no longer resolves keeps its copies', async () => {
    const a = await SyncCaller.enrol(h);
    const [x, y, w] = [nextId(), nextId(), nextId()];
    await imported(a, [row(x, 'Owned'), row(y, 'Owned', { count: '2' })]);
    unknown.add(y);
    unknown.add(w);
    try {
      const b = await imported(a, [row(x, 'Owned'), row(y, 'Owned'), row(w, 'Wished'), row(`00${x}`, 'Owned'), row(x, 'Owned', { count: 'two' })], DATE_B);
      expect(b.unresolved).toHaveLength(4);
      expect(b.unresolved.map((u) => [u.mfcId, u.line, u.reason])).toEqual([
        [y, 3, 'no_product'],
        [w, 4, 'no_product'],
        [`00${x}`, 5, 'duplicate_id'],
        [x, 6, 'duplicate_id'],
      ]);
      // y's base stands for it: its two copies stay, though its Count is now 1; x is unchanged.
      expect(b).toMatchObject({ resolved: 1, unchanged: 1, removed: 0, occurrencesRemoved: 0, facetsWritten: 1 });
    } finally {
      unknown.delete(y);
      unknown.delete(w);
    }
  });
});

describe('a conflict on a figure an earlier import settled', () => {
  it('raises one item when MFC and the app changed the Count differently, writes nothing of the figure, and keeps its rev on the same export', async () => {
    const a = await SyncCaller.enrol(h);
    const x = nextId();
    const [c1, c2] = [importOccId(KEY, a.userId, x, 1), importOccId(KEY, a.userId, x, 2)];
    await imported(a, [row(x, 'Owned', { count: '2' })]);
    const { cursor } = await drain(a);
    await pushed(a, [edit(a, `occ/${c2}/status`, { status: 'former' }, cursor)]);
    const before = await feedCount(a.userId);

    const b = await imported(a, [row(x, 'Owned', { count: '3' })], DATE_B);
    expect(b).toMatchObject({ resolved: 1, added: 0, keptNewer: 1, moved: 0, unchanged: 0, conflictsRaised: 1, conflictsPending: 1, facetsWritten: 2, applied: [] });
    expect(await feedCount(a.userId)).toBe(before + 2);
    const item = b.review[0]!.items[0]!;
    expect(b.review[0]!.kind).toBe(ImportReviewKind.CONFLICT);
    const payload = JSON.parse(item.payload) as Record<string, unknown>;
    expect(figureSchema(payload)).toBe(true);
    expect(payload).toMatchObject({
      kind: 'conflict',
      import: 2,
      counts: { owned: { base: 2, app: 1, mfc: 3 }, ordered: { base: 0, app: 0, mfc: 0 }, wished: { base: 0, app: 0, mfc: 0 } },
      mfc_rows: [{ mfc_id: x, kind: 'owned', count: 3 }],
    });
    expect(payload['copies']).toEqual([c1, c2].sort().map((occ) => ({ occ, status: occ === c2 ? 'former' : 'owned', tracked: true })));

    const again = await imported(a, [row(x, 'Owned', { count: '3' })], DATE_B);
    expect(again).toMatchObject({ facetsWritten: 1, conflictsRaised: 0, conflictsPending: 1, keptNewer: 1 });
    expect(again.review[0]!.items[0]!.rev).toBe(item.rev);
  });
});

describe('answers to an item, synced through Push (import.proto ITEMS AND ANSWERS)', () => {
  /** x settled with a score and a note; the app then scores it 9; MFC scores it 8 and changes the note. */
  async function scoreConflict() {
    const a = await SyncCaller.enrol(h);
    const x = nextId();
    await imported(a, [row(x, 'Owned', { score: '7/10', note: 'first' })]);
    const { cursor } = await drain(a);
    await pushed(a, [edit(a, `uf/${headFor(x)}/score`, { score: 9 }, cursor)]);
    const b = await imported(a, [row(x, 'Owned', { score: '8/10', note: 'second' })], DATE_B);
    expect(b).toMatchObject({ conflictsRaised: 1, keptNewer: 1, facetsWritten: 2 });
    const item = b.review[0]!.items[0]!;
    const { cursor: seen } = await drain(a);
    return { a, x, item, seen };
  }

  it('keep: in one transaction the item ends, what MFC alone changed is written and the disputed part stays; the same export raises nothing again', async () => {
    const { a, x, item, seen } = await scoreConflict();
    expect((await a.status().then(ok)).pendingReview).toBe(1n);
    const res = await pushed(a, [answer(a, headFor(x), { item: 'figure', rev: item.rev, choice: 'keep' }, seen)]);
    expect(res.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    const { events } = await drain(a, seen);
    expect(shape(events, { [headFor(x)]: 'HX' })).toEqual([
      ['res/mfc/HX', 'UPSERT'],
      ['uf/HX/note', 'UPSERT'],
      ['imp/mfc/figure/HX', 'DELETE'],
    ]);
    // One transaction: only its last event carries the commit cursor.
    expect(events.map((e) => e.commitCursor !== '')).toEqual([false, false, true]);
    expect(payloadOf(events, `uf/${headFor(x)}/note`)).toMatchObject({ note: 'second', tz: DISPLAY.tz });
    expect((await a.status().then(ok)).pendingReview).toBe(0n);

    const again = await imported(a, [row(x, 'Owned', { score: '8/10', note: 'second' })], DATE_B);
    expect(again).toMatchObject({ facetsWritten: 1, conflictsRaised: 0, conflictsPending: 0, review: [], applied: [] });
    const state = new Map((await drain(a)).events.map((e) => [e.facetKey, e]));
    expect(JSON.parse(state.get(`uf/${headFor(x)}/score`)!.payload)).toMatchObject({ score: 9 });
  });

  it("take: MFC's side made true on the copies MFC tracks: the sold copy is owned again, MFC's new copy made, and the disputed field takes MFC's value", async () => {
    const a = await SyncCaller.enrol(h);
    const x = nextId();
    const [c1, c2, c3] = [1, 2, 3].map((n) => importOccId(KEY, a.userId, x, n));
    await imported(a, [row(x, 'Owned', { count: '2', score: '7/10' })]);
    const { cursor } = await drain(a);
    await pushed(a, [edit(a, `occ/${c2}/status`, { status: 'former' }, cursor), edit(a, `uf/${headFor(x)}/score`, { score: 9 }, cursor)]);
    const b = await imported(a, [row(x, 'Owned', { count: '3', score: '8/10' })], DATE_B);
    const item = b.review[0]!.items[0]!;
    const { cursor: seen } = await drain(a);
    expect((JSON.parse(item.payload) as { preview: { take: unknown } }).preview.take).toEqual({
      copies: [
        { occ: c2, status: 'owned' },
        { occ: c3, status: 'owned', head_id: headFor(x), origin: { site: 'mfc', native_id: x, ordinal: 3 } },
      ].sort((p, q) => Number(p.occ > q.occ) - Number(p.occ < q.occ)),
      fields: [{ head_id: headFor(x), field: 'score', score: 8 }],
    });

    expect((await pushed(a, [answer(a, headFor(x), { item: 'figure', rev: item.rev, choice: 'take' }, seen)])).results[0]!.outcome).toBe(PushOutcome.APPLIED);
    const state = new Map((await drain(a)).events.map((e) => [e.facetKey, e]));
    const status = (occ: string) => (JSON.parse(state.get(`occ/${occ}/status`)!.payload) as { status: string }).status;
    expect([c1, c2, c3].map(status)).toEqual(['owned', 'owned', 'owned']);
    expect(JSON.parse(state.get(`occ/${c3}/origin`)!.payload)).toEqual({ site: 'mfc', native_id: x, ordinal: 3 });
    expect(JSON.parse(state.get(`uf/${headFor(x)}/score`)!.payload)).toMatchObject({ score: 8 });
    expect(state.get(`imp/mfc/figure/${headFor(x)}`)!.op).toBe(SyncOp.DELETE);
    // The bases realigned to MFC's side: the same export finds nothing to do.
    expect(await imported(a, [row(x, 'Owned', { count: '3', score: '8/10' })], DATE_B)).toMatchObject({ facetsWritten: 1, conflictsPending: 0 });
    expect(c1).not.toBe(c3);
  });

  it('per_copy: what MFC alone changed, then exactly the listed statuses and the side named for each disputed field', async () => {
    const { a, x, item, seen } = await scoreConflict();
    const c1 = importOccId(KEY, a.userId, x, 1);
    const res = await pushed(a, [
      answer(a, headFor(x), { item: 'figure', rev: item.rev, choice: 'per_copy', copies: [{ occ: c1, status: 'wished' }], fields: { score: 'mfc' } }, seen),
    ]);
    expect(res.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    const { events } = await drain(a, seen);
    expect(shape(events, { [headFor(x)]: 'HX', [c1]: 'C1' })).toEqual([
      ['res/mfc/HX', 'UPSERT'],
      ['occ/C1/status', 'UPSERT'],
      ['uf/HX/score', 'UPSERT'],
      ['uf/HX/note', 'UPSERT'],
      ['imp/mfc/figure/HX', 'DELETE'],
    ]);
    expect(payloadOf(events, `occ/${c1}/status`)).toMatchObject({ status: 'wished' });
    expect(payloadOf(events, `uf/${headFor(x)}/score`)).toMatchObject({ score: 8 });
  });

  it('answers STALE, writing nothing, an answer naming another rev, an item that is not pending, or a choice the item does not allow', async () => {
    const { a, x, item, seen } = await scoreConflict();
    const other = nextId();
    const before = await feedCount(a.userId);
    const res = await pushed(a, [
      answer(a, headFor(x), { item: 'figure', rev: `${item.rev}x`, choice: 'keep' }, seen),
      answer(a, headFor(x), { item: 'change', rev: item.rev, choice: 'undo' }, seen),
      answer(a, headFor(x), { item: 'figure', rev: item.rev, choice: 'dismiss' }, seen),
      answer(a, headFor(x), { item: 'held', rev: item.rev, choice: 'keep' }, seen),
      answer(a, headFor(other), { item: 'figure', rev: item.rev, choice: 'keep' }, seen),
    ]);
    expect(res.results.map((r) => r.outcome)).toEqual(Array(5).fill(PushOutcome.STALE));
    expect(await feedCount(a.userId)).toBe(before);
    // The item stands, and the first answer that names it is accepted.
    const accepted = await pushed(a, [answer(a, headFor(x), { item: 'figure', rev: item.rev, choice: 'keep' }, seen)]);
    expect(accepted.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    const second = await pushed(a, [answer(a, headFor(x), { item: 'figure', rev: item.rev, choice: 'take' }, seen)]);
    expect(second.results[0]!.outcome).toBe(PushOutcome.STALE);
    expect(second.results[0]!.current).toMatchObject({ facetKey: `res/mfc/${headFor(x)}` });
  });

  it('undo of an applied removal puts the copy back as a knowing keep: no item and no align-MFC entry on the same export, and the full discrepancy report lists the kept copy until MFC counts it again', async () => {
    const a = await SyncCaller.enrol(h);
    const [x, y] = [nextId(), nextId()];
    const cy = importOccId(KEY, a.userId, y, 1);
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    const b = await imported(a, [row(x, 'Owned')], DATE_B);
    const change = b.applied.find((i) => i.headId === headFor(y))!;
    const { cursor: seen } = await drain(a);
    expect(await readDiscrepancyReport(db.app, a.userId)).toEqual([]);

    const res = await pushed(a, [answer(a, headFor(y), { item: 'change', rev: change.rev, choice: 'undo' }, seen)]);
    expect(res.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    const { events, cursor: undone } = await drain(a, seen);
    expect(shape(events, { [headFor(y)]: 'HY', [cy]: 'CY' })).toEqual([
      ['res/mfc/HY', 'UPSERT'],
      ['occ/CY/status', 'UPSERT'],
      ['imp/mfc/change/HY', 'DELETE'],
    ]);
    expect(payloadOf(events, `occ/${cy}/status`)).toMatchObject({ status: 'owned' });
    const kept = await db.admin.query('SELECT occ_id, head_id, kind FROM import_kept_copy WHERE user_id = $1', [a.userId]);
    expect(kept.rows).toEqual([{ occ_id: cy, head_id: headFor(y), kind: 'owned' }]);
    expect(await readDiscrepancyReport(db.app, a.userId)).toEqual([{ head: headFor(y), kind: 'owned', app: 1, mfc: 0, copies: [cy], kept: [cy] }]);

    // The same export: nothing raised about the kept copy, no align-MFC entry, only the marker.
    const again = await imported(a, [row(x, 'Owned')], DATE_B);
    expect(again).toMatchObject({ facetsWritten: 1, review: [], applied: [], conflictsPending: 0 });
    expect(shape((await drain(a, undone)).events, {})).toEqual([['imp/mfc/import', 'UPSERT']]);

    // MFC lists the row again: it counts the copy, the record goes, and the report has nothing.
    const counted = await imported(a, [row(x, 'Owned'), row(y, 'Owned')], DATE_B);
    expect(counted).toMatchObject({ facetsWritten: 1, conflictsPending: 0 });
    expect((await db.admin.query('SELECT 1 FROM import_kept_copy WHERE user_id = $1', [a.userId])).rows).toEqual([]);
    expect(await readDiscrepancyReport(db.app, a.userId)).toEqual([]);
  });

  it('undo is STALE once the app has changed what the import wrote; dismiss ends the entry and leaves the change', async () => {
    const a = await SyncCaller.enrol(h);
    const [x, y] = [nextId(), nextId()];
    const [cx, cy] = [importOccId(KEY, a.userId, x, 1), importOccId(KEY, a.userId, y, 1)];
    await imported(a, [row(x, 'Ordered'), row(y, 'Ordered')]);
    const b = await imported(a, [row(x, 'Owned'), row(y, 'Owned')], DATE_B);
    const [chX, chY] = [headFor(x), headFor(y)].map((head) => b.applied.find((i) => i.headId === head)!);
    const { cursor: seen } = await drain(a);
    await pushed(a, [edit(a, `occ/${cx}/status`, { status: 'former' }, seen)]);
    const { cursor: sold } = await drain(a, seen);

    const res = await pushed(a, [
      answer(a, headFor(x), { item: 'change', rev: chX!.rev, choice: 'undo' }, sold),
      answer(a, headFor(y), { item: 'change', rev: chY!.rev, choice: 'dismiss' }, sold),
    ]);
    expect(res.results.map((r) => r.outcome)).toEqual([PushOutcome.STALE, PushOutcome.APPLIED]);
    const { events } = await drain(a, sold);
    expect(shape(events, { [headFor(y)]: 'HY' })).toEqual([
      ['res/mfc/HY', 'UPSERT'],
      ['imp/mfc/change/HY', 'DELETE'],
    ]);
    const state = new Map((await drain(a)).events.map((e) => [e.facetKey, e]));
    expect(JSON.parse(state.get(`occ/${cy}/status`)!.payload)).toMatchObject({ status: 'owned' });
    expect(state.get(`imp/mfc/change/${headFor(x)}`)!.op).toBe(SyncOp.UPSERT);
  });
});

describe('the WK-14a leftovers', () => {
  it('an answered conflict does not block a FAVOR preference set after it: the same export imports, refusing nothing', async () => {
    const a = await SyncCaller.enrol(h);
    const x = nextId();
    await pushed(a, [edit(a, `uf/${headFor(x)}/score`, { score: 9 }, '')]);
    const first = await imported(a, [row(x, 'Owned', { score: '7/10' })]);
    const item = first.review[0]!.items[0]!;
    const { cursor } = await drain(a);
    await pushed(a, [answer(a, headFor(x), { item: 'figure', rev: item.rev, choice: 'keep' }, cursor)]);
    await pushed(a, [edit(a, 'pref/mfc/import', { import_policy: 'FAVOR_APP' }, cursor)]);
    const again = await imported(a, [row(x, 'Owned', { score: '7/10' })]);
    expect(again).toMatchObject({ conflictsRaised: 0, conflictsPending: 0, facetsWritten: 1 });
    // A conflict not answered still waits for WK-14c's settlement by preference.
    const y = nextId();
    await pushed(a, [edit(a, `uf/${headFor(y)}/score`, { score: 9 }, '')]);
    expect(failed(await a.importMfcExport({ csvText: mfcCsv([row(y, 'Owned', { score: '7/10' })]), exportDate: DATE_A })).code).toBe('failed_precondition');
  });

  it('StatusResponse.pending_review counts the pending figure items and the held edits', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const [x, y] = [nextId(), nextId()];
    expect((await a.status().then(ok)).pendingReview).toBe(0n);
    await pushed(a, [edit(a, `uf/${headFor(x)}/score`, { score: 9 }, '')]);
    await imported(a, [row(x, 'Owned', { score: '7/10' }), row(y, 'Owned')]);
    expect((await a.status().then(ok)).pendingReview).toBe(1n);
    // b had not pulled the import: its sale of y's copy is late and held.
    const late = await pushed(b, [edit(b, `occ/${importOccId(KEY, a.userId, y, 1)}/status`, { status: 'former' }, '')]);
    expect(late.results[0]!.outcome).toBe(PushOutcome.HELD);
    expect((await b.status().then(ok)).pendingReview).toBe(2n);
  });
});

describe('what the import refuses', () => {
  it('refuses, writing nothing, an export whose row the spine now resolves to another figure (a merge or a move: not decided yet)', async () => {
    const a = await SyncCaller.enrol(h);
    const x = nextId();
    await imported(a, [row(x, 'Owned')]);
    const before = await feedCount(a.userId);
    remapped.set(x, headFor(nextId()));
    try {
      const err = failed(await a.importMfcExport({ csvText: mfcCsv([row(x, 'Owned')]), exportDate: DATE_B }));
      expect(err.code).toBe('failed_precondition');
    } finally {
      remapped.delete(x);
    }
    expect(await feedCount(a.userId)).toBe(before);
  });

  it('answers UNAVAILABLE, writing nothing, while the spine is down', async () => {
    const a = await SyncCaller.enrol(h);
    spineDown = true;
    try {
      expect(failed(await a.importMfcExport({ csvText: mfcCsv([row(nextId(), 'Owned')]), exportDate: DATE_A })).code).toBe('unavailable');
    } finally {
      spineDown = false;
    }
    expect(await feedCount(a.userId)).toBe(0);
  });
});

void ({} as ImportMfcExportResponse);
