// PLAN GUARD (PLAN.md U12c): every statement the late-edit path, the import, answers, Push, Delta and
// Status send, captured as it reaches the driver with the values the code bound, explained on a
// database at growth shape, and held to its registry entry (test/plan-guard.registry.ts).
//
// Shape (PLAN.md U12 shared rules): postgres:17, migrated to head, the U5 planner costs
// (random_page_cost 1.1, effective_io_concurrency 200), 240 background users with a median of 125 MFC
// rows, and one WHALE at 32x the median user, made through the real app: two imports of 4,000 rows
// and device edits in between, plus 32x the median user's knowing keeps (filled directly: no scenario
// statement writes one, but two read them by figure). A 1x user runs the same scenario. feed_event and
// facet_state hold over 320k rows; a 1x user is under 1 % of either.
//
// The scenario reaches every late-edit statement with the code's own bounds: the frames (seq <=
// r.marker), facets before an import's start (seq < f.start), the revision path's edits since the
// marker including another device's TAG edit (occ/{occ}/tag/{tag}, which must HOLD), a late sale that
// revises, a conflict answered, a deep Delta and Status.
//
// It also proves the rewritten statements return IDENTICAL rows to the statements they replaced, on
// this data: the verbatim old SQL is kept below as the oracle.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from '@bufbuild/protobuf';
import { PushOutcome, SyncOp, canonicalVersion } from '@figurecollecting/fc-api-contract';
import { GetProductsResponseSchema } from '@figurecollecting/ingest-contract/read';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { editsSince, readFrames } from '../src/import/holds.js';
import { importOccId } from '../src/import/occ.js';
import { figureOccs } from '../src/import/store.js';
import { SpineReadClient } from '../src/spine/spineReadClient.js';
import { startFakeSpineRead, type FakeSpineRead } from './helpers/fakeSpineRead.js';
import { BIG_TABLES, judge, normalise, spyPool, type Captured, type GuardEntry, type Judged, type Queryable } from './helpers/planGuard.js';
import { DISPLAY, ok, startSyncApp, SyncCaller, type SyncApp } from './helpers/syncClient.js';
import { startSyncDatabase, SYNC_DB, type SyncDatabase } from './helpers/syncDatabase.js';
import { headFor, mfcCsv, type FixtureRow } from './import/fixture.js';
import { REGISTRY } from './plan-guard.registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const KEY = new Uint8Array(
  Buffer.from(
    (JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/golden/key-vectors.json'), 'utf8')) as { mfcImportOccTestKey: { hex: string } })
      .mfcImportOccTestKey.hex,
    'hex',
  ),
);

/** The whale's export: 32x the background median of 125 rows. */
const WHALE_ROWS = 4_000;
const ONE_X_ROWS = 125;

let db: SyncDatabase;
let spine: FakeSpineRead;
let h: SyncApp;
const captured: Captured[] = [];
let scope = 'setup';

const nextId = (() => {
  let n = 7_000_000;
  return () => String((n += 1));
})();
const row = (id: string, extra: Partial<FixtureRow> = {}): FixtureRow => ({ id, status: 'Owned', count: '1', score: '', wishability: '0', note: '', ...extra });

let counter = 0;
const later = (c: SyncCaller, ms = 60_000) => canonicalVersion({ instant: new Date(Date.now() + ms), counter: (counter += 1), deviceId: c.deviceId });
const edit = (c: SyncCaller, facetKey: string, body: object | null, basis: string, ms?: number) => ({
  facetKey,
  version: later(c, ms),
  op: body === null ? SyncOp.DELETE : SyncOp.UPSERT,
  payload: body === null ? '' : JSON.stringify({ ...body, ...DISPLAY }),
  basis,
});
const pushed = async (c: SyncCaller, events: ReturnType<typeof edit>[]) => ok(await c.push({ clientId: randomUUID(), events }));

async function drain(c: SyncCaller, cursor = ''): Promise<string> {
  for (;;) {
    const page = ok(await c.delta({ cursor, limit: 1000 }));
    cursor = page.nextCursor;
    if (!page.hasMore) return cursor;
  }
}

