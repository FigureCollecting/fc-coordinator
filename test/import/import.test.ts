// WK-14a: ImportService.ImportMfcExport through the real Fastify app (OIDC + DPoP edge, Connect),
// on a real migrated Postgres, against a fake SpineRead served over gRPC on h2c. Never prod.
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
import { decodeCursor } from '../../src/sync/cursor.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';
import { DISPLAY, IMPORT_PATH, ok, startSyncApp, SyncCaller, type Rpc, type SyncApp } from '../helpers/syncClient.js';
import { startSyncDatabase, type SyncDatabase } from '../helpers/syncDatabase.js';
import { headFor, mfcCsv, rossShapedRows, semicolonCsv, type FixtureRow } from './fixture.js';

const require = createRequire(import.meta.url);
const vectors = JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/golden/key-vectors.json'), 'utf8')) as {
  mfcImportOccTestKey: { hex: string };
};
const KEY = new Uint8Array(Buffer.from(vectors.mfcImportOccTestKey.hex, 'hex'));
const ajv = new Ajv2020({ strict: false, allErrors: true });
const figureSchema = ajv.compile(
  JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/schemas/imp-figure.schema.json'), 'utf8')) as object,
);
const markerSchema = ajv.compile(
  JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/schemas/imp-import.schema.json'), 'utf8')) as object,
);

const EXPORT_DATE = '2026-09-09';
const IMPORT_VERSION = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z#(\d{10})#0{32}$/;

let db: SyncDatabase;
let spine: FakeSpineRead;
let h: SyncApp;
/** The ids the fake spine resolves; every other id is unresolved. */
const unknown = new Set<string>();
let spineDown = false;

beforeAll(async () => {
  db = await startSyncDatabase();
  spine = await startFakeSpineRead({
    keys: new Map(),
    respondProducts: ({ request }) => {
      if (spineDown) throw new ConnectError('down', Code.Unavailable);
      if (request.refs.length > 200) throw new ConnectError('at most 200 refs', Code.InvalidArgument);
      const ids = request.refs.map((r) => (r.ref.case === 'sourceItem' && r.ref.value.site === 'mfc' ? r.ref.value.nativeId : ''));
      const products: { productId: string; requestedAs: unknown[] }[] = [];
      for (const id of ids.filter((i) => i !== '' && !unknown.has(i))) {
        const productId = headFor(id);
        const known = products.find((p) => p.productId === productId);
        if (known) known.requestedAs.push({ sourceItem: { site: 'mfc', nativeId: id } });
        else products.push({ productId, requestedAs: [{ sourceItem: { site: 'mfc', nativeId: id } }] });
      }
      // Pages of 50, as the spine's default, whatever was asked for.
      const start = request.pageToken === '' ? 0 : Number(request.pageToken);
      return create(GetProductsResponseSchema, {
        productsJson: JSON.stringify({
          products: products.slice(start, start + 50),
          unresolved: start === 0 ? ids.filter((i) => unknown.has(i)).map((nativeId) => ({ sourceItem: { site: 'mfc', nativeId } })) : [],
          coverage: {},
        }),
        nextPageToken: start + 50 < products.length ? String(start + 50) : '',
      });
    },
  });
  h = await startSyncApp(db.app, undefined, undefined, undefined, {
    import: { db: db.app, spineRead: new SpineReadClient(spine.baseUrl), occIdKey: KEY, lockTimeoutMs: 400 },
  });
}, 240_000);

