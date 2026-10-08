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
import { encodeCursor } from '../../src/sync/cursor.js';
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
/** An id the spine resolves to another id's head: a second MFC row of one figure. */
const sameFigureAs = new Map<string, string>();

beforeAll(async () => {
  db = await startSyncDatabase();
  spine = await startFakeSpineRead({
    keys: new Map(),
    respondProducts: ({ request }) => {
      const ids = request.refs.map((r) => (r.ref.case === 'sourceItem' ? r.ref.value.nativeId : ''));
      return create(GetProductsResponseSchema, {
        productsJson: JSON.stringify({
          products: ids.map((id) => ({ productId: headFor(sameFigureAs.get(id) ?? id), requestedAs: [{ sourceItem: { site: 'mfc', nativeId: id } }] })),
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

/** The late edits kept for later replays, as [facet key, import number]. */
const lateRows = async (userId: string) =>
  (
    await db.admin.query<{ facet_key: string; import_number: number }>(
      'SELECT facet_key, import_number FROM import_late_edit WHERE user_id = $1 ORDER BY import_number, facet_key',
      [userId],
    )
  ).rows.map((r) => [r.facet_key, r.import_number]);

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
    // Stamped a minute ahead: above the import's write, so it lands under its own version.
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw, 60_000);
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
    expect(tail[0]).toMatchObject({ version: sale.version, payload: sale.payload });
    expect(await pending(b)).toBe(0n);
    expect(await heldCount(a.userId)).toBe(0);
    // MFC and the app agree: the copy's base is out, and no import removed it.
    expect(await copyBase(a.userId, cx)).toEqual({ kind: 'out', import_removed: false });
    const again = await imported(a, [row(y, 'Owned')], DATE_B);
    expect(again).toMatchObject({ facetsWritten: 1, conflictsRaised: 0, conflictsPending: 0 });
  });

  it("a late sale while MFC moved the copy to Wished: the sale is MFC's removal, and MFC's wish is made a new copy", async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const [cx, cx2] = [1, 2].map((n) => importOccId(KEY, a.userId, x, n)) as [string, string];
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    // MFC's Owned to Wished is a removal and a new wish: the import restores the copy it removed as wished.
    const re = await imported(a, [row(x, 'Wished')], DATE_B);
    expect(re).toMatchObject({ occurrencesStatusChanged: 1, conflictsRaised: 0 });
    const { cursor: aSaw } = await drain(a);

    expect(outcomes(await pushed(b, [sale]))).toEqual(['APPLIED']);
    const tail = (await drain(a, aSaw)).events;
    expect(shape(tail, { [cx]: 'CX', [cx2]: 'CX2', [S]: 'HX' })).toEqual([
      ['occ/CX/status', 'UPSERT'],
      ['occ/CX2/origin', 'UPSERT'],
      ['occ/CX2/head', 'UPSERT'],
      ['occ/CX2/status', 'UPSERT'],
      ['imp/mfc/change/HX', 'UPSERT'],
    ]);
    const state = await stateOf(a);
    expect(state.get(`occ/${cx}/status`)).toMatchObject({ status: 'former' });
    expect(state.get(`occ/${cx2}/status`)).toMatchObject({ status: 'wished' });
    expect(state.get(`imp/mfc/change/${S}`)).not.toMatchObject({ rev: re.applied[0]!.rev });
    expect(await pending(b)).toBe(0n);
    expect(await imported(a, [row(x, 'Wished')], DATE_B)).toMatchObject({ facetsWritten: 1, conflictsRaised: 0 });
  });

  it('a late move to the wishlist while MFC dropped the row: the replay raises the conflict the import would have, and keep answers it', async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    // Stamped now, between the two imports: above the first's write, below the second's, so the
    // server mints its value above the second's.
    const wish = edit(b, `occ/${cx}/status`, { status: 'wished' }, bSaw, 0);
    const re = await imported(a, [row(y, 'Owned')], DATE_B);
    expect(re).toMatchObject({ occurrencesRemoved: 1, conflictsRaised: 0 });
    const { cursor: aSaw } = await drain(a);

    expect(outcomes(await pushed(b, [wish]))).toEqual(['APPLIED']);
    const tail = (await drain(a, aSaw)).events;
    expect(shape(tail, { [cx]: 'CX', [S]: 'HX' })).toEqual([
      ['occ/CX/status', 'UPSERT'],
      ['imp/mfc/figure/HX', 'UPSERT'],
      ['imp/mfc/change/HX', 'DELETE'],
    ]);
    expect(tail[0]!.payload).toBe(wish.payload);
    expect(tail[0]!.version).toMatch(/#0{32}$/);
    const item = JSON.parse(tail[1]!.payload) as { rev: string; kind: string; counts: Record<string, { base: number; app: number; mfc: number }> };
    expect(figureSchema(item)).toBe(true);
    expect(item).toMatchObject({ kind: 'conflict', counts: { owned: { base: 1, app: 0, mfc: 0 }, wished: { base: 0, app: 1, mfc: 0 } } });
    expect(await pending(b)).toBe(1n);
    // Nothing of the figure moved: its copy keeps its base, and the row its base.
    expect(await copyBase(a.userId, cx)).toEqual({ kind: 'owned', import_removed: false });

    const { cursor: seen } = await drain(a, aSaw);
    expect(outcomes(await pushed(a, [answer(a, S, { item: 'figure', rev: item.rev, choice: 'keep' }, seen)]))).toEqual(['APPLIED']);
    expect(await pending(a)).toBe(0n);
    expect((await stateOf(a)).get(`occ/${cx}/status`)).toMatchObject({ status: 'wished' });
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

    // b, back online, files the copy after pulling: one unit with the late sale, held with it.
    const { cursor: bLater } = await drain(b);
    const res = await pushed(b, [sale, edit(b, `occ/${cx}/collection`, { collection: 'owned/default' }, bLater)]);
    expect(outcomes(res)).toEqual(['HELD', 'HELD']);
    expect(res.results[0]!.current).toMatchObject({ op: SyncOp.DELETE });
    expect(await heldCount(a.userId)).toBe(2);
    // A held edit is not replayed: no later replay places it.
    expect((await db.admin.query('SELECT 1 FROM import_late_edit WHERE user_id = $1', [a.userId])).rows).toHaveLength(0);
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
    const [cx, cx2] = [1, 2].map((n) => importOccId(KEY, a.userId, x, n)) as [string, string];
    const hand = randomUUID();
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const added = [edit(b, `occ/${hand}/head`, { head_id: S }, bSaw), edit(b, `occ/${hand}/status`, { status: 'owned' }, bSaw)];
    await imported(a, [row(x, 'Owned', { count: '2' })], DATE_B);
    const { cursor: cSaw } = await drain(c);
    // The revision withdraws the copy the import created for MFC's second one.
    expect(outcomes(await pushed(b, added))).toEqual(['APPLIED', 'APPLIED']);
    // e pulls the revision at once: its basis is the revision's own commit.
    const e = await SyncCaller.sibling(h, a);
    const { cursor: eSaw } = await drain(e);

    const res = await pushed(c, [
      edit(c, `occ/${cx2}/tag/${randomUUID()}`, {}, cSaw, 2000),
      edit(c, `occ/${cx}/tag/${randomUUID()}`, {}, cSaw, 2000),
    ]);
    expect(outcomes(res)).toEqual(['HELD', 'APPLIED']);
    // With an edit on another figure from before it all in the same push, so the revision is read.
    const elsewhere = edit(e, `uf/${headFor(nextId())}/score`, { score: 1 }, '', 2000);
    expect(outcomes(await pushed(e, [elsewhere, edit(e, `occ/${cx2}/tag/${randomUUID()}`, {}, eSaw, 2000)]))).toEqual(['APPLIED', 'APPLIED']);
    // Made before the import, a late copy is no reaction to the revision: replayed, it pairs with nothing new.
    const late = `ffffffff-ffff-4fff-bfff-${randomUUID().slice(-12)}`;
    const res2 = await pushed(b, [edit(b, `occ/${late}/head`, { head_id: S }, bSaw, 3000), edit(b, `occ/${late}/status`, { status: 'owned' }, bSaw, 3000)]);
    expect(outcomes(res2)).toEqual(['APPLIED', 'APPLIED']);
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

describe('a revision: the edges', () => {
  it('holds a late move of a copy between two figures the re-import settled, when the replay changes one of them', async () => {
    const { a, b } = await twoDevices();
    const [x, t] = [nextId(), nextId()];
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned'), row(t, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const move = edit(b, `occ/${cx}/head`, { head_id: headFor(t) }, bSaw);
    // MFC adds a copy of x and changes t's note: both figures settled.
    await imported(a, [row(x, 'Owned', { count: '2' }), row(t, 'Owned', { note: 'n' })], DATE_B);
    expect(outcomes(await pushed(b, [move]))).toEqual(['HELD']);
    // t's import decides the same with the move placed, but the unit is held whole: not kept as replayed.
    expect((await db.admin.query('SELECT 1 FROM import_late_edit WHERE user_id = $1', [a.userId])).rows).toHaveLength(0);
  });

  it('a revision that only moves bases: the late copy is the one MFC\'s addition pairs with, and a copy kept against MFC\'s removal stays kept', async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const [cx1, cx2] = [1, 2].map((n) => importOccId(KEY, a.userId, x, n)) as [string, string];
    const removed = [cx1, cx2].sort()[1]!;
    await imported(a, [row(x, 'Owned', { count: '2' }), row(y, 'Owned')]);
    const lowered = await imported(a, [row(x, 'Owned'), row(y, 'Owned')], DATE_B);
    const { cursor } = await drain(a);
    // a puts back the copy MFC's lowered Count removed: a knowing keep.
    await pushed(a, [answer(a, S, { item: 'change', rev: lowered.applied[0]!.rev, choice: 'undo' }, cursor)]);
    const kept = async () => (await db.admin.query<{ occ_id: string }>('SELECT occ_id FROM import_kept_copy WHERE user_id = $1', [a.userId])).rows.map((r) => r.occ_id);
    expect(await kept()).toEqual([removed]);
    const { cursor: bSaw } = await drain(b);
    // b adds a copy by hand, with an id below every import's: MFC's next addition pairs with it first.
    const hand = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
    const added = [edit(b, `occ/${hand}/head`, { head_id: S }, bSaw), edit(b, `occ/${hand}/status`, { status: 'owned' }, bSaw)];
    // MFC's Count goes back to 2: the import pairs that with the kept copy, which MFC now counts.
    await imported(a, [row(x, 'Owned', { count: '2' }), row(y, 'Owned')], DATE_B);
    expect(await kept()).toEqual([]);
    const { cursor: aSaw } = await drain(a);

    expect(outcomes(await pushed(b, added))).toEqual(['APPLIED', 'APPLIED']);
    // Placed before the import, the hand copy is the one paired: it takes the base, and the kept copy stays kept.
    expect(shape((await drain(a, aSaw)).events, { [hand]: 'HAND' })).toEqual([
      ['occ/HAND/head', 'UPSERT'],
      ['occ/HAND/status', 'UPSERT'],
    ]);
    expect(await copyBase(a.userId, hand)).toEqual({ kind: 'owned', import_removed: false });
    expect(await copyBase(a.userId, removed)).toMatchObject({ kind: 'out' });
    expect(await kept()).toEqual([removed]);
    // Nothing of S's live copies or items changed: no revision is recorded for HELD (ii) to read.
    expect((await db.admin.query('SELECT 1 FROM import_revision WHERE user_id = $1', [a.userId])).rows).toHaveLength(0);
  });
});

describe('the replay: what each guard decides', () => {
  /** Ids that sort below and above every id an import mints. */
  const low = () => `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
  const high = () => `ffffffff-ffff-4fff-bfff-${randomUUID().slice(-12)}`;
  const keptOf = async (userId: string) =>
    (await db.admin.query<{ occ_id: string }>('SELECT occ_id FROM import_kept_copy WHERE user_id = $1 ORDER BY occ_id', [userId])).rows.map((r) => r.occ_id);
  const handCopy = (c: SyncCaller, occ: string, S: string, basis: string, ms = 1000) => [
    edit(c, `occ/${occ}/head`, { head_id: S }, basis, ms),
    edit(c, `occ/${occ}/status`, { status: 'owned' }, basis, ms),
  ];

  it("a revision that moves only copy bases: MFC's addition pairs with the late hand copy, the lower id, not the one a added since", async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const [early, since] = [low(), high()];
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const { cursor: aSaw } = await drain(a);
    await pushed(a, handCopy(a, since, S, aSaw));
    await imported(a, [row(x, 'Owned', { count: '2' })], DATE_B);
    expect(await copyBase(a.userId, since)).toEqual({ kind: 'owned', import_removed: false });

    expect(outcomes(await pushed(b, handCopy(b, early, S, bSaw)))).toEqual(['APPLIED', 'APPLIED']);
    expect(await copyBase(a.userId, early)).toEqual({ kind: 'owned', import_removed: false });
    expect(await copyBase(a.userId, since)).toBeUndefined();
  });

  it('holds a late sale whose push also carries a knowing reaction to the result it would withdraw: a copy added after seeing the removal', async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    await imported(a, [row(y, 'Owned')], DATE_B);
    const { cursor: bLater } = await drain(b);
    const res = await pushed(b, [sale, ...handCopy(b, randomUUID(), S, bLater)]);
    expect(outcomes(res)).toEqual(['HELD', 'APPLIED', 'APPLIED']);
  });

  it("(iii) holds a late edit made before an answer the server accepted ahead of the import it is late for", async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    await pushed(a, [edit(a, `uf/${S}/score`, { score: 9 }, '', -60_000)]);
    const first = await imported(a, [row(x, 'Owned', { score: '7/10' })]);
    const { cursor: bSaw } = await drain(b);
    const { cursor: aSaw } = await drain(a);
    expect(outcomes(await pushed(a, [answer(a, S, { item: 'figure', rev: first.review[0]!.items[0]!.rev, choice: 'keep' }, aSaw)]))).toEqual(['APPLIED']);
    // MFC adds a note, which the app has none of: MFC's change alone, written.
    expect((await imported(a, [row(x, 'Owned', { score: '7/10', note: 'mfc' })], DATE_B)).applied).toHaveLength(1);
    const before = (await drain(a)).events.length;
    expect(outcomes(await pushed(b, [edit(b, `uf/${S}/note`, { note: 'mine' }, bSaw)]))).toEqual(['HELD']);
    expect((await drain(a)).events.length).toBe(before);
  });

  it('holds a late edit whose figure a later import framed again, though it settled nothing: the replay through it is not built', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    await imported(a, [row(x, 'Wished')], DATE_B);
    expect((await imported(a, [row(x, 'Wished')], DATE_B)).facetsWritten).toBe(1);
    expect(outcomes(await pushed(b, [sale]))).toEqual(['HELD']);
  });

  it("a late sale turns into a conflict a re-import that added a second row of the figure: the new row's base goes with the copy made for it", async () => {
    const { a, b } = await twoDevices();
    const [x, x2] = [nextId(), nextId()];
    sameFigureAs.set(x2, x);
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const sale = edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw);
    const re = await imported(a, [row(x, 'Owned'), row(x2, 'Owned')], DATE_B);
    expect(re.occurrencesAdded).toBe(1);
    const rowIds = async () =>
      (await db.admin.query<{ mfc_id: string }>('SELECT mfc_id FROM import_row_base WHERE user_id = $1 ORDER BY mfc_id', [a.userId])).rows.map((r) => r.mfc_id);
    expect(await rowIds()).toEqual([x, x2]);

    // Sold before the import, the copy MFC's second row adds meets the app's sale: a conflict, so no base moves.
    expect(outcomes(await pushed(b, [sale]))).toEqual(['APPLIED']);
    expect(await rowIds()).toEqual([x]);
    expect(await pending(b)).toBe(1n);
    const state = await stateOf(a);
    expect(state.get(`imp/mfc/figure/${S}`)).toMatchObject({ kind: 'conflict' });
    expect(state.has(`occ/${importOccId(KEY, a.userId, x2, 1)}/status`)).toBe(false);
  });

  /** Two copies of x; MFC lowers to 1; a undoes, keeping the copy MFC removed; a adds a low hand copy. */
  async function keptFigure() {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const removed = [1, 2].map((n) => importOccId(KEY, a.userId, x, n)).sort()[1]!;
    await imported(a, [row(x, 'Owned', { count: '2' }), row(y, 'Owned')]);
    const lowered = await imported(a, [row(x, 'Owned'), row(y, 'Owned')], DATE_B);
    const { cursor } = await drain(a);
    await pushed(a, [answer(a, S, { item: 'change', rev: lowered.applied[0]!.rev, choice: 'undo' }, cursor)]);
    const hand = low();
    const { cursor: undone } = await drain(a);
    await pushed(a, handCopy(a, hand, S, undone));
    const { cursor: bSaw } = await drain(b);
    expect(await keptOf(a.userId)).toEqual([removed]);
    return { a, b, x, y, S, removed, hand, bSaw };
  }

  it('a revision ends the knowing keep of a copy MFC counts again once the late sale is placed', async () => {
    const { a, b, x, y, removed, hand, bSaw } = await keptFigure();
    const sale = edit(b, `occ/${hand}/status`, { status: 'former' }, bSaw);
    // MFC's Count back to 2 pairs with the hand copy (the lower id): the kept copy stays kept.
    await imported(a, [row(x, 'Owned', { count: '2' }), row(y, 'Owned')], DATE_B);
    expect(await keptOf(a.userId)).toEqual([removed]);
    // Sold before that import, the hand copy pairs with nothing: MFC's addition is the kept copy, now counted.
    expect(outcomes(await pushed(b, [sale]))).toEqual(['APPLIED']);
    expect(await keptOf(a.userId)).toEqual([]);
    expect(await copyBase(a.userId, removed)).toMatchObject({ kind: 'owned' });
    expect(await copyBase(a.userId, hand)).toBeUndefined();
  });

  it('a revision keeps ended the knowing keep an earlier replayed late edit ended', async () => {
    const { a, b, x, y, removed, hand, bSaw } = await keptFigure();
    await imported(a, [row(x, 'Owned', { count: '2' }), row(y, 'Owned')], DATE_B);
    // Sold before that import: the kept copy's keep ends; the import decides the same with it placed.
    expect(outcomes(await pushed(b, [edit(b, `occ/${removed}/status`, { status: 'former' }, bSaw)]))).toEqual(['APPLIED']);
    expect(await keptOf(a.userId)).toEqual([]);
    // Then the hand copy, sold before it too: MFC's addition restores the copy an import removed.
    expect(outcomes(await pushed(b, [edit(b, `occ/${hand}/status`, { status: 'former' }, bSaw)]))).toEqual(['APPLIED']);
    expect((await stateOf(a)).get(`occ/${removed}/status`)).toMatchObject({ status: 'owned' });
    expect(await keptOf(a.userId)).toEqual([]);
  });

  it('holds, writing nothing, a late edit a revision would replay that reacts to an earlier revision it had not seen', async () => {
    const { a, b } = await twoDevices();
    const d = await SyncCaller.sibling(h, a);
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const [cx, cx2] = [1, 2].map((n) => importOccId(KEY, a.userId, x, n)) as [string, string];
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    const { cursor: dSaw } = await drain(d);
    await imported(a, [row(y, 'Owned')], DATE_B);
    const { cursor: bSaw } = await drain(b);
    // d's late sale withdraws the removal's change entry b saw: a revision b has not seen.
    expect(outcomes(await pushed(d, [edit(d, `occ/${cx}/status`, { status: 'former' }, dSaw)]))).toEqual(['APPLIED']);
    // MFC lists x again: the import makes a new copy.
    expect((await imported(a, [row(x, 'Owned'), row(y, 'Owned')], DATE_B)).occurrencesAdded).toBe(1);
    const before = (await drain(a)).events.length;
    // b puts back by hand the copy it saw removed: a reaction to the revision, and late for the last import.
    expect(outcomes(await pushed(b, [edit(b, `occ/${cx}/status`, { status: 'owned' }, bSaw, 60_000)]))).toEqual(['HELD']);
    expect((await drain(a)).events.length).toBe(before);
    expect((await stateOf(a)).get(`occ/${cx2}/status`)).toMatchObject({ status: 'owned' });
    expect(S).toBeTruthy();
  });

  it('a revision keeps a late figure value an earlier push replayed', async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    await imported(a, [row(y, 'Owned')], DATE_B);
    expect(outcomes(await pushed(b, [edit(b, `uf/${S}/score`, { score: 5 }, bSaw)]))).toEqual(['APPLIED']);
    expect(outcomes(await pushed(b, [edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw)]))).toEqual(['APPLIED']);
    const state = await stateOf(a);
    expect(state.get(`uf/${S}/score`)).toMatchObject({ score: 5 });
    expect(state.has(`imp/mfc/change/${S}`)).toBe(false);
  });

  it("a revision answers STALE a late filing the import's refile replaces, and emits the import's filing", async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const filed = edit(b, `occ/${cx}/collection`, { collection: `owned/${randomUUID()}` }, bSaw);
    // MFC moves x to Ordered: the import restores the copy it removed as ordered.
    await imported(a, [row(x, 'Ordered')], DATE_B);
    const { cursor: aSaw } = await drain(a);
    // Filed on the owned shelf before the import, the copy is refiled when it becomes ordered.
    const res = await pushed(b, [filed]);
    expect(outcomes(res)).toEqual(['STALE']);
    expect(JSON.parse(res.results[0]!.current!.payload)).toMatchObject({ collection: 'ordered/default' });
    expect(shape((await drain(a, aSaw)).events, { [cx]: 'CX', [S]: 'HX' })).toEqual([
      ['occ/CX/collection', 'UPSERT'],
      ['imp/mfc/change/HX', 'UPSERT'],
    ]);
    // A STALE answer is final: the filing is not kept for any later replay.
    expect(await lateRows(a.userId)).toEqual([]);
  });

  it('a late edit to a facet two imports wrote is STALE, and placed before neither again', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    await imported(a, [row(x, 'Owned', { count: '2' })], DATE_B);
    // b never pulled either import.
    const res = await pushed(b, [edit(b, `occ/${cx}/status`, { status: 'wished' }, '')]);
    expect(outcomes(res)).toEqual(['STALE']);
    expect(JSON.parse(res.results[0]!.current!.payload)).toMatchObject({ status: 'owned' });
  });
});

describe('a recorded late edit is placed again only where it stood: before its own import, and after it only while no import replaced it', () => {
  it('a late status the import overwrote (STALE) does not come back when a later revision of the next import replays the figure', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const d = await SyncCaller.sibling(h, a);
    const x = nextId();
    const S = headFor(x);
    const [cx, cx2] = [1, 2].map((n) => importOccId(KEY, a.userId, x, n)) as [string, string];
    await imported(a, [row(x, 'Owned')]);
    // b never pulled the import: its move to the wishlist is late, and the import wrote that facet.
    const r1 = await pushed(b, [edit(b, `occ/${cx}/status`, { status: 'wished' }, '', 60_000)]);
    expect(outcomes(r1)).toEqual(['STALE']);
    expect(JSON.parse(r1.results[0]!.current!.payload)).toMatchObject({ status: 'owned' });
    const { cursor: dSaw } = await drain(d);
    const hand = randomUUID();
    const added = [edit(d, `occ/${hand}/head`, { head_id: S }, dSaw), edit(d, `occ/${hand}/status`, { status: 'owned' }, dSaw)];
    await imported(a, [row(x, 'Owned', { count: '2' })], DATE_B);
    const { cursor: aSaw } = await drain(a);
    // d's late hand copy revises the second import; the replay of it must not place b's STALE move.
    expect(outcomes(await pushed(d, added))).toEqual(['APPLIED', 'APPLIED']);
    const tail = shape((await drain(a, aSaw)).events, { [cx]: 'CX', [cx2]: 'CX2', [hand]: 'HAND', [S]: 'HX' });
    expect(tail).not.toContainEqual(['occ/CX/status', 'UPSERT']);
    expect((await stateOf(a)).get(`occ/${cx}/status`)).toMatchObject({ status: 'owned' });
  });

  it("a late filing the import's refile replaced (STALE) stays replaced: an ordered copy is not filed back on the owned shelf by a later revision", async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const d = await SyncCaller.sibling(h, a);
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const shelf = `owned/${randomUUID()}`;
    const filed = edit(b, `occ/${cx}/collection`, { collection: shelf }, bSaw, 60_000);
    await imported(a, [row(x, 'Ordered')], DATE_B);
    const r1 = await pushed(b, [filed]);
    expect(outcomes(r1)).toEqual(['STALE']);
    expect(JSON.parse(r1.results[0]!.current!.payload)).toMatchObject({ collection: 'ordered/default' });
    const { cursor: dSaw } = await drain(d);
    const hand = randomUUID();
    await imported(a, [row(x, 'Ordered', { count: '2' })], '2026-09-30');
    const { cursor: aSaw } = await drain(a);
    const r2 = await pushed(d, [edit(d, `occ/${hand}/head`, { head_id: S }, dSaw), edit(d, `occ/${hand}/status`, { status: 'ordered' }, dSaw)]);
    expect(outcomes(r2)).toEqual(['APPLIED', 'APPLIED']);
    expect(shape((await drain(a, aSaw)).events, { [cx]: 'CX', [hand]: 'HAND', [S]: 'HX' })).not.toContainEqual(['occ/CX/collection', 'UPSERT']);
    const state = await stateOf(a);
    expect(state.get(`occ/${cx}/collection`)).toMatchObject({ collection: 'ordered/default' });
    expect(state.get(`occ/${cx}/status`)).toMatchObject({ status: 'ordered' });
  });

  it('a late edit late for two imports is recorded under the earlier, and one answered STALE is not recorded', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    await imported(a, [row(x, 'Owned', { count: '2' })], DATE_B);
    // b never pulled either import: the first import wrote the status, the score neither did.
    const res = await pushed(b, [edit(b, `occ/${cx}/status`, { status: 'wished' }, ''), edit(b, `uf/${S}/score`, { score: 3 }, '')]);
    expect(outcomes(res)).toEqual(['STALE', 'APPLIED']);
    const { rows: runs } = await db.admin.query<{ n: number }>('SELECT min(import_number) AS n FROM import_run WHERE user_id = $1', [a.userId]);
    expect(await lateRows(a.userId)).toEqual([[`uf/${S}/score`, runs[0]!.n]]);
  });

  it('one push, two late edits with different bases: the newer is placed before only the import it is late for', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned', { note: 'n1' })]);
    const { cursor: mid } = await drain(b);
    const older = edit(b, `occ/${cx}/collection`, { collection: `owned/${randomUUID()}` }, '');
    const newer = edit(b, `uf/${S}/note`, { note: 'mine' }, mid);
    await imported(a, [row(x, 'Owned', { note: 'n1', count: '2' })], DATE_B);
    // Placed before the first import too, the note would be the first import's to write.
    expect(outcomes(await pushed(b, [older, newer]))).toEqual(['APPLIED', 'APPLIED']);
    expect((await stateOf(a)).get(`uf/${S}/note`)).toMatchObject({ note: 'mine' });
    expect(await heldCount(a.userId)).toBe(0);
  });

  it('one push, two late edits with different bases: the newer is replayed before the import it is late for though an earlier import wrote its facet', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned', { note: 'n1' })]);
    const { cursor: mid } = await drain(b);
    const older = edit(b, `occ/${cx}/collection`, { collection: `owned/${randomUUID()}` }, '');
    const newer = edit(b, `uf/${S}/note`, { note: 'mine' }, mid);
    await imported(a, [row(x, 'Owned', { note: 'n2' })], DATE_B);
    // Replayed before the second import, the note it had not seen change raises the note conflict:
    // a replay that changes a decision of a push late for two imports is held, not applied over MFC's note.
    const res = await pushed(b, [older, newer]);
    expect(outcomes(res)).toEqual(['HELD', 'HELD']);
    expect(await heldCount(a.userId)).toBe(2);
    expect((await stateOf(a)).get(`uf/${S}/note`)).toMatchObject({ note: 'n2' });
  });

  it('a second revision whose replay raises no conflict ends the item the first raised', async () => {
    const { a, b } = await twoDevices();
    const d = await SyncCaller.sibling(h, a);
    const [x, y] = [nextId(), nextId()];
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const { cursor: dSaw } = await drain(d);
    const wish = edit(b, `occ/${cx}/status`, { status: 'wished' }, bSaw, 0);
    const sale = edit(d, `occ/${cx}/status`, { status: 'former' }, dSaw, 60_000);
    await imported(a, [row(y, 'Owned')], DATE_B);
    // b's late move to the wishlist, where MFC dropped the row: the replay raises the conflict.
    expect(outcomes(await pushed(b, [wish]))).toEqual(['APPLIED']);
    expect(await pending(a)).toBe(1n);
    const { cursor: aSaw } = await drain(a);
    // d's later late sale, replayed with b's move, is MFC's removal: no conflict, so the item ends.
    expect(outcomes(await pushed(d, [sale]))).toEqual(['APPLIED']);
    expect(shape((await drain(a, aSaw)).events, { [cx]: 'CX', [S]: 'HX' })).toContainEqual(['imp/mfc/figure/HX', 'DELETE']);
    expect(await pending(a)).toBe(0n);
    expect((await stateOf(a)).get(`occ/${cx}/status`)).toMatchObject({ status: 'former' });
  });

  it('a revision of the import whose refile made a late filing STALE does not bring the filing back: the copy keeps the filing it had before that import', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const d = await SyncCaller.sibling(h, a);
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const { cursor: dSaw } = await drain(d);
    const filedBefore = (await stateOf(a)).get(`occ/${cx}/collection`);
    const shelf = `owned/${randomUUID()}`;
    const filing = edit(b, `occ/${cx}/collection`, { collection: shelf }, bSaw, 60_000);
    await imported(a, [row(x, 'Ordered')], DATE_B);
    // The import refiles the copy it moves to Ordered: b's filing is STALE, and that answer is final.
    expect(outcomes(await pushed(b, [filing]))).toEqual(['STALE']);
    const { cursor: aSaw } = await drain(a);
    // d's late ordered copy is the one MFC moved: the import, replayed with it, removes x's copy and
    // refiles nothing. b's filing is not placed, so the copy's filing is the one before the import.
    const hand = randomUUID();
    expect(outcomes(await pushed(d, [edit(d, `occ/${hand}/head`, { head_id: S }, dSaw), edit(d, `occ/${hand}/status`, { status: 'ordered' }, dSaw)]))).toEqual(['APPLIED', 'APPLIED']);
    const tail = (await drain(a, aSaw)).events;
    expect(tail.filter((e) => e.payload === filing.payload)).toEqual([]);
    expect(shape(tail, { [cx]: 'CX', [hand]: 'HAND', [S]: 'HX' })).toContainEqual(['occ/CX/status', 'DELETE']);
    expect((await stateOf(a)).get(`occ/${cx}/collection`)).toEqual(filedBefore);
  });

  it('(ii) reads the revisions from the oldest basis in the push: an edit made before a revision is held beside one made after it', async () => {
    const { a, b } = await twoDevices();
    const c = await SyncCaller.sibling(h, a);
    const x = nextId();
    const S = headFor(x);
    const cx2 = importOccId(KEY, a.userId, x, 2);
    const hand = randomUUID();
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const added = [edit(b, `occ/${hand}/head`, { head_id: S }, bSaw), edit(b, `occ/${hand}/status`, { status: 'owned' }, bSaw)];
    await imported(a, [row(x, 'Owned', { count: '2' })], DATE_B);
    const { cursor: cSaw } = await drain(c);
    // The revision withdraws the copy the import created for MFC's second one.
    expect(outcomes(await pushed(b, added))).toEqual(['APPLIED', 'APPLIED']);
    // A cursor after the revision, from a device that pulled it.
    const { cursor: cNow } = await drain(await SyncCaller.sibling(h, a));
    const res = await pushed(c, [
      edit(c, `occ/${cx2}/tag/${randomUUID()}`, {}, cSaw, 2000),
      edit(c, `uf/${headFor(nextId())}/score`, { score: 1 }, cNow, 2000),
    ]);
    expect(outcomes(res)).toEqual(['HELD', 'APPLIED']);
  });
});


describe('a STALE answer is final: no later replay or revision emits the value of an edit answered STALE', () => {
  /** Pushes that note each edit answered STALE, with the feed cursor just after the answer. */
  const track = () => {
    const stale: { facetKey: string; payload: string; after: string }[] = [];
    return {
      async push(c: SyncCaller, watcher: SyncCaller, events: ReturnType<typeof edit>[]) {
        const res = await pushed(c, events);
        const { cursor } = await drain(watcher);
        res.results.forEach((r, i) => {
          if (r.outcome === PushOutcome.STALE) stale.push({ facetKey: events[i]!.facetKey, payload: events[i]!.payload, after: cursor });
        });
        return res;
      },
      /** Each event after a STALE answer that carries that STALE edit's value. */
      async reEmitted(watcher: SyncCaller) {
        const found: string[] = [];
        for (const s of stale) for (const e of (await drain(watcher, s.after)).events) if (e.facetKey === s.facetKey && e.payload === s.payload) found.push(e.facetKey);
        return { answered: stale.length, found };
      },
    };
  };
  const collectionOf = async (c: SyncCaller, occ: string) => ((await stateOf(c)).get(`occ/${occ}/collection`) as { collection?: string } | undefined)?.collection;

  /**
   * Devices b and d pulled the first import (x Owned); the second moves x to Ordered and refiles
   * its copy. b's filing R (stamped later) is STALE; d's push adds an ordered hand copy, which
   * revises the second import so it refiles nothing, with its own filing F (stamped earlier).
   */
  async function refiled() {
    const a = await SyncCaller.enrol(h);
    const [b, d, e] = [await SyncCaller.sibling(h, a), await SyncCaller.sibling(h, a), await SyncCaller.sibling(h, a)];
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    const { cursor: dSaw } = await drain(d);
    const [shelfR, shelfF] = [`owned/${randomUUID()}`, `owned/${randomUUID()}`];
    const R = edit(b, `occ/${cx}/collection`, { collection: shelfR }, bSaw, 120_000);
    const F = edit(d, `occ/${cx}/collection`, { collection: shelfF }, dSaw, 60_000);
    const hand = randomUUID();
    await imported(a, [row(x, 'Ordered')], DATE_B);
    const t = track();
    expect(outcomes(await t.push(b, a, [R]))).toEqual(['STALE']);
    // R is not placed: F, the only filing that stands, is APPLIED by the revision.
    expect(outcomes(await t.push(d, a, [edit(d, `occ/${hand}/head`, { head_id: S }, dSaw), edit(d, `occ/${hand}/status`, { status: 'ordered' }, dSaw), F]))).toEqual([
      'APPLIED',
      'APPLIED',
      'APPLIED',
    ]);
    expect(await collectionOf(a, cx)).toBe(shelfF);
    return { a, e, x, S, cx, shelfF, t };
  }

  it("a filing answered STALE comes back in neither a revision of its import nor a later import's revision", async () => {
    const { a, e, x, S, cx, shelfF, t } = await refiled();
    const { cursor: eSaw } = await drain(e);
    await imported(a, [row(x, 'Ordered', { count: '2' })], '2026-09-30');
    const hand2 = randomUUID();
    expect(outcomes(await t.push(e, a, [edit(e, `occ/${hand2}/head`, { head_id: S }, eSaw), edit(e, `occ/${hand2}/status`, { status: 'ordered' }, eSaw)]))).toEqual([
      'APPLIED',
      'APPLIED',
    ]);
    expect(await t.reEmitted(a)).toEqual({ answered: 1, found: [] });
    expect(await collectionOf(a, cx)).toBe(shelfF);
  });

  it('on a live copy: a late note that revises a later import (its note conflict) brings back no filing answered STALE', async () => {
    const { a, e, x, S, cx, shelfF, t } = await refiled();
    const { cursor: eSaw } = await drain(e);
    await imported(a, [row(x, 'Ordered', { count: '2', note: 'n3' })], '2026-09-30');
    expect(outcomes(await t.push(e, a, [edit(e, `uf/${S}/note`, { note: 'e-note' }, eSaw)]))).toEqual(['APPLIED']);
    expect(await heldCount(a.userId)).toBe(0);
    expect(await t.reEmitted(a)).toEqual({ answered: 1, found: [] });
    expect(await collectionOf(a, cx)).toBe(shelfF);
  });

  it('a revision that drops the refile does not stand a filing answered STALE; a later late filing for the same import is placed by LWW', async () => {
    const a = await SyncCaller.enrol(h);
    const [b, d, g] = [await SyncCaller.sibling(h, a), await SyncCaller.sibling(h, a), await SyncCaller.sibling(h, a)];
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const [{ cursor: bSaw }, { cursor: dSaw }, { cursor: gSaw }] = [await drain(b), await drain(d), await drain(g)];
    const [shelfR, shelfG] = [`owned/${randomUUID()}`, `owned/${randomUUID()}`];
    const hand = randomUUID();
    await imported(a, [row(x, 'Ordered')], DATE_B);
    const t = track();
    expect(outcomes(await t.push(b, a, [edit(b, `occ/${cx}/collection`, { collection: shelfR }, bSaw, 120_000)]))).toEqual(['STALE']);
    expect(outcomes(await t.push(d, a, [edit(d, `occ/${hand}/head`, { head_id: S }, dSaw), edit(d, `occ/${hand}/status`, { status: 'ordered' }, dSaw)]))).toEqual(['APPLIED', 'APPLIED']);
    expect(await collectionOf(a, cx)).not.toBe(shelfR);
    expect(outcomes(await t.push(g, a, [edit(g, `occ/${cx}/collection`, { collection: shelfG }, gSaw, 60_000)]))).toEqual(['APPLIED']);
    expect(await t.reEmitted(a)).toEqual({ answered: 1, found: [] });
    expect(await collectionOf(a, cx)).toBe(shelfG);
  });

  it('a late edit LWW answers STALE (a newer value is on the copy) is not kept for later replays', async () => {
    const { a, b } = await twoDevices();
    const c = await SyncCaller.sibling(h, a);
    const x = nextId();
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned', { note: 'n1' })]);
    const { cursor: bSaw } = await drain(b);
    const { cursor: cSaw } = await drain(c);
    const [shelfC, shelfB] = [`owned/${randomUUID()}`, `owned/${randomUUID()}`];
    expect(outcomes(await pushed(c, [edit(c, `occ/${cx}/collection`, { collection: shelfC }, cSaw, 120_000)]))).toEqual(['APPLIED']);
    await imported(a, [row(x, 'Owned', { note: 'n2' })], DATE_B);
    // b's filing is late for the note change, which the replay leaves as it was; c's is stamped above it.
    const res = await pushed(b, [edit(b, `occ/${cx}/collection`, { collection: shelfB }, bSaw, 60_000)]);
    expect(outcomes(res)).toEqual(['STALE']);
    expect(JSON.parse(res.results[0]!.current!.payload)).toMatchObject({ collection: shelfC });
    expect(await lateRows(a.userId)).toEqual([]);
  });

  it('a late edit LWW applies is kept, once, though it is late on two figures (a copy moved between them)', async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned', { note: 'n1' }), row(y, 'Owned', { note: 'n1' })]);
    const { cursor: bSaw } = await drain(b);
    await imported(a, [row(x, 'Owned', { note: 'n2' }), row(y, 'Owned', { note: 'n2' })], DATE_B);
    const shelf = `owned/${randomUUID()}`;
    const res = await pushed(b, [edit(b, `occ/${cx}/head`, { head_id: headFor(y) }, bSaw), edit(b, `occ/${cx}/collection`, { collection: shelf }, bSaw)]);
    expect(outcomes(res)).toEqual(['APPLIED', 'APPLIED']);
    expect(await collectionOf(a, cx)).toBe(shelf);
    const { rows: runs } = await db.admin.query<{ n: number }>('SELECT max(import_number) AS n FROM import_run WHERE user_id = $1', [a.userId]);
    const n = runs[0]!.n;
    expect((await lateRows(a.userId)).sort()).toEqual(
      [`occ/${cx}/collection`, `occ/${cx}/head`].flatMap((k) => [headFor(x), headFor(y)].map(() => [k, n])).sort(),
    );
  });
});

describe('the replay: pins of its order and its bounds', () => {
  it("places a push's late edits that no replay answered on the feed in push order, across figures", async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    await imported(a, [row(x, 'Owned', { note: 'n1' }), row(y, 'Owned', { note: 'n1' })]);
    const { cursor: bSaw } = await drain(b);
    await imported(a, [row(x, 'Owned', { note: 'n2' }), row(y, 'Owned', { note: 'n2' })], DATE_B);
    const { cursor: aSaw } = await drain(a);
    // The replay visits the figures in id order: push them the other way round.
    const [first, second] = [headFor(x), headFor(y)].sort().reverse() as [string, string];
    expect(outcomes(await pushed(b, [edit(b, `uf/${first}/score`, { score: 4 }, bSaw), edit(b, `uf/${second}/score`, { score: 2 }, bSaw)]))).toEqual(['APPLIED', 'APPLIED']);
    expect(shape((await drain(a, aSaw)).events, { [first]: 'FIRST', [second]: 'SECOND' })).toEqual([
      ['uf/FIRST/score', 'UPSERT'],
      ['uf/SECOND/score', 'UPSERT'],
    ]);
  });

  it('replays a figure only before the imports its own late edits had not seen, though the push carries an older basis for another figure', async () => {
    const { a, b } = await twoDevices();
    const [x, y] = [nextId(), nextId()];
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned'), row(y, 'Owned')]);
    // b saw the first import up to its marker, the last event of its transaction.
    const { cursor: bSaw } = await drain(b);
    await imported(a, [row(y, 'Owned')], DATE_B);
    // The sale revises the second import alone; counted late for the first too, it would be held.
    const res = await pushed(b, [edit(b, `uf/${headFor(y)}/score`, { score: 1 }, ''), edit(b, `occ/${cx}/status`, { status: 'former' }, bSaw, 60_000)]);
    expect(outcomes(res)).toEqual(['APPLIED', 'APPLIED']);
    expect(await heldCount(a.userId)).toBe(0);
  });

  it('does not hold a late edit for an answer at the very event its basis names: its device had seen it', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    await imported(a, [row(x, 'Owned')]);
    const re = await imported(a, [row(x, 'Wished')], DATE_B);
    const { cursor: aSaw } = await drain(a);
    expect(outcomes(await pushed(a, [answer(a, S, { item: 'change', rev: re.applied[0]!.rev, choice: 'dismiss' }, aSaw)]))).toEqual(['APPLIED']);
    const { rows } = await db.admin.query<{ seq: string }>('SELECT seq FROM feed_event WHERE user_id = $1 AND facet_key = $2', [a.userId, `res/mfc/${S}`]);
    const basis = encodeCursor(BigInt(rows[0]!.seq));
    await imported(a, [row(x, 'Wished', { note: 'n3' })], '2026-09-30');
    expect(outcomes(await pushed(b, [edit(b, `uf/${S}/score`, { score: 2 }, basis)]))).toEqual(['APPLIED']);
  });

  it('places a kept late edit before no import earlier than its own: a late edit for the first import meets the figure that import found', async () => {
    const { a, b } = await twoDevices();
    const c = await SyncCaller.sibling(h, a);
    const x = nextId();
    const S = headFor(x);
    const cx = importOccId(KEY, a.userId, x, 1);
    await imported(a, [row(x, 'Owned')]);
    const { cursor: bSaw } = await drain(b);
    await imported(a, [row(x, 'Owned', { note: 'n2' })], DATE_B);
    // b's hand copy is late for the second import only, and kept under it.
    const hand = randomUUID();
    expect(outcomes(await pushed(b, [edit(b, `occ/${hand}/head`, { head_id: S }, bSaw), edit(b, `occ/${hand}/status`, { status: 'owned' }, bSaw)]))).toEqual(['APPLIED', 'APPLIED']);
    const { rows: runs } = await db.admin.query<{ n: number }>('SELECT max(import_number) AS n FROM import_run WHERE user_id = $1', [a.userId]);
    expect(await lateRows(a.userId)).toEqual([`occ/${hand}/head`, `occ/${hand}/status`].map((k) => [k, runs[0]!.n]));
    // c never pulled either import: the first created x's copy, so c's move of it is STALE.
    const res = await pushed(c, [edit(c, `occ/${cx}/status`, { status: 'wished' }, '')]);
    expect(outcomes(res)).toEqual(['STALE']);
    expect(JSON.parse(res.results[0]!.current!.payload)).toMatchObject({ status: 'owned' });
  });

  it("places a kept late edit before a later import's revision too: an edit late for two imports, kept under the earlier, still stands", async () => {
    const { a, b } = await twoDevices();
    const d = await SyncCaller.sibling(h, a);
    const x = nextId();
    const S = headFor(x);
    await imported(a, [row(x, 'Owned', { note: 'n1' })]);
    const { cursor: bSaw } = await drain(b);
    const score = edit(b, `uf/${S}/score`, { score: 7 }, bSaw, -5000);
    await imported(a, [row(x, 'Owned', { note: 'n2' })], DATE_B);
    const { cursor: dSaw } = await drain(d);
    await imported(a, [row(x, 'Ordered', { note: 'n2' })], '2026-09-30');
    // The score is late for the second and third imports, and kept under the second.
    expect(outcomes(await pushed(b, [score]))).toEqual(['APPLIED']);
    const { rows: runs } = await db.admin.query<{ n: number }>('SELECT import_number AS n FROM import_run WHERE user_id = $1 ORDER BY import_number', [a.userId]);
    expect(await lateRows(a.userId)).toEqual([[`uf/${S}/score`, runs[1]!.n]]);
    // d's hand copy is late for the third import alone and revises it: the replay before the third
    // import must place the score kept under the second, or the revision drops it.
    const hand = randomUUID();
    expect(outcomes(await pushed(d, [edit(d, `occ/${hand}/head`, { head_id: S }, dSaw, -4000), edit(d, `occ/${hand}/status`, { status: 'ordered' }, dSaw, -4000)]))).toEqual([
      'APPLIED',
      'APPLIED',
    ]);
    expect((await stateOf(a)).get(`uf/${S}/score`)).toMatchObject({ score: 7 });
  });

  // STALE, as push order answers it: LWW applies the newer edit ahead of it first, so the older late
  // edit meets a higher version (what a figure no import framed answers), and the newer value stands.
  it('answers STALE a late edit the push carries after a newer edit to the same key that is not late, and leaves the newer value standing', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    await imported(a, [row(x, 'Owned', { note: 'n1' })]);
    const { cursor: bSaw } = await drain(b);
    await imported(a, [row(x, 'Owned', { note: 'n2' })], DATE_B);
    const { cursor: bNow } = await drain(b);
    const { cursor: aSaw } = await drain(a);
    const res = await pushed(b, [edit(b, `uf/${S}/score`, { score: 9 }, bNow, 5000), edit(b, `uf/${S}/score`, { score: 3 }, bSaw, 1000)]);
    expect(outcomes(res)).toEqual(['APPLIED', 'STALE']);
    expect(JSON.parse(res.results[1]!.current!.payload)).toMatchObject({ score: 9 });
    expect((await drain(a, aSaw)).events.map((e) => (JSON.parse(e.payload) as { score: number }).score)).toEqual([9]);
    expect(await lateRows(a.userId)).toEqual([]);
  });

  it('control: the same two edits pushed the other way round are both APPLIED in push order, and the newer value stands', async () => {
    const { a, b } = await twoDevices();
    const x = nextId();
    const S = headFor(x);
    await imported(a, [row(x, 'Owned', { note: 'n1' })]);
    const { cursor: bSaw } = await drain(b);
    await imported(a, [row(x, 'Owned', { note: 'n2' })], DATE_B);
    const { cursor: bNow } = await drain(b);
    const res = await pushed(b, [edit(b, `uf/${S}/score`, { score: 3 }, bSaw, 1000), edit(b, `uf/${S}/score`, { score: 9 }, bNow, 5000)]);
    expect(outcomes(res)).toEqual(['APPLIED', 'APPLIED']);
    expect((await stateOf(a)).get(`uf/${S}/score`)).toMatchObject({ score: 9 });
  });
});
