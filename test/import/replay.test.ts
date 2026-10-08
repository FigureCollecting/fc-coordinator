// import.proto LATE EDITS AND REPLAY and HELD (i) to (iii), through the real Fastify app (OIDC +
// DPoP edge, Connect) on a real migrated Postgres, against a fake SpineRead on h2c. Never prod.
//
// A device that had not pulled an import pushes an edit to a figure that import decided: the edit
// is LATE. It is replayed just before the import: when the import decides the figure the same way
// the edit is applied (STALE only where the import wrote its facet); when the import would have
// decided otherwise the server emits the difference (a REVISION). It is HELD only for a reaction:
// another device acted on the result the edit would withdraw.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { create } from '@bufbuild/protobuf';
import { PushOutcome, SyncOp, canonicalVersion, type SyncEvent } from '@figurecollecting/fc-api-contract';
import { GetProductsResponseSchema } from '@figurecollecting/ingest-contract/read';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importOccId } from '../../src/import/occ.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';
import { DISPLAY, ok, startSyncApp, SyncCaller, type SyncApp } from '../helpers/syncClient.js';
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
const figureSchema = ajv.compile(
  JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/schemas/imp-figure.schema.json'), 'utf8')) as object,
);

const DATE_A = '2026-09-09';
const DATE_B = '2026-09-20';

let db: SyncDatabase;
let spine: FakeSpineRead;
let h: SyncApp;