afterAll(async () => {
  await h?.close();
  await spine?.close();
  await db?.close();
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

async function feedCount(userId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>('SELECT count(*) AS n FROM feed_event WHERE user_id = $1', [userId]);
  return Number(rows[0]!.n);
}

async function runs(userId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>('SELECT count(*) AS n FROM import_run WHERE user_id = $1', [userId]);
  return Number(rows[0]!.n);
}

/** The live state a replica holds after applying the feed by LWW. */
function replica(events: readonly SyncEvent[]): Map<string, unknown> {
  const state = new Map<string, unknown>();
  for (const e of events) {
    if (e.op === SyncOp.DELETE) state.delete(e.facetKey);
    else state.set(e.facetKey, JSON.parse(e.payload));
  }
  return state;
}

function liveCopies(state: Map<string, unknown>): Map<string, { head: string; status: string }> {
  const out = new Map<string, { head: string; status: string }>();
  for (const [key, value] of state) {
    const m = /^occ\/([^/]+)\/status$/.exec(key);
    const head = state.get(`occ/${m?.[1]}/head`) as { head_id: string } | undefined;
    if (m && head) out.set(m[1]!, { head: head.head_id, status: (value as { status: string }).status });
  }
  return out;
}

const statusCounts = (copies: Map<string, { status: string }>) => {
  const c: Record<string, number> = {};
  for (const { status } of copies.values()) c[status] = (c[status] ?? 0) + 1;
  return c;
};

const failed = <T>(rpc: Rpc<T>): { code: string; message: string } => {
  if (rpc.ok) throw new Error('expected the call to fail');
  return { code: rpc.code, message: rpc.message };
};

const row = (id: string, status: FixtureRow['status'], extra: Partial<FixtureRow> = {}): FixtureRow => ({
  id,
  status,
  count: '1',
  score: '',
  wishability: '0',
  note: '',
  ...extra,
});

const nextId = (() => {
  let n = 4_000_000;
  return () => String((n += 1));
})();

describe("an export shaped like Ross's", () => {
  const rows = rossShapedRows();
  let a: SyncCaller;
  let first: ImportMfcExportResponse;

  beforeAll(async () => {
    a = await SyncCaller.enrol(h);
    spine.productCalls.length = 0;
    first = ok(await a.importMfcExport({ csvText: mfcCsv(rows), exportDate: EXPORT_DATE }));
  });

  it('makes 1,148 occurrences: 556 x1 + 4 x2 Owned, 10 Ordered, 574 Wished', async () => {
    expect(rows).toHaveLength(1144);
    expect(first).toMatchObject({
      resolved: 1144,
      unresolved: [],
      added: 1144,
      moved: 0,
      unchanged: 0,
      removed: 0,
      keptNewer: 0,
      occurrencesAdded: 1148,
      occurrencesStatusChanged: 0,
      occurrencesRemoved: 0,
      conflictsRaised: 0,
      conflictsPending: 0,
      importNumber: 1,
      review: [],
      applied: [],
    });
    // Every copy is origin + head + status; 118 scores, 11 notes, 570 wishabilities; then the marker.
    expect(first.facetsWritten).toBe(1148 * 3 + 118 + 11 + 570 + 1);

    const state = replica((await drain(a)).events);
    const copies = liveCopies(state);
    expect(copies.size).toBe(1148);
    expect(statusCounts(copies)).toEqual({ owned: 564, ordered: 10, wished: 574 });
    const figures = (field: string) => [...state.keys()].filter((k) => k.startsWith('uf/') && k.endsWith(`/${field}`)).length;
    expect([figures('score'), figures('note'), figures('wishability')]).toEqual([118, 11, 570]);
    const multi = rows.find((r) => r.note.includes('\r\n'))!;
    expect(state.get(`uf/${headFor(multi.id)}/note`)).toMatchObject({ note: multi.note });
  });

  it('writes the whole import as one server transaction, the marker last', async () => {
    const { events } = await drain(a);
    expect(events).toHaveLength(first.facetsWritten);
    expect(events.at(-1)).toMatchObject({ facetKey: 'imp/mfc/import' });
    expect(events.slice(0, -1).every((e) => e.commitCursor === '')).toBe(true);
    expect(events.at(-1)!.commitCursor).not.toBe('');
    const marker = JSON.parse(events.at(-1)!.payload) as object;
    expect(markerSchema(marker)).toBe(true);
    expect(marker).toEqual({ import: 1, export_date: EXPORT_DATE });
  });

  it('versions every write <server instant>#<import number>#<reserved server device>, displayed at the export date in UTC', async () => {
    const { events } = await drain(a);
    const versions = new Set(events.map((e) => e.version));
    expect(versions.size).toBe(1);
    const [version] = [...versions];
    expect(version).toMatch(IMPORT_VERSION);
    expect(IMPORT_VERSION.exec(version!)![1]).toBe('0000000001');
    for (const e of events.filter((x) => /^(occ\/[^/]+\/(head|status)|uf\/)/.test(x.facetKey))) {
      expect(JSON.parse(e.payload)).toMatchObject({ edited_at: `${EXPORT_DATE}T00:00:00Z`, tz: 'UTC' });
    }
  });

  it('names each copy by the keyed MAC of its user, MFC id and ordinal', async () => {
    const state = replica((await drain(a)).events);
    const origins = [...state].filter(([k]) => k.endsWith('/origin'));
    expect(origins).toHaveLength(1148);
    for (const [key, origin] of origins) {
      const o = origin as { site: string; native_id: string; ordinal: number };
      expect(o.site).toBe('mfc');
      expect(key).toBe(`occ/${importOccId(KEY, a.userId, o.native_id, o.ordinal)}/origin`);
    }
    const two = rows.find((r) => r.count === '2')!;
    expect(state.get(`occ/${importOccId(KEY, a.userId, two.id, 2)}/head`)).toMatchObject({ head_id: headFor(two.id) });
  });

  it('resolves the ids through SpineRead in batches of at most 200 refs, following every page', () => {
    const batches = spine.productCalls.filter((c) => c.request.pageToken === '');
    expect(batches.map((c) => c.request.refs.length)).toEqual([200, 200, 200, 200, 200, 144]);
    expect(spine.productCalls.length).toBeGreaterThan(batches.length);
    expect(spine.wire.every((w) => w.httpVersion === '2.0' && w.contentType?.startsWith('application/grpc'))).toBe(true);
  });

  it('writes nothing but its marker when the same export is imported again', async () => {
    const before = await feedCount(a.userId);
    const again = ok(await a.importMfcExport({ csvText: mfcCsv(rows), exportDate: EXPORT_DATE }));
    expect(again).toMatchObject({ resolved: 1144, added: 0, unchanged: 1144, occurrencesAdded: 0, facetsWritten: 1, importNumber: 2 });
    expect(await feedCount(a.userId)).toBe(before + 1);
  });

  it('reads the same export with its columns reordered and a ";" delimiter identically: nothing new is written', async () => {
    const before = await feedCount(a.userId);
    const again = ok(await a.importMfcExport({ csvText: semicolonCsv(rows), exportDate: EXPORT_DATE }));
    expect(again).toMatchObject({ resolved: 1144, unchanged: 1144, facetsWritten: 1, importNumber: 3 });
    expect(await feedCount(a.userId)).toBe(before + 1);
  });
});

describe('the export, read by header', () => {
  it('refuses an export without an ID or a Status column, naming the column, and writes nothing', async () => {
    const a = await SyncCaller.enrol(h);
    const noId = failed(await a.importMfcExport({ csvText: '"Title","Status"\r\n"x","Owned"\r\n', exportDate: EXPORT_DATE }));
    expect(noId.code).toBe('invalid_argument');
    expect(noId.message).toMatch(/"ID"/);
    const noStatus = failed(await a.importMfcExport({ csvText: 'ID;Title\n1;x\n', exportDate: EXPORT_DATE }));
    expect(noStatus.code).toBe('invalid_argument');
    expect(noStatus.message).toMatch(/"Status"/);
    expect(await feedCount(a.userId)).toBe(0);
    expect(await runs(a.userId)).toBe(0);
  });

  it('refuses a malformed cell, naming its line and column, and writes nothing', async () => {
    const a = await SyncCaller.enrol(h);
    const bad = failed(await a.importMfcExport({ csvText: 'ID,Status,Score\n1,Owned,7/10\n2,Owned,eleven\n', exportDate: EXPORT_DATE }));
    expect(bad.code).toBe('invalid_argument');
    expect(bad.message).toMatch(/line 3.*Score/);
    expect(await feedCount(a.userId)).toBe(0);
  });

  it('refuses csv_text over 2 MiB, counted in UTF-8 bytes, and an export_date that is not a date or is too late', async () => {
    const a = await SyncCaller.enrol(h);
    const big = `ID,Status,Note\n1,Owned,"${'é'.repeat(1_048_570)}"\n`; // fewer than 2 Mi characters, more than 2 MiB
    expect(big.length).toBeLessThan(2 * 1024 * 1024);
    expect(failed(await a.importMfcExport({ csvText: big, exportDate: EXPORT_DATE })).message).toMatch(/2 MiB/);
    const today = new Date();
    const day = (offset: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset)).toISOString().slice(0, 10);
    for (const exportDate of ['', '2026-9-9', '2026-02-30', '2026-13-01', '09/09/2026', day(2)]) {
      const err = failed(await a.importMfcExport({ csvText: 'ID,Status\n', exportDate }));
      expect([exportDate, err.code]).toEqual([exportDate, 'invalid_argument']);
      expect(err.message).toMatch(/export_date/);
    }
    // MFC's zone may run a day ahead of UTC.
    expect(ok(await a.importMfcExport({ csvText: 'ID,Status\n', exportDate: day(1) })).importNumber).toBe(1);
    expect(await feedCount(a.userId)).toBe(1);
  });
});

describe('unresolved rows', () => {
  it('are listed with their reason, line, id and status as the export has them, and nothing is written for them', async () => {
    const a = await SyncCaller.enrol(h);
    const [known, gone, countX, over] = [nextId(), nextId(), nextId(), nextId()];
    unknown.add(gone);
    const csv = ['ID,Status,Count', `${known},Owned,1`, `${gone},Wished,1`, '0,Owned,1', `0${known},Ordered,1`, `${countX},Owned,x`, `${over},Owned,100`].join('\n');
    const res = ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE }));
    expect(res.resolved).toBe(1);
    expect(res.unresolved.map((u) => ({ mfcId: u.mfcId, status: u.status, line: u.line, reason: u.reason }))).toEqual([
      { mfcId: gone, status: 'Wished', line: 3, reason: 'no_product' },
      { mfcId: '0', status: 'Owned', line: 4, reason: 'invalid_id' },
      { mfcId: `0${known}`, status: 'Ordered', line: 5, reason: 'duplicate_id' },
      { mfcId: countX, status: 'Owned', line: 6, reason: 'invalid_count' },
      { mfcId: over, status: 'Owned', line: 7, reason: 'count_over_99' },
    ]);
    expect(res.unresolved).toHaveLength(5);
    expect(res.occurrencesAdded).toBe(1);
    const state = replica((await drain(a)).events);
    const natives = [...state].filter(([k]) => k.endsWith('/origin')).map(([, v]) => (v as { native_id: string }).native_id);
    expect(natives).toEqual([known]);
    // Only the rows that could be written were asked about; invalid ones never reach the spine.
    const asked = spine.productCalls.at(-1)!.request.refs.map((r) => (r.ref.case === 'sourceItem' ? r.ref.value.nativeId : ''));
    expect(asked).toEqual([known, gone]);
    // The same export again, its unresolved rows included, writes only its marker.
    expect(ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE }))).toMatchObject({ facetsWritten: 1, unchanged: 1, unresolved: res.unresolved });
  });
});