interface Run {
  userId: string;
  S1: string;
  S2: string;
  cx1: string;
  cx2: string;
  outcomes: string[];
  bSaw: string;
}

/**
 * One user's scenario: import, a device that saw it goes offline, a score edit, (padding), a
 * re-import that drops two rows and moves a score, another device's TAG edit to the first dropped
 * copy, the offline device's late sales of both dropped copies (the tagged one HELD, the other a
 * REVISION), the conflict answered, Status, and a Delta from the offline device's old cursor.
 */
async function scenario(label: string, rows: number, between?: (userId: string) => Promise<void>): Promise<Run> {
  scope = label;
  const a = await SyncCaller.enrol(h);
  const b = await SyncCaller.sibling(h, a);
  // c never syncs; d syncs after the re-import and edits a copy the revision then changes.
  const c = await SyncCaller.sibling(h, a);
  const d = await SyncCaller.sibling(h, a);
  const ids = Array.from({ length: rows }, () => nextId());
  const [x1, x2, x3] = ids as [string, string, string];
  const first = ids.map((id) => row(id, id === x3 ? { score: '7/10' } : {}));
  ok(await a.importMfcExport({ csvText: mfcCsv(first), exportDate: '2026-09-09' }));
  const aSaw1 = await drain(a);
  const bSaw = await drain(b);
  await pushed(a, [edit(a, `uf/${headFor(x3)}/score`, { score: 9 }, aSaw1, 1_000)]);
  if (between !== undefined) {
    scope = 'setup';
    await between(a.userId);
    scope = label;
  }
  const second = first.filter((r) => r.id !== x1 && r.id !== x2).map((r) => (r.id === x3 ? { ...r, score: '8/10' } : r));
  const re = ok(await a.importMfcExport({ csvText: mfcCsv(second), exportDate: '2026-09-20' }));
  expect(re.conflictsRaised).toBeGreaterThanOrEqual(1);
  const item = re.review[0]!.items[0]!;
  const aSaw2 = await drain(a);
  const [cx1, cx2] = [x1, x2].map((x) => importOccId(KEY, a.userId, x, 1)) as [string, string];
  expect(outcomes(await pushed(a, [edit(a, `occ/${cx1}/tag/${randomUUID()}`, {}, aSaw2, 1_000)]))).toEqual(['APPLIED']);
  const dSaw = await drain(d);
  const late = await pushed(b, [edit(b, `occ/${cx1}/status`, { status: 'former' }, bSaw), edit(b, `occ/${cx2}/status`, { status: 'former' }, bSaw)]);
  // HELD (ii)'s reads: an edit made after the re-import and before the revision, pushed after it.
  await pushed(d, [edit(d, `occ/${cx2}/status`, { status: 'ordered' }, dSaw)]);
  // A device that never pulled the first import: its edits are late for both, so the frames of
  // twenty figures are read with the first import's start (the whole import below its marker).
  await pushed(c, ids.slice(3, 23).map((x) => edit(c, `occ/${importOccId(KEY, a.userId, x, 1)}/status`, { status: 'former' }, '')));
  const seen = await drain(a);
  await pushed(a, [edit(a, `res/mfc/${headFor(x3)}`, { item: 'figure', rev: item.rev, choice: 'keep' }, seen, 1_000)]);
  ok(await a.status());
  ok(await b.delta({ cursor: bSaw, limit: 500 }));
  scope = 'setup';
  return { userId: a.userId, S1: headFor(x1), S2: headFor(x2), cx1, cx2, outcomes: outcomes(late), bSaw };
}
const outcomes = (res: { results: { outcome: PushOutcome }[] }) => res.results.map((r) => PushOutcome[r.outcome]);

let fillClient: pg.PoolClient | undefined;
let whale: Run;
let oneX: Run;