beforeAll(async () => {
  db = await startSyncDatabase();
  spine = await startFakeSpineRead({
    keys: new Map(),
    respondProducts: ({ request }) => {
      const ids = request.refs.map((r) => (r.ref.case === 'sourceItem' ? r.ref.value.nativeId : ''));
      return create(GetProductsResponseSchema, {
        productsJson: JSON.stringify({
          products: ids.map((id) => ({ productId: headFor(id), requestedAs: [{ sourceItem: { site: 'mfc', nativeId: id } }] })),
          unresolved: [],
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
  let n = 6_000_000;
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

let counter = 0;
/** Stamped a second ahead, so LWW alone would apply it over an import's write. */
const later = (c: SyncCaller, ms = 1000) => canonicalVersion({ instant: new Date(Date.now() + ms), counter: (counter += 1), deviceId: c.deviceId });
const edit = (c: SyncCaller, facetKey: string, body: object | null, basis: string, ms = 1000) => ({
  facetKey,
  version: later(c, ms),
  op: body === null ? SyncOp.DELETE : SyncOp.UPSERT,
  payload: body === null ? '' : JSON.stringify({ ...body, ...DISPLAY }),
  basis,
});
const answer = (c: SyncCaller, head: string, body: object, basis: string) => edit(c, `res/mfc/${head}`, body, basis);
const pushed = async (c: SyncCaller, events: ReturnType<typeof edit>[]) => ok(await c.push({ clientId: randomUUID(), events }));
const outcomes = (res: { results: { outcome: PushOutcome }[] }) => res.results.map((r) => PushOutcome[r.outcome]);

/** Each event as [key with the named ids replaced, op]. */
const shape = (events: readonly SyncEvent[], names: Record<string, string>) =>
  events.map((e) => [Object.entries(names).reduce((k, [id, name]) => k.replace(id, name), e.facetKey), e.op === SyncOp.DELETE ? 'DELETE' : 'UPSERT'] as const);

/** The live state a replica holds after applying the whole feed. */
async function stateOf(c: SyncCaller): Promise<Map<string, Record<string, unknown>>> {
  const state = new Map<string, Record<string, unknown>>();
  for (const e of (await drain(c)).events) {
    if (e.op === SyncOp.DELETE) state.delete(e.facetKey);
    else state.set(e.facetKey, JSON.parse(e.payload) as Record<string, unknown>);
  }
  return state;
}

const heldCount = async (userId: string) =>
  Number((await db.admin.query<{ n: string }>('SELECT count(*) AS n FROM held_edit WHERE user_id = $1', [userId])).rows[0]!.n);
const pending = async (c: SyncCaller) => (await c.status().then(ok)).pendingReview;
const copyBase = async (userId: string, occ: string) =>
  (await db.admin.query<{ kind: string; import_removed: boolean }>('SELECT kind, import_removed FROM import_copy_base WHERE user_id = $1 AND occ_id = $2', [userId, occ]))
    .rows[0];

/** Device a imports; device b had pulled only what `setup` imported, and edits offline. */
async function twoDevices(): Promise<{ a: SyncCaller; b: SyncCaller }> {
  const a = await SyncCaller.enrol(h);
  return { a, b: await SyncCaller.sibling(h, a) };
}

describe('acceptance (d), pushed after the re-import: a late edit the re-import does not contradict is replayed and APPLIED', () => {
  it('a sale made offline before a re-import that changed only the note stands; nothing is held and nothing awaits review', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned', { note: 'first' })]);
    const { cursor: bSaw } = await drain(b);
    // Stamped after either export's date, before the re-import ran; pushed after it.
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    const re = await imported(a, [row(x, 'Owned', { note: 'second' })], DATE_B);
    expect(re).toMatchObject({ conflictsRaised: 0, conflictsPending: 0, facetsWritten: 3 });
    const { cursor: aSaw } = await drain(a);

    const res = await pushed(b, [sale]);
    expect(outcomes(res)).toEqual(['APPLIED']);
    expect(await heldCount(a.userId)).toBe(0);
    expect(await pending(b)).toBe(0n);
    // Only the sale reaches the feed: the import's note and its change entry stand.
    expect(shape((await drain(a, aSaw)).events, { [cx]: 'CX' })).toEqual([['occ/CX/status', 'UPSERT']]);
    const state = await stateOf(a);
    expect(state.get(`occ/${cx}/status`)).toMatchObject({ status: 'former' });
    expect(state.get(`uf/${S}/note`)).toMatchObject({ note: 'second' });
    expect(state.get(`imp/mfc/change/${S}`)).toMatchObject({ rev: re.applied[0]!.rev });
  });

  it('control: the same late sale is APPLIED when the re-import changed only another figure', async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned', { note: 'first' }), row(y, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    await imported(a, [row(x, 'Owned', { note: 'first' }), row(y, 'Owned', { note: 'yy' })], DATE_B);
    expect(outcomes(await pushed(b, [sale]))).toEqual(['APPLIED']);
    expect(await pending(b)).toBe(0n);
  });

  it('a late edit placed before two re-imports, neither of which it changes, is APPLIED', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned', { note: 'n1' })]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    await imported(a, [row(x, 'Owned', { note: 'n2' })], DATE_B);
    await imported(a, [row(x, 'Owned', { note: 'n3' })], DATE_B);
    expect(outcomes(await pushed(b, [sale]))).toEqual(['APPLIED']);
    const state = await stateOf(a);
    expect(state.get(`occ/${cx}/status`)).toMatchObject({ status: 'former' });
    expect(state.get(`uf/${headFor(x)}/note`)).toMatchObject({ note: 'n3' });
  });

  it('a late edit to a facet the import wrote is STALE with the import\'s value: the import placed after it changed the facet', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const cx = importOccId(KEY, a.userId, x, 1);
    // b never pulled the import that created the copy.
    await imported(a, [row(x, 'Owned')]);
    const res = await pushed(b, [edit(b, `occ/${cx}/status`, { status: 'wished' }, '')]);
    expect(outcomes(res)).toEqual(['STALE']);
    expect(JSON.parse(res.results[0]!.current!.payload)).toMatchObject({ status: 'owned' });
    expect(await heldCount(a.userId)).toBe(0);
  });
});

describe('a REVISION: a late edit the import would have decided otherwise', () => {
  it('a late sale of a copy MFC dropped: the change entry is withdrawn, the sale stands, and the same export again writes only its marker', async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    const re = await imported(a, [row(y, 'Owned')], DATE_B);
    expect(re).toMatchObject({ occurrencesRemoved: 1, conflictsRaised: 0 });
    expect(re.applied).toHaveLength(1);
    const { cursor: aSaw } = await drain(a);

    const res = await pushed(b, [sale]);
    expect(outcomes(res)).toEqual(['APPLIED']);
    // One transaction: the sale, and the change entry the replay no longer makes.
    const tail = (await drain(a, aSaw)).events;
    expect(shape(tail, { [cx]: 'CX', [S]: 'HX' })).toEqual([
      ['occ/CX/status', 'UPSERT'],
      ['imp/mfc/change/HX', 'DELETE'],
    ]);
    expect(tail.map((e) => e.commitCursor !== '')).toEqual([false, true]);
    expect(JSON.parse(tail[0]!.payload)).toMatchObject({ status: 'former' });
    expect(await pending(b)).toBe(0n);
    expect(await heldCount(a.userId)).toBe(0);
    // MFC and the app agree: the copy's base is out, and no import removed it.
    expect(await copyBase(a.userId, cx)).toEqual({ kind: 'out', import_removed: false });
    const again = await imported(a, [row(y, 'Owned')], DATE_B);
    expect(again).toMatchObject({ facetsWritten: 1, conflictsRaised: 0, conflictsPending: 0 });
  });

  it('a late sale while MFC moved the copy to Wished: the replay raises the conflict the import would have, and keep answers it', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    const re = await imported(a, [row(x, 'Wished')], DATE_B);
    expect(re).toMatchObject({ occurrencesStatusChanged: 1, conflictsRaised: 0 });
    const { cursor: aSaw } = await drain(a);

    expect(outcomes(await pushed(b, [sale]))).toEqual(['APPLIED']);
    const tail = (await drain(a, aSaw)).events;
    expect(shape(tail, { [cx]: 'CX', [S]: 'HX' })).toEqual([
      ['occ/CX/status', 'UPSERT'],
      ['imp/mfc/figure/HX', 'UPSERT'],
      ['imp/mfc/change/HX', 'DELETE'],
    ]);
    const item = JSON.parse(tail[1]!.payload) as { rev: string; kind: string; counts: Record<string, { base: number; app: number; mfc: number }> };
    expect(figureSchema(item)).toBe(true);
    expect(item).toMatchObject({ kind: 'conflict', counts: { owned: { base: 1, app: 0, mfc: 0 }, wished: { base: 0, app: 0, mfc: 1 } } });
    expect(await pending(b)).toBe(1n);

    const { cursor: seen } = await drain(a, aSaw);
    expect(outcomes(await pushed(a, [answer(a, S, { item: 'figure', rev: item.rev, choice: 'keep' }, seen)]))).toEqual(['APPLIED']);
    expect(await pending(a)).toBe(0n);
    expect((await stateOf(a)).get(`occ/${cx}/status`)).toMatchObject({ status: 'former' });
  });

  it('a late copy added by hand where MFC raised its Count: the copy MFC counted is not created, and the withdrawn copy keeps only its origin', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const cx2 = importOccId(KEY, a.userId, x, 2);
    const hand = randomUUID();
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const added = [edit(b, `occ/${hand}/head`, { head_id: S }, bSaw), edit(b, `occ/${hand}/status`, { status: 'owned' }, bSaw)];
    const re = await imported(a, [row(x, 'Owned', { count: '2' })], DATE_B);
    expect(re.occurrencesAdded).toBe(1);
    const { cursor: aSaw } = await drain(a);

    expect(outcomes(await pushed(b, added))).toEqual(['APPLIED', 'APPLIED']);
    expect(shape((await drain(a, aSaw)).events, { [hand]: 'HAND', [cx2]: 'CX2', [S]: 'HX' })).toEqual([
      ['occ/HAND/head', 'UPSERT'],
      ['occ/HAND/status', 'UPSERT'],
      ['imp/mfc/change/HX', 'DELETE'],
      ['occ/CX2/head', 'DELETE'],
      ['occ/CX2/status', 'DELETE'],
    ]);
    const state = await stateOf(a);
    expect(state.has(`occ/${cx2}/origin`)).toBe(true);
    expect(await copyBase(a.userId, cx2)).toBeUndefined();
    expect(await copyBase(a.userId, hand)).toEqual({ kind: 'owned', import_removed: false });
    expect(await imported(a, [row(x, 'Owned', { count: '2' })], DATE_B)).toMatchObject({ facetsWritten: 1, conflictsRaised: 0 });
  });
});

describe('HELD only for a reaction', () => {
  it('(i) holds a late sale when another device acted on the result first: it added a copy after seeing the removal', async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    await imported(a, [row(y, 'Owned')], DATE_B);
    const { cursor: aSaw } = await drain(a);
    const hand = randomUUID();
    expect(outcomes(await pushed(a, [edit(a, `occ/${hand}/head`, { head_id: S }, aSaw), edit(a, `occ/${hand}/status`, { status: 'owned' }, aSaw)]))).toEqual([
      'APPLIED',
      'APPLIED',
    ]);

    const res = await pushed(b, [sale]);
    expect(outcomes(res)).toEqual(['HELD']);
    expect(res.results[0]!.current).toMatchObject({ op: SyncOp.DELETE });
    expect(await heldCount(a.userId)).toBe(1);
  });

  it('(iii) holds a late sale whose replay changes a result the user has since answered', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    const re = await imported(a, [row(x, 'Wished')], DATE_B);
    const { cursor: aSaw } = await drain(a);
    expect(outcomes(await pushed(a, [answer(a, S, { item: 'change', rev: re.applied[0]!.rev, choice: 'dismiss' }, aSaw)]))).toEqual(['APPLIED']);

    expect(outcomes(await pushed(b, [sale]))).toEqual(['HELD']);
    expect((await stateOf(a)).get(`occ/${cx}/status`)).toMatchObject({ status: 'wished' });
  });

  it('(ii) holds an edit made after the import and before a revision it had not seen that reacts to the result the revision withdrew', async () => {
    const { a, b } = await twoDevices();
    const c = await SyncCaller.sibling(h, a);
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    await imported(a, [row(y, 'Owned')], DATE_B);
    // c pulls the removal and its change entry, then goes offline.
    const { cursor: cSaw } = await drain(c);
    // b's late sale withdraws the change entry: a revision c has not seen.
    expect(outcomes(await pushed(b, [sale]))).toEqual(['APPLIED']);

    const fresh = randomUUID();
    const res = await pushed(c, [
      // Puts back by hand the copy the change entry it saw removed: a reaction.
      edit(c, `occ/${cx}/status`, { status: 'owned' }, cSaw, 2000),
      // A copy that had no head when the import ran, added to the figure: a reaction.
      edit(c, `occ/${fresh}/head`, { head_id: S }, cSaw, 2000),
      edit(c, `occ/${fresh}/status`, { status: 'owned' }, cSaw, 2000),
      // A figure value is never a reaction.
      edit(c, `uf/${S}/score`, { score: 8 }, cSaw, 2000),
    ]);
    expect(outcomes(res)).toEqual(['HELD', 'HELD', 'HELD', 'APPLIED']);
    expect((await stateOf(a)).get(`occ/${cx}/status`)).toMatchObject({ status: 'former' });

    // Once c has pulled the revision its edits are knowing for it.
    const { cursor: cNow } = await drain(c);
    expect(outcomes(await pushed(c, [edit(c, `occ/${cx}/status`, { status: 'owned' }, cNow, 3000)]))).toEqual(['APPLIED']);
  });

  it('(ii) holds an edit to a copy whose live state the revision changed, and applies one to a copy it left alone', async () => {
    const { a, b } = await twoDevices();
    const c = await SyncCaller.sibling(h, a);
    const x = nextId();
    const S = headFor(x);
    const [cx, cx2] = [1, 2].map((n) => importOccId(KEY, a.userId, x, n));
    const hand = randomUUID();
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const added = [edit(b, `occ/${hand}/head`, { head_id: S }, bSaw), edit(b, `occ/${hand}/status`, { status: 'owned' }, bSaw)];
    await imported(a, [row(x, 'Owned', { count: '2' })], DATE_B);
    const { cursor: cSaw } = await drain(c);
    // The revision withdraws the copy the import created for MFC's second one.
    expect(outcomes(await pushed(b, added))).toEqual(['APPLIED', 'APPLIED']);

    const res = await pushed(c, [
      edit(c, `occ/${cx2}/tag/${randomUUID()}`, {}, cSaw, 2000),
      edit(c, `occ/${cx}/tag/${randomUUID()}`, {}, cSaw, 2000),
    ]);
    expect(outcomes(res)).toEqual(['HELD', 'APPLIED']);
  });
});