describe("the app's side (GR-Q1: an import surfaces a conflict and never writes over a device decision)", () => {
  it('keeps a device edit made after the export date, raises one conflict for it, and writes nothing to that figure', async () => {
    const a = await SyncCaller.enrol(h);
    const [scored, filed, fresh] = [nextId(), nextId(), nextId()];
    const appCopy = randomUUID();
    const version = (n: number) => canonicalVersion({ instant: new Date(Date.now() - 1000), counter: n, deviceId: a.deviceId });
    const push = ok(
      await a.push({
        clientId: randomUUID(),
        events: [
          { facetKey: `uf/${headFor(scored)}/score`, version: version(1), op: SyncOp.UPSERT, payload: JSON.stringify({ score: 9, ...DISPLAY }), basis: '' },
          { facetKey: `occ/${appCopy}/head`, version: version(2), op: SyncOp.UPSERT, payload: JSON.stringify({ head_id: headFor(filed), ...DISPLAY }), basis: '' },
          { facetKey: `occ/${appCopy}/status`, version: version(3), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'owned', ...DISPLAY }), basis: '' },
        ],
      }),
    );
    expect(push.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.APPLIED, PushOutcome.APPLIED]);

    const csv = mfcCsv([row(scored, 'Owned', { score: '7/10' }), row(filed, 'Owned'), row(fresh, 'Wished', { wishability: '3' })]);
    const res = ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE }));
    expect(res).toMatchObject({ resolved: 3, added: 3, keptNewer: 0, occurrencesAdded: 1, conflictsRaised: 1, conflictsPending: 1, applied: [] });

    const state = replica((await drain(a)).events);
    expect(state.get(`uf/${headFor(scored)}/score`)).toMatchObject({ score: 9 });
    const copies = liveCopies(state);
    // The conflicted figure got none of its copies; the filed copy was MFC's one; the new figure got its own.
    expect([...copies.values()].filter((c) => c.head === headFor(scored))).toHaveLength(0);
    expect([...copies.entries()].filter(([, c]) => c.head === headFor(filed)).map(([o]) => o)).toEqual([appCopy]);
    expect([...copies.values()].filter((c) => c.head === headFor(fresh))).toEqual([{ head: headFor(fresh), status: 'wished' }]);

    expect(res.review).toHaveLength(1);
    const [group] = res.review;
    expect(group!.kind).toBe(ImportReviewKind.CONFLICT);
    expect(group!.bulk).toEqual([ImportAnswer.KEEP, ImportAnswer.TAKE]);
    expect(group!.items).toHaveLength(1);
    const item = group!.items[0]!;
    expect(item.facetKey).toBe(`imp/mfc/figure/${headFor(scored)}`);
    expect(item.headId).toBe(headFor(scored));
    expect(item.answers).toEqual([ImportAnswer.KEEP, ImportAnswer.TAKE, ImportAnswer.PER_COPY]);
    const payload = JSON.parse(item.payload) as { rev: string; fields: { score: object } };
    expect(figureSchema(payload)).toBe(true);
    expect(payload.rev).toBe(item.rev);
    expect(payload.fields.score).toEqual({ status: 'conflict', app: 9, mfc: 7 });
    expect(state.get(item.facetKey)).toEqual(payload);

    // A re-import finds the same conflict: the rev stands, nothing but the marker is written.
    const before = await feedCount(a.userId);
    const again = ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE }));
    expect(again).toMatchObject({ facetsWritten: 1, conflictsRaised: 0, conflictsPending: 1, added: 1, unchanged: 2 });
    expect(again.review[0]!.items[0]!.rev).toBe(item.rev);
    expect(await feedCount(a.userId)).toBe(before + 1);
  });

  it('ends the conflict when a later import finds the app agreeing, and settles the figure then', async () => {
    const a = await SyncCaller.enrol(h);
    const scored = nextId();
    const version = (n: number) => canonicalVersion({ instant: new Date(Date.now() - 1000), counter: n, deviceId: a.deviceId });
    const score = (n: number, v: string) => ({ facetKey: `uf/${headFor(scored)}/score`, version: v, op: SyncOp.UPSERT, payload: JSON.stringify({ score: n, ...DISPLAY }), basis: '' });
    ok(await a.push({ clientId: randomUUID(), events: [score(9, version(1))] }));
    const csv = mfcCsv([row(scored, 'Owned', { score: '7/10' })]);
    expect(ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE })).conflictsPending).toBe(1);
    const { cursor } = await drain(a);

    // The user takes MFC's score by hand, knowing the import; the next import finds the sides agreeing.
    const knowing = canonicalVersion({ instant: new Date(Date.now() + 2000), counter: 1, deviceId: a.deviceId });
    expect(ok(await a.push({ clientId: randomUUID(), events: [{ ...score(7, knowing), basis: cursor }] })).results[0]!.outcome).toBe(PushOutcome.APPLIED);
    const settled = ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE }));
    expect(settled).toMatchObject({ conflictsPending: 0, conflictsRaised: 0, occurrencesAdded: 1, review: [] });
    const { events } = await drain(a, cursor);
    expect(events.map((e) => [e.facetKey.replace(/^occ\/[^/]+/, 'occ'), e.op])).toEqual([
      [`uf/${headFor(scored)}/score`, SyncOp.UPSERT],
      [`imp/mfc/figure/${headFor(scored)}`, SyncOp.DELETE],
      ['occ/origin', SyncOp.UPSERT],
      ['occ/head', SyncOp.UPSERT],
      ['occ/status', SyncOp.UPSERT],
      ['imp/mfc/import', SyncOp.UPSERT],
    ]);
    const { rows } = await db.admin.query('SELECT 1 FROM import_figure_item WHERE user_id = $1', [a.userId]);
    expect(rows).toHaveLength(0);
    // Settled now: the same export again writes only its marker.
    expect(ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE })).facetsWritten).toBe(1);
  });

  it('writes over a value the app removed even at a version ahead of the server clock, minting above it', async () => {
    const a = await SyncCaller.enrol(h);
    const noted = nextId();
    const ahead = canonicalVersion({ instant: new Date(Date.now() + 4 * 60_000), counter: 3, deviceId: a.deviceId });
    const key = `uf/${headFor(noted)}/note`;
    ok(await a.push({ clientId: randomUUID(), events: [{ facetKey: key, version: ahead, op: SyncOp.DELETE, payload: '', basis: '' }] }));
    ok(await a.importMfcExport({ csvText: mfcCsv([row(noted, 'Wished', { note: 'from MFC' })]), exportDate: EXPORT_DATE }));
    const written = (await drain(a)).events.filter((e) => e.facetKey === key).at(-1)!;
    expect(written).toMatchObject({ op: SyncOp.UPSERT, payload: JSON.stringify({ note: 'from MFC', edited_at: `${EXPORT_DATE}T00:00:00Z`, tz: 'UTC' }) });
    expect(written.version > ahead).toBe(true);
    expect(written.version.endsWith('#00000000000000000000000000000000')).toBe(true);
  });

  it('refuses, writing nothing, an import whose conflict a FAVOR preference would settle (WK-14b)', async () => {
    const a = await SyncCaller.enrol(h);
    const scored = nextId();
    const version = (n: number) => canonicalVersion({ instant: new Date(Date.now() - 1000), counter: n, deviceId: a.deviceId });
    ok(
      await a.push({
        clientId: randomUUID(),
        events: [
          { facetKey: 'pref/mfc/import', version: version(1), op: SyncOp.UPSERT, payload: JSON.stringify({ import_policy: 'FAVOR_APP', ...DISPLAY }), basis: '' },
          { facetKey: `uf/${headFor(scored)}/score`, version: version(2), op: SyncOp.UPSERT, payload: JSON.stringify({ score: 9, ...DISPLAY }), basis: '' },
        ],
      }),
    );
    const before = await feedCount(a.userId);
    const conflict = failed(await a.importMfcExport({ csvText: mfcCsv([row(scored, 'Owned', { score: '7/10' })]), exportDate: EXPORT_DATE }));
    expect(conflict.code).toBe('failed_precondition');
    expect(conflict.message).toMatch(/FAVOR_APP/);
    expect(await feedCount(a.userId)).toBe(before);
    // With nothing to settle, the preference changes nothing.
    expect(ok(await a.importMfcExport({ csvText: mfcCsv([row(scored, 'Owned', { score: '9/10' })]), exportDate: EXPORT_DATE })).occurrencesAdded).toBe(1);
  });
});