beforeAll(async () => {
  db = await startSyncDatabase();
  // The U5 planner costs, as the database will run them; new sessions pick them up.
  await db.admin.query(`ALTER DATABASE ${SYNC_DB} SET random_page_cost = 1.1`);
  await db.admin.query(`ALTER DATABASE ${SYNC_DB} SET effective_io_concurrency = 200`);
  spine = await startFakeSpineRead({
    keys: new Map(),
    respondProducts: ({ request }) => {
      const ids = request.refs.map((r) => (r.ref.case === 'sourceItem' ? r.ref.value.nativeId : ''));
      return create(GetProductsResponseSchema, {
        productsJson: JSON.stringify({ products: ids.map((id) => ({ productId: headFor(id), requestedAs: [{ sourceItem: { site: 'mfc', nativeId: id } }] })), unresolved: [], coverage: {} }),
        nextPageToken: '',
      });
    },
  });
  const spied = spyPool(db.app, (text, values) => captured.push({ scope, text, values }));
  h = await startSyncApp(spied, undefined, undefined, undefined, { import: { db: spied, spineRead: new SpineReadClient(spine.baseUrl), occIdKey: KEY } });

  // Part A and part B share temp tables: one session for both.
  fillClient = await db.admin.connect();
  await fillClient.query('SET statement_timeout = 0');
  await fillClient.query(readFileSync(path.join(HERE, 'fixtures', 'plan-guard-fill-a.sql'), 'utf8'));
  whale = await scenario('whale', WHALE_ROWS, async (userId) => {
    await fillClient!.query("SELECT set_config('pg.whale', $1, false)", [userId]);
    await fillClient!.query(readFileSync(path.join(HERE, 'fixtures', 'plan-guard-fill-b.sql'), 'utf8'));
    await fillClient!.query('ANALYZE');
  });
  oneX = await scenario('1x', ONE_X_ROWS);
  await db.admin.query('VACUUM ANALYZE');
}, 600_000);

afterAll(async () => {
  fillClient?.release();
  await h?.close();
  await spine?.close();
  await db?.close();
});

const count = async (sql: string, values: unknown[] = []) => Number((await db.admin.query<{ n: string }>(sql, values)).rows[0]!.n);

describe('plan guard: the shape it runs on', () => {
  it('is at growth shape: over 320k feed events and facets, a whale at about 32x the median user (its knowing keeps too), a 1x user under 1 %', async () => {
    const total = await count('SELECT count(*) AS n FROM feed_event');
    expect(total).toBeGreaterThan(320_000);
    expect(await count('SELECT count(*) AS n FROM facet_state')).toBeGreaterThan(320_000);
    const median = await count('SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n) AS n FROM (SELECT count(*) AS n FROM feed_event GROUP BY user_id) x');
    const w = await count('SELECT count(*) AS n FROM feed_event WHERE user_id = $1', [whale.userId]);
    const one = await count('SELECT count(*) AS n FROM feed_event WHERE user_id = $1', [oneX.userId]);
    expect(w / median).toBeGreaterThan(24);
    expect(w / median).toBeLessThan(40);
    expect(one / total).toBeLessThan(0.01);
    const keptMedian = await count('SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n) AS n FROM (SELECT count(*) AS n FROM import_kept_copy GROUP BY user_id) x');
    expect((await count('SELECT count(*) AS n FROM import_kept_copy WHERE user_id = $1', [whale.userId])) / keptMedian).toBeGreaterThan(24);
    for (const t of BIG_TABLES) expect(await count(`SELECT count(*) AS n FROM ${t}`), t).toBeGreaterThanOrEqual(5_000);
  });

  it('took the code paths it guards: the tagged late sale HELD, the untagged one a REVISION, at both scales', () => {
    expect(whale.outcomes).toEqual(['HELD', 'APPLIED']);
    expect(oneX.outcomes).toEqual(['HELD', 'APPLIED']);
  });
});

const entryFor = (text: string): GuardEntry[] => REGISTRY.filter((e) => e.match.test(normalise(text)));

/**
 * Per statement text and scope: the first and the last values it was sent with, and the widest (the
 * most array elements bound: a late push over twenty figures, say), each judged against its entry.
 */