describe('a late edit the replay is not built for is held, as WK-14a held every late edit', () => {
  it('holds a late edit for a frame recorded without the figure as it stood before the import', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned', { note: 'first' })]);
    const { cursor: bSaw } = await drain(b);
    await imported(a, [row(x, 'Owned', { note: 'second' })], DATE_B);
    await db.admin.query('UPDATE import_frame SET before = NULL WHERE user_id = $1', [a.userId]);
    expect(outcomes(await pushed(b, [edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw)]))).toEqual(['HELD']);
  });

  it('holds a late edit pushed to a replica without the import key', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned', { note: 'first' })]);
    const { cursor: bSaw } = await drain(b);
    await imported(a, [row(x, 'Owned', { note: 'second' })], DATE_B);
    const bare = await startSyncApp(db.app, h.issuer, undefined, undefined, { import: { db: db.app, spineRead: null, occIdKey: null } });
    try {
      const there = await SyncCaller.sibling(bare, a);
      expect(outcomes(await pushed(there, [edit(there, `occ/${cx}/status`, { status: 'former' }, bSaw)]))).toEqual(['HELD']);
    } finally {
      await bare.close();
    }
  });

  it('holds the late edits of one figure that are late for different imports, when the replay would change a result', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: early } = await drain(b);
    await imported(a, [row(x, 'Owned', { note: 'n' })], DATE_B);
    const { cursor: mid } = await drain(b);
    await imported(a, [row(x, 'Wished', { note: 'n' })], DATE_B);
    const res = await pushed(b, [edit(b, `occ/${cx}/status`, { status: 'former' }, mid), edit(b, `uf/${S}/score`, { score: 3 }, early)]);
    expect(outcomes(res)).toEqual(['HELD', 'HELD']);
  });
});