describe('a late edit: made before an import it had not seen, replayed just before it', () => {
  it('answers STALE a late edit to a facet the import wrote, and applies one the import leaves standing, a knowing one and one to a figure it never framed', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const [x, y, outside] = [nextId(), nextId(), nextId()];
    const res = ok(await a.importMfcExport({ csvText: mfcCsv([row(x, 'Owned'), row(y, 'Wished')]), exportDate: EXPORT_DATE }));
    expect(res.occurrencesAdded).toBe(2);
    const { cursor } = await drain(a);
    const copyX = importOccId(KEY, a.userId, x, 1);
    // Above the import's own versions, so LWW alone would apply every one of these.
    const version = (n: number) => canonicalVersion({ instant: new Date(Date.now() + 2000), counter: n, deviceId: b.deviceId });
    const newCopy = randomUUID();

    // b made these before it had pulled the import: basis ''.
    const late = ok(
      await b.push({
        clientId: randomUUID(),
        events: [
          { facetKey: `occ/${copyX}/status`, version: version(1), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'former', ...DISPLAY }), basis: '' },
          { facetKey: `uf/${headFor(y)}/note`, version: version(2), op: SyncOp.UPSERT, payload: JSON.stringify({ note: 'mine', ...DISPLAY }), basis: '' },
          { facetKey: `occ/${newCopy}/head`, version: version(3), op: SyncOp.UPSERT, payload: JSON.stringify({ head_id: headFor(y), ...DISPLAY }), basis: '' },
          { facetKey: `occ/${newCopy}/status`, version: version(4), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'owned', ...DISPLAY }), basis: cursor },
          { facetKey: `uf/${headFor(outside)}/note`, version: version(5), op: SyncOp.UPSERT, payload: JSON.stringify({ note: 'n', ...DISPLAY }), basis: '' },
        ],
      }),
    );
    // Replayed before the import, the copy's status is the import's to write (it created the copy):
    // STALE with the import's value. The import decides y the same with or without the note and the
    // new copy (MFC's wish is no owned copy), so those stand.
    expect(late.results.map((r) => r.outcome)).toEqual([PushOutcome.STALE, PushOutcome.APPLIED, PushOutcome.APPLIED, PushOutcome.APPLIED, PushOutcome.APPLIED]);
    expect(late.results[0]!.current).toMatchObject({ facetKey: `occ/${copyX}/status`, payload: JSON.stringify({ status: 'owned', edited_at: `${EXPORT_DATE}T00:00:00Z`, tz: 'UTC' }) });
    expect((await db.admin.query('SELECT 1 FROM held_edit WHERE user_id = $1', [a.userId])).rows).toHaveLength(0);
    // Each late edit replayed and APPLIED is kept under the import it is late for, so a later replay
    // places it there again. The STALE one is not kept: a STALE answer is final.
    const { rows } = await db.admin.query<{ facet_key: string; import_number: number }>(
      'SELECT facet_key, import_number FROM import_late_edit WHERE user_id = $1 ORDER BY facet_key',
      [a.userId],
    );
    expect(rows.map((r) => [r.facet_key, r.import_number])).toEqual([`occ/${newCopy}/head`, `uf/${headFor(y)}/note`].sort().map((k) => [k, 1]));

    // A tag on an imported copy is its own unit, late, and left standing; a copy with no head
    // anywhere and a collection name belong to no figure.
    const other = randomUUID();
    const tagged = ok(
      await b.push({
        clientId: randomUUID(),
        events: [
          { facetKey: `occ/${copyX}/tag/${randomUUID()}`, version: version(7), op: SyncOp.UPSERT, payload: JSON.stringify(DISPLAY), basis: '' },
          { facetKey: `occ/${randomUUID()}/status`, version: version(8), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'owned', ...DISPLAY }), basis: '' },
          { facetKey: 'coll/owned/default/name', version: version(9), op: SyncOp.UPSERT, payload: JSON.stringify({ name: 'Shelf', ...DISPLAY }), basis: '' },
        ],
      }),
    );
    expect(tagged.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.APPLIED, PushOutcome.APPLIED]);
    // A late owned copy on x, which MFC counts once: placed before the import it pairs with MFC's
    // copy, and the import would not have created one. A revision: the created copy is withdrawn.
    const added = ok(
      await b.push({
        clientId: randomUUID(),
        events: [
          { facetKey: `occ/${other}/head`, version: version(10), op: SyncOp.UPSERT, payload: JSON.stringify({ head_id: headFor(x), ...DISPLAY }), basis: '' },
          { facetKey: `occ/${other}/status`, version: version(11), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'owned', ...DISPLAY }), basis: '' },
        ],
      }),
    );
    expect(added.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.APPLIED]);
    const copies = liveCopies(replica((await drain(a)).events));
    expect([copies.has(copyX), copies.get(other)]).toEqual([false, { head: headFor(x), status: 'owned' }]);

    // Made after the import but before that revision, unseen: an edit to the copy it took out reacts to it (HELD (ii)).
    const reacting = ok(
      await b.push({
        clientId: randomUUID(),
        events: [{ facetKey: `occ/${copyX}/status`, version: version(12), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'wished', ...DISPLAY }), basis: cursor }],
      }),
    );
    expect(reacting.results[0]!.outcome).toBe(PushOutcome.HELD);
    // Made after pulling the revision: knowing, applied by LWW.
    const { cursor: now } = await drain(b);
    const knowing = ok(
      await b.push({
        clientId: randomUUID(),
        events: [{ facetKey: `occ/${other}/status`, version: version(13), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'former', ...DISPLAY }), basis: now }],
      }),
    );
    expect(knowing.results[0]!.outcome).toBe(PushOutcome.APPLIED);
  });
});