async function judgeAll(on: Queryable): Promise<Judged[]> {
  const width = (c: Captured) => c.values.reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  const picked = new Map<string, Captured[]>();
  for (const c of captured) {
    if (c.scope === 'setup') continue;
    const k = `${c.scope}\n${normalise(c.text)}`;
    const seen = picked.get(k) ?? [];
    if (seen.length === 0) seen.push(c, c, c);
    seen[1] = c;
    if (width(c) > width(seen[2]!)) seen[2] = c;
    picked.set(k, seen);
  }
  const judged: Judged[] = [];
  for (const list of picked.values()) {
    for (const c of new Set(list)) {
      const entries = entryFor(c.text);
      if (entries.length !== 1 || entries[0]!.kind === 'control') continue;
      judged.push(await judge(on, entries[0]!, c));
    }
  }
  return judged;
}
const failingOf = (judged: Judged[]): Judged[] => judged.filter((j) => j.violations.length > 0 && REGISTRY.find((e) => e.id === j.entry)!.allow === undefined);

describe('plan guard: every statement the scenario sent', () => {
  it('is in the registry exactly once, and no allowance in it has expired', () => {
    const unregistered = new Set<string>();
    const ambiguous = new Set<string>();
    for (const c of captured) {
      const n = entryFor(c.text).length;
      if (n === 0) unregistered.add(normalise(c.text));
      if (n > 1) ambiguous.add(normalise(c.text));
    }
    expect([...unregistered], 'statements with no registry entry').toEqual([]);
    expect([...ambiguous], 'statements matching two entries').toEqual([]);
    const today = new Date().toISOString().slice(0, 10);
    expect(REGISTRY.filter((e) => e.allow !== undefined && e.allow.until < today).map((e) => e.id), 'expired allowances').toEqual([]);
  });

  it('reads no big table whole, walks no index unbounded, repeats no SubPlan over one, and stays inside its buffer bound', async () => {
    const judged = await judgeAll(db.admin);
    const report = process.env['PLAN_GUARD_REPORT'];
    if (report !== undefined) writeFileSync(report, JSON.stringify(judged, null, 1));
    const failing = failingOf(judged);
    expect(
      failing.map((j) => `${j.entry} [${j.scope}] ${j.violations.join('; ')}\n${j.plan}`),
      'statements over their bound',
    ).toEqual([]);
    expect(judged.length).toBeGreaterThan(20);
  });

  it('bites: without any one of the indexes 0009 builds, some statement breaks its bound', async () => {
    // Every index 0009 builds, read from the migration itself: a new one needs a statement here that needs it.
    const sql = readFileSync(path.join(HERE, '..', 'migrations', '0009_late_edit_indexes.sql'), 'utf8');
    const built = [...sql.matchAll(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS (\w+) ON/gm)].map((m) => m[1]!);
    expect(built).toHaveLength(7);
    // Only what breaks WITHOUT the index counts: a statement already over its bound bites nothing.
    const key = (j: Judged) => `${j.entry} [${j.scope}] ${j.text}`;
    const before = new Set(failingOf(await judgeAll(db.admin)).map(key));
    const client = await db.admin.connect();
    const failingWithout: Record<string, number> = {};
    try {
      for (const idx of built) {
        await client.query('BEGIN');
        try {
          await client.query(`DROP INDEX ${idx}`);
          failingWithout[idx] = failingOf(await judgeAll(client)).filter((j) => !before.has(key(j))).length;
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      client.release();
    }
    expect(Object.entries(failingWithout).filter(([, n]) => n === 0).map(([idx]) => idx), `indexes no statement needs (new failures without each: ${JSON.stringify(failingWithout)})`).toEqual([]);
  });
});

// ── identical rows: each rewritten statement against the verbatim statement it replaced ────────
const OLD_EDITS_SINCE = `SELECT facet_key, version FROM feed_event
      WHERE user_id = $1 AND seq > $2 AND (facet_key = ANY($3::text[]) OR (facet_key LIKE 'occ/%' AND split_part(facet_key, '/', 2) = ANY($4::text[])))`;
const OLD_FIGURE_OCCS = `SELECT split_part(facet_key, '/', 2) AS occ FROM facet_state
      WHERE user_id = $1 AND facet_key LIKE 'occ/%/head' AND (CASE WHEN op = 'upsert' THEN payload::jsonb ->> 'head_id' END) = $2
     UNION
     SELECT split_part(facet_key, '/', 2) FROM facet_state
      WHERE user_id = $1 AND facet_key LIKE 'occ/%/origin' AND (CASE WHEN op = 'upsert' THEN payload::jsonb ->> 'native_id' END) = ANY($3::text[])
     UNION
     SELECT occ_id::text FROM import_copy_base WHERE user_id = $1 AND head_id::text = $2`;
const OLD_READ_FRAMES = `SELECT f.head_id, f.import_number, to_char(r.export_date, 'YYYY-MM-DD') AS export_date, r.marker_seq AS marker, f.settled, f.before,
            (SELECT max(e.seq) FROM feed_event e WHERE e.user_id = r.user_id AND e.opens_txn AND e.seq <= r.marker_seq) AS start
       FROM import_frame f JOIN import_run r ON r.user_id = f.user_id AND r.import_number = f.import_number
      WHERE f.user_id = $1 AND f.head_id = ANY($2::uuid[]) AND r.marker_seq > $3
      ORDER BY r.marker_seq`;

const sorted = <T>(xs: T[]): string[] => xs.map((x) => JSON.stringify(x)).sort();
/** editsSince's comparisons on the fixed sample (see figures()). */
const PARITY_COMPARISONS = 1_005;

/**
 * (user, S, the MFC ids of S's rows, its copies' occs) for background users and both scenario users.
 * A fixed sample: head ids are fixed (the fill's md5 and headFor of fixed MFC ids), and the random
 * uuids of the scenario's users only break ties between users sharing a head.
 */
async function figures(limit: number): Promise<{ userId: string; S: string; ids: string[]; occs: string[] }[]> {
  const { rows } = await db.admin.query<{ user_id: string; s: string; ids: string[]; occs: string[] }>(
    `SELECT r.user_id, r.head_id AS s, array_agg(DISTINCT r.mfc_id) AS ids, array_agg(DISTINCT c.occ_id::text) AS occs
       FROM import_row_base r JOIN import_copy_base c ON c.user_id = r.user_id AND c.head_id = r.head_id
      GROUP BY 1, 2 ORDER BY md5(r.head_id::text), r.user_id LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ userId: r.user_id, S: r.s, ids: r.ids, occs: r.occs }));
}

describe('identical rows: the rewritten late-edit statements return what the statements they replace returned', () => {
  it('editsSince (holds.ts :428) keeps every key under the copies, a TAG edit included, at every bound', async () => {
    const cases = await figures(150);
    for (const run of [whale, oneX]) {
      const { rows } = await db.admin.query<{ m: string }>('SELECT max(marker_seq) AS m FROM import_run WHERE user_id = $1', [run.userId]);
      cases.push({ userId: run.userId, S: run.S1, ids: [], occs: [run.cx1, run.cx2] }, { userId: run.userId, S: run.S2, ids: [], occs: [run.cx2] });
      const keys = [`res/mfc/${run.S1}`, `uf/${run.S1}/score`];
      const marker = BigInt(rows[0]!.m);
      const now = await editsSince(db.admin, run.userId, marker, keys, [run.cx1]);
      // The other device's tag edit since the re-import is what makes the late sale HOLD.
      expect(now.map((r) => r.facet_key).some((k) => k.startsWith(`occ/${run.cx1}/tag/`))).toBe(true);
    }
    let compared = 0;
    let nonEmpty = 0;
    for (const c of cases) {
      const keys = [`res/mfc/${c.S}`, `imp/mfc/figure/${c.S}`, `uf/${c.S}/score`, `uf/${c.S}/note`];
      const { rows: ms } = await db.admin.query<{ m: string }>('SELECT marker_seq AS m FROM import_run WHERE user_id = $1', [c.userId]);
      for (const marker of [0n, ...ms.map((r) => BigInt(r.m))]) {
        for (const occs of [c.occs, [...c.occs, randomUUID()], []]) {
          const old = (await db.admin.query<{ facet_key: string; version: string }>(OLD_EDITS_SINCE, [c.userId, marker.toString(), keys, occs])).rows;
          const now = await editsSince(db.admin, c.userId, marker, keys, occs);
          expect(sorted(now), `${c.userId} ${c.S} ${marker}`).toEqual(sorted(old));
          compared += 1;
          if (old.length > 0) nonEmpty += 1;
        }
      }
    }
    // 150 sampled figures and 4 scenario cases, three occ sets at each of their markers and at 0: a
    // background user has one import, a scenario user two. The sample is fixed, so the count is exact.
    expect(compared).toBe(PARITY_COMPARISONS);
    expect(nonEmpty).toBeGreaterThan(500);
  });

  it('figureOccs (store.ts :58) finds the same copies by head, origin and base, with tombstoned heads in the table', async () => {
    const cases = await figures(300);
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      // A device DELETE or a revision tombstones a head: '' is never cast, and names no figure.
      const { rowCount } = await client.query(
        `UPDATE facet_state SET op = 'delete', payload = '' WHERE (user_id, facet_key) IN
           (SELECT user_id, 'occ/' || occ_id || '/head' FROM import_copy_base ORDER BY md5(occ_id::text) LIMIT 2000)`,
      );
      expect(rowCount).toBeGreaterThan(1_000);
      let multi = 0;
      for (const c of cases) {
        for (const ids of [c.ids, [], [...c.ids, '9999999']]) {
          const old = (await client.query<{ occ: string }>(OLD_FIGURE_OCCS, [c.userId, c.S, ids])).rows.map((r) => r.occ);
          const now = await figureOccs(client, c.userId, c.S, ids);
          expect([...now].sort(), `${c.userId} ${c.S}`).toEqual([...old].sort());
          if (old.length > 1) multi += 1;
        }
      }
      expect(multi).toBeGreaterThan(0);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('readFrames (holds.ts :139) gives every frame the same start, the whale\'s 4,000-figure first import included', async () => {
    const { rows: users } = await db.admin.query<{ user_id: string }>('SELECT DISTINCT user_id FROM import_frame ORDER BY 1 LIMIT 30');
    const all = [...users.map((u) => u.user_id), whale.userId, oneX.userId];
    let frames = 0;
    for (const userId of all) {
      const { rows: hs } = await db.admin.query<{ head_id: string }>('SELECT DISTINCT head_id FROM import_frame WHERE user_id = $1', [userId]);
      const heads = hs.map((r) => r.head_id);
      const { rows: ms } = await db.admin.query<{ m: string }>('SELECT min(marker_seq) AS m FROM import_run WHERE user_id = $1', [userId]);
      for (const after of [0n, BigInt(ms[0]!.m)]) {
        const old = (
          await db.admin.query<{ head_id: string; import_number: number; export_date: string; marker: string; start: string; settled: boolean; before: unknown }>(OLD_READ_FRAMES, [
            userId,
            heads,
            after.toString(),
          ])
        ).rows.map((r) => ({ head: r.head_id, importNumber: r.import_number, exportDate: r.export_date, marker: r.marker, start: r.start, settled: r.settled, before: r.before }));
        const now = (await readFrames(db.admin, userId, heads, after)).map((f) => ({ ...f, marker: f.marker.toString(), start: f.start.toString() }));
        expect(sorted(now), userId).toEqual(sorted(old));
        // Same order too: by marker.
        expect(now.map((f) => f.marker)).toEqual(old.map((f) => f.marker));
        frames += old.length;
      }
    }
    expect(frames).toBeGreaterThan(15_000);
  });
});