describe('a late edit, across two imports', () => {
  it('applies an edit made after one import to a figure only that import decided, and a late one the later import decides the same either way', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const [x, y] = [nextId(), nextId()];
    const early = (n: number) => canonicalVersion({ instant: new Date(Date.now() - 1000), counter: n, deviceId: a.deviceId });
    ok(await a.push({ clientId: randomUUID(), events: [{ facetKey: `uf/${headFor(x)}/score`, version: early(1), op: SyncOp.UPSERT, payload: JSON.stringify({ score: 9, ...DISPLAY }), basis: '' }] }));
    // Import 1 decides x (a conflict: no base is set, so import 2 does not decide it again); import 2 decides only y.
    expect(ok(await a.importMfcExport({ csvText: mfcCsv([row(x, 'Owned', { score: '7/10' })]), exportDate: EXPORT_DATE })).conflictsRaised).toBe(1);
    const { cursor: afterFirst } = await drain(b);
    ok(await a.importMfcExport({ csvText: mfcCsv([row(y, 'Owned')]), exportDate: EXPORT_DATE }));
    const later = canonicalVersion({ instant: new Date(Date.now() + 2000), counter: 1, deviceId: b.deviceId });
    const res = ok(
      await b.push({
        clientId: randomUUID(),
        events: [
          { facetKey: `uf/${headFor(x)}/score`, version: later, op: SyncOp.UPSERT, payload: JSON.stringify({ score: 8, ...DISPLAY }), basis: afterFirst },
          { facetKey: `uf/${headFor(y)}/note`, version: later, op: SyncOp.UPSERT, payload: JSON.stringify({ note: 'n', ...DISPLAY }), basis: afterFirst },
        ],
      }),
    );
    expect(res.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.APPLIED]);
  });
});

describe('a late edit is late only for a figure an import settled (wrote to or moved a base of)', () => {
  const at = (device: string, n: number, offsetMs: number) => canonicalVersion({ instant: new Date(Date.now() + offsetMs), counter: n, deviceId: device });
  const score = (head: string, n: number, version: string, basis: string) => ({
    facetKey: `uf/${head}/score`,
    version,
    op: SyncOp.UPSERT,
    payload: JSON.stringify({ score: n, ...DISPLAY }),
    basis,
  });
  const frames = async (userId: string) =>
    (
      await db.admin.query<{ import_number: number; settled: boolean }>(
        'SELECT import_number, settled FROM import_frame WHERE user_id = $1 ORDER BY import_number',
        [userId],
      )
    ).rows.map((r) => [r.import_number, r.settled]);

  it('applies an edit made after the first import though a marker-only re-import ran before it arrived', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const x = nextId();
    const csv = mfcCsv([row(x, 'Owned', { score: '7/10' })]);
    ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE }));
    const { cursor: bSaw } = await drain(b);
    expect(ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE })).facetsWritten).toBe(1);
    // Both imports frame the figure; only the first wrote to it.
    expect(await frames(a.userId)).toEqual([
      [1, true],
      [2, false],
    ]);
    const res = ok(await b.push({ clientId: randomUUID(), events: [score(headFor(x), 9, at(b.deviceId, 1, 2000), bSaw)] }));
    expect(res.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    expect(replica((await drain(a)).events).get(`uf/${headFor(x)}/score`)).toMatchObject({ score: 9 });
  });

  it('applies a late edit to a figure the import only raised a conflict on; one late for a later import that settled it is replayed, and raises again the conflict that import ended', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const x = nextId();
    const S = headFor(x);
    ok(await a.push({ clientId: randomUUID(), events: [score(S, 9, at(a.deviceId, 1, -1000), '')] }));
    const csv = mfcCsv([row(x, 'Owned', { score: '7/10' })]);
    expect(ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE })).conflictsRaised).toBe(1);
    // b had not seen the import: late for it, but the import wrote nothing of the figure.
    const conflicted = ok(await b.push({ clientId: randomUUID(), events: [score(S, 7, at(b.deviceId, 1, 1000), '')] }));
    expect(conflicted.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    const { cursor: bSaw } = await drain(b);

    // Import 2 finds the sides agreeing and settles the figure: framed twice, settled once.
    expect(ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE })).occurrencesAdded).toBe(1);
    expect(await frames(a.userId)).toEqual([
      [1, false],
      [2, true],
    ]);
    const late = ok(await b.push({ clientId: randomUUID(), events: [score(S, 8, at(b.deviceId, 2, 2000), bSaw)] }));
    expect(late.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    // Placed before import 2, the app's 8 meets MFC's 7: a conflict, so import 2 writes nothing of
    // the figure. The item it ended is pending again, and the copy it made is withdrawn.
    const state = replica((await drain(a)).events);
    expect(state.get(`uf/${S}/score`)).toMatchObject({ score: 8 });
    expect(state.get(`imp/mfc/figure/${S}`)).toMatchObject({ kind: 'conflict' });
    expect([...liveCopies(state).values()].filter((c) => c.head === S)).toEqual([]);
    expect((await b.status().then(ok)).pendingReview).toBe(1n);
    const { cursor: bNow } = await drain(b);
    const knowing = ok(await b.push({ clientId: randomUUID(), events: [score(S, 8, at(b.deviceId, 3, 3000), bNow)] }));
    expect(knowing.results[0]!.outcome).toBe(PushOutcome.APPLIED);
  });

  it('replays a late move of a copy out of a settled figure, one back into it and a tombstone of its head, each against the figure as the import found it', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const [x, t] = [nextId(), nextId()];
    const c = randomUUID();
    const head = (to: string, version: string) => ({ facetKey: `occ/${c}/head`, version, op: SyncOp.UPSERT, payload: JSON.stringify({ head_id: to, ...DISPLAY }), basis: '' });
    ok(
      await a.push({
        clientId: randomUUID(),
        events: [
          head(headFor(x), at(a.deviceId, 1, -1000)),
          { facetKey: `occ/${c}/status`, version: at(a.deviceId, 2, -1000), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'owned', ...DISPLAY }), basis: '' },
        ],
      }),
    );
    // The app's copy is MFC's one: the import pairs it and writes nothing.
    expect(ok(await a.importMfcExport({ csvText: mfcCsv([row(x, 'Owned')]), exportDate: EXPORT_DATE })).occurrencesAdded).toBe(0);
    const cx = importOccId(KEY, a.userId, x, 1);
    const onX = async () =>
      [...liveCopies(replica((await drain(a)).events)).entries()]
        .filter(([, v]) => v.head === headFor(x))
        .map(([occ]) => (occ === cx ? 'mfc' : occ === c ? 'hand' : occ))
        .sort();
    expect(await onX()).toEqual(['hand']);
    // Moved out before the import: the import finds no copy of x and makes MFC's.
    const out = ok(await b.push({ clientId: randomUUID(), events: [head(headFor(t), at(b.deviceId, 1, 2000))] }));
    expect(out.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    expect(await onX()).toEqual(['mfc']);
    // Moved back, also before the import: by LWW the copy is on x again, the import pairs it, and MFC's copy is withdrawn.
    const back = ok(await b.push({ clientId: randomUUID(), events: [head(headFor(x), at(b.deviceId, 2, 3000))] }));
    expect(back.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    expect(await onX()).toEqual(['hand']);
    // A late tombstone of the head takes the copy out of every figure: MFC's copy is made again, under the same id.
    const removed = ok(await b.push({ clientId: randomUUID(), events: [{ facetKey: `occ/${c}/head`, version: at(b.deviceId, 3, 4000), op: SyncOp.DELETE, payload: '', basis: '' }] }));
    expect(removed.results[0]!.outcome).toBe(PushOutcome.APPLIED);
    expect(await onX()).toEqual(['mfc']);
    expect((await a.status().then(ok)).pendingReview).toBe(0n);
  });

  it('places by LWW a late edit to a copy whose head was tombstoned: it belongs to no figure', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const x = nextId();
    const c = randomUUID();
    ok(
      await a.push({
        clientId: randomUUID(),
        events: [
          { facetKey: `occ/${c}/head`, version: at(a.deviceId, 1, -1000), op: SyncOp.UPSERT, payload: JSON.stringify({ head_id: headFor(x), ...DISPLAY }), basis: '' },
          { facetKey: `occ/${c}/status`, version: at(a.deviceId, 2, -1000), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'owned', ...DISPLAY }), basis: '' },
        ],
      }),
    );
    ok(await a.push({ clientId: randomUUID(), events: [{ facetKey: `occ/${c}/head`, version: at(a.deviceId, 3, -500), op: SyncOp.DELETE, payload: '', basis: '' }] }));
    ok(await a.importMfcExport({ csvText: mfcCsv([row(x, 'Wished')]), exportDate: EXPORT_DATE }));
    const res = ok(
      await b.push({
        clientId: randomUUID(),
        events: [{ facetKey: `occ/${c}/status`, version: at(b.deviceId, 1, 2000), op: SyncOp.UPSERT, payload: JSON.stringify({ status: 'wished', ...DISPLAY }), basis: '' }],
      }),
    );
    expect(res.results[0]!.outcome).toBe(PushOutcome.APPLIED);
  });
});

describe('the pending count and the spine', () => {
  it("counts an earlier import's item still pending beside this import's", async () => {
    const a = await SyncCaller.enrol(h);
    const [x, y] = [nextId(), nextId()];
    ok(
      await a.push({
        clientId: randomUUID(),
        events: [{ facetKey: `uf/${headFor(x)}/score`, version: canonicalVersion({ instant: new Date(Date.now() - 1000), counter: 1, deviceId: a.deviceId }), op: SyncOp.UPSERT, payload: JSON.stringify({ score: 9, ...DISPLAY }), basis: '' }],
      }),
    );
    const first = ok(await a.importMfcExport({ csvText: mfcCsv([row(x, 'Owned', { score: '7/10' })]), exportDate: EXPORT_DATE }));
    const second = ok(await a.importMfcExport({ csvText: mfcCsv([row(y, 'Owned')]), exportDate: EXPORT_DATE }));
    expect(second).toMatchObject({ conflictsRaised: 0, conflictsPending: 1 });
    expect(second.review[0]!.items.map((i) => [i.headId, i.rev])).toEqual([[headFor(x), first.review[0]!.items[0]!.rev]]);
  });

  it('counts no item whose answer has synced: the same export raises and lists nothing, a new MFC value raises again', async () => {
    const a = await SyncCaller.enrol(h);
    const [x, y] = [nextId(), nextId()];
    const before = (n: number) => canonicalVersion({ instant: new Date(Date.now() - 1000), counter: n, deviceId: a.deviceId });
    const note = (id: string, n: number) => ({ facetKey: `uf/${headFor(id)}/note`, version: before(n), op: SyncOp.UPSERT, payload: JSON.stringify({ note: 'app: boxed', ...DISPLAY }), basis: '' });
    ok(await a.push({ clientId: randomUUID(), events: [note(x, 1), note(y, 2)] }));
    const csv = (n: string) => mfcCsv([row(x, 'Owned', { note: n })]);

    const first = ok(await a.importMfcExport({ csvText: csv('mfc: loose'), exportDate: EXPORT_DATE }));
    expect(first).toMatchObject({ conflictsRaised: 1, conflictsPending: 1 });
    const rev = first.review[0]!.items[0]!.rev;
    const { cursor } = await drain(a);

    // The client answers the figure item, and the answer syncs.
    const answer = { facetKey: `res/mfc/${headFor(x)}`, version: canonicalVersion({ instant: new Date(), counter: 3, deviceId: a.deviceId }), op: SyncOp.UPSERT, payload: JSON.stringify({ item: 'figure', rev, choice: 'keep', ...DISPLAY }), basis: cursor };
    expect(ok(await a.push({ clientId: randomUUID(), events: [answer] })).results[0]!.outcome).toBe(PushOutcome.APPLIED);

    const again = ok(await a.importMfcExport({ csvText: csv('mfc: loose'), exportDate: EXPORT_DATE }));
    expect(again).toMatchObject({ conflictsRaised: 0, conflictsPending: 0, review: [] });

    // Another export changes only y: x, settled by its answer, raises nothing.
    const other = ok(await a.importMfcExport({ csvText: mfcCsv([row(x, 'Owned', { note: 'mfc: loose' }), row(y, 'Owned', { note: 'mfc: loose' })]), exportDate: EXPORT_DATE }));
    expect(other).toMatchObject({ conflictsRaised: 1, conflictsPending: 1 });
    expect(other.review[0]!.items.map((i) => i.headId)).toEqual([headFor(y)]);

    // A new MFC value on x is a new rev, which the answer does not name: raised and pending again.
    const changed = ok(await a.importMfcExport({ csvText: csv('mfc: repainted'), exportDate: EXPORT_DATE }));
    expect(changed).toMatchObject({ conflictsRaised: 1, conflictsPending: 2 });
    const relisted = changed.review[0]!.items.find((i) => i.headId === headFor(x))!;
    expect(relisted.rev).not.toBe(rev);
  });

  it('counts no item answered take or per_copy either, and the old answer does not cover a new MFC value', async () => {
    const a = await SyncCaller.enrol(h);
    const s = await SyncCaller.sibling(h, a);
    const [x, y, z] = [nextId(), nextId(), nextId()];
    let n = 10;
    const version = (c: SyncCaller) => canonicalVersion({ instant: new Date(), counter: (n += 1), deviceId: c.deviceId });
    const before = (i: number) => canonicalVersion({ instant: new Date(Date.now() - 1000), counter: i, deviceId: a.deviceId });
    const note = (id: string, i: number) => ({ facetKey: `uf/${headFor(id)}/note`, version: before(i), op: SyncOp.UPSERT, payload: JSON.stringify({ note: 'app: boxed', ...DISPLAY }), basis: '' });
    ok(await a.push({ clientId: randomUUID(), events: [note(x, 1), note(y, 2), note(z, 3)] }));
    const csv = (value: string) => mfcCsv([x, y, z].map((id) => row(id, 'Owned', { note: value })));

    const first = ok(await a.importMfcExport({ csvText: csv('mfc: loose'), exportDate: EXPORT_DATE }));
    expect(first).toMatchObject({ conflictsRaised: 3, conflictsPending: 3 });
    const revOf = (r: ImportMfcExportResponse, id: string) => r.review.flatMap((g) => g.items).find((i) => i.headId === headFor(id))!.rev;
    const { cursor } = await drain(s);

    // x is answered take, y per_copy, from another device of the user; z is answered keep, then MFC changes and changes back.
    const answer = (c: SyncCaller, id: string, body: object) => ({ facetKey: `res/mfc/${headFor(id)}`, version: version(c), op: SyncOp.UPSERT, payload: JSON.stringify({ ...body, ...DISPLAY }), basis: cursor });
    const pushed = ok(
      await s.push({
        clientId: randomUUID(),
        events: [
          answer(s, x, { item: 'figure', rev: revOf(first, x), choice: 'take' }),
          answer(s, y, { item: 'figure', rev: revOf(first, y), choice: 'per_copy', copies: [] }),
          answer(s, z, { item: 'figure', rev: revOf(first, z), choice: 'keep' }),
        ],
      }),
    );
    expect(pushed.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.APPLIED, PushOutcome.APPLIED]);

    const again = ok(await a.importMfcExport({ csvText: csv('mfc: loose'), exportDate: EXPORT_DATE }));
    expect(again).toMatchObject({ conflictsRaised: 0, conflictsPending: 0, review: [] });

    // The keep settled z at MFC's note: MFC changing it again is a new conflict, with a new rev the
    // old answer does not name; MFC going back to the note it was settled at ends that item.
    const changed = ok(await a.importMfcExport({ csvText: mfcCsv([x, y].map((id) => row(id, 'Owned', { note: 'mfc: loose' })).concat(row(z, 'Owned', { note: 'mfc: repainted' }))), exportDate: EXPORT_DATE }));
    expect(changed).toMatchObject({ conflictsRaised: 1, conflictsPending: 1 });
    expect(revOf(changed, z)).not.toBe(revOf(first, z));
    const back = ok(await a.importMfcExport({ csvText: csv('mfc: loose'), exportDate: EXPORT_DATE }));
    expect(back).toMatchObject({ conflictsRaised: 0, conflictsPending: 0, review: [] });
  });

  it('imports a header-only export with no spine configured, and answers UNAVAILABLE once there are ids to resolve', async () => {
    const bare = await startSyncApp(db.app, h.issuer, undefined, undefined, { import: { db: db.app, spineRead: null, occIdKey: KEY } });
    try {
      const a = await SyncCaller.enrol(bare);
      expect(ok(await a.importMfcExport({ csvText: 'ID,Status\n', exportDate: EXPORT_DATE })).importNumber).toBe(1);
      expect(failed(await a.importMfcExport({ csvText: mfcCsv([row(nextId(), 'Owned')]), exportDate: EXPORT_DATE })).code).toBe('unavailable');
    } finally {
      await bare.close();
    }
  });
});

describe('failure, lock and configuration', () => {
  it('answers UNAVAILABLE and writes nothing while the spine is down; a retry then imports', async () => {
    const a = await SyncCaller.enrol(h);
    const csv = mfcCsv([row(nextId(), 'Owned')]);
    spineDown = true;
    try {
      expect(failed(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE })).code).toBe('unavailable');
    } finally {
      spineDown = false;
    }
    expect(await feedCount(a.userId)).toBe(0);
    expect(await runs(a.userId)).toBe(0);
    expect(ok(await a.importMfcExport({ csvText: csv, exportDate: EXPORT_DATE })).importNumber).toBe(1);
  });

  it("waits on the user's lock, the one every Push takes, and answers UNAVAILABLE past its bound", async () => {
    const a = await SyncCaller.enrol(h);
    const holder = await db.admin.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1, hashtext($2))', [0x73796e63, a.userId]);
      const err = failed(await a.importMfcExport({ csvText: mfcCsv([row(nextId(), 'Owned')]), exportDate: EXPORT_DATE }));
      expect(err.code).toBe('unavailable');
      expect(await feedCount(a.userId)).toBe(0);
    } finally {
      await holder.query('SELECT pg_advisory_unlock_all()');
      holder.release();
    }
  });

  it('imports an export that changes a figure an earlier import settled: the arrival is written and listed with its undo (WK-14b)', async () => {
    const a = await SyncCaller.enrol(h);
    const [p, q] = [nextId(), nextId()];
    ok(await a.importMfcExport({ csvText: mfcCsv([row(p, 'Ordered'), row(q, 'Wished')]), exportDate: EXPORT_DATE }));
    const before = await feedCount(a.userId);
    const res = ok(await a.importMfcExport({ csvText: mfcCsv([row(p, 'Owned'), row(q, 'Wished')]), exportDate: '2026-09-20' }));
    expect(res).toMatchObject({ moved: 1, unchanged: 1, occurrencesStatusChanged: 1, facetsWritten: 3 });
    expect(res.applied.map((i) => i.headId)).toEqual([headFor(p)]);
    expect(await feedCount(a.userId)).toBe(before + 3);
    expect(await runs(a.userId)).toBe(2);
  });

  it('answers UNAVAILABLE where no import key is configured', async () => {
    const bare = await startSyncApp(db.app, h.issuer);
    try {
      const a = await SyncCaller.enrol(bare);
      const err = failed(await a.importMfcExport({ csvText: 'ID,Status\n', exportDate: EXPORT_DATE }));
      expect(err.code).toBe('unavailable');
      expect(err.message).toMatch(/not configured/);
    } finally {
      await bare.close();
    }
  });

  it('is behind the edge: no credential, 401, and the spine is never asked', async () => {
    const calls = spine.productCalls.length;
    const res = await h.app.inject({
      method: 'POST',
      url: IMPORT_PATH,
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      payload: JSON.stringify({ csvText: 'ID,Status\n1,Owned\n', exportDate: EXPORT_DATE }),
    });
    expect(res.statusCode).toBe(401);
    expect(spine.productCalls.length).toBe(calls);
  });
});
