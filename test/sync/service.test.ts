// SyncService acceptance through the real Fastify app: the OIDC + DPoP edge, enrolled devices
// in a real database, and every call signed with the repo's makeProof helper.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { create, fromBinary, toJsonString } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import {
  MAX_FUTURE_SKEW_MS,
  PushOutcome,
  PushRequestSchema,
  PushResponseSchema,
  SERVER_DEVICE_ID,
  StatusRequestSchema,
  SyncOp,
  SyncService,
  canonicalInstant,
  canonicalVersion,
  isCanonicalVersion,
  parseVersion,
  userFacetKey,
  type PushResult,
  type SyncEvent,
} from '@figurecollecting/fc-api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeProof, TEST_ORIGIN } from '../helpers/auth.js';
import { KeyedSerialiser } from '../../src/sync/serialise.js';
import { DISPLAY, ok, startSyncApp, SyncCaller, SYNC_SERVICE_PATH, type SyncApp } from '../helpers/syncClient.js';
import { startSyncDatabase, type SyncDatabase } from '../helpers/syncDatabase.js';

let db: SyncDatabase;
let h: SyncApp;
/** A second replica on the same database: the only way a second writer meets the advisory lock. */
let h2: SyncApp;

beforeAll(async () => {
  db = await startSyncDatabase();
  h = await startSyncApp(db.app);
  h2 = await startSyncApp(db.app, h.issuer);
}, 240_000);

afterAll(async () => {
  await h2?.close();
  await h?.close();
  await db?.close();
});

const status = (s: string) => JSON.stringify({ status: s, ...DISPLAY });
const note = (n: string) => JSON.stringify({ note: n, ...DISPLAY });
const score = (n: number) => JSON.stringify({ score: n, ...DISPLAY });

/** store.ts's advisory-lock namespace, 'sync' in ASCII. */
const LOCK_NAMESPACE = 0x73796e63;

async function waiting(event: string, statement: string): Promise<boolean> {
  const { rows } = await db.admin.query(
    `SELECT 1 FROM pg_stat_activity
      WHERE usename = 'coordinator' AND wait_event_type = 'Lock' AND wait_event = $1 AND query LIKE $2`,
    [event, `${statement}%`],
  );
  return rows.length > 0;
}

async function lockWaiters(): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>(
    "SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'coordinator' AND wait_event_type = 'Lock' AND wait_event = 'advisory'",
  );
  return Number(rows[0]!.n);
}

async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const within = <T>(promise: Promise<T>, ms: number): Promise<T | 'timed out'> =>
  Promise.race([promise, new Promise<'timed out'>((resolve) => setTimeout(() => resolve('timed out'), ms))]);

/** A version for `caller`, `offsetMs` from now, with `counter`. */
function mint(caller: SyncCaller, counter = 0, offsetMs = -60_000): string {
  return canonicalVersion({ instant: new Date(Date.now() + offsetMs), counter, deviceId: caller.deviceId });
}

/** Versions for `caller` on one instant, so only the counters order them. */
function mintTogether(caller: SyncCaller, ...counters: number[]): string[] {
  const instant = new Date(Date.now() - 60_000);
  return counters.map((counter) => canonicalVersion({ instant, counter, deviceId: caller.deviceId }));
}

const upsert = (facetKey: string, version: string, payload: string) => ({
  facetKey,
  version,
  op: SyncOp.UPSERT,
  payload,
});

async function feedCount(userId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>('SELECT count(*) AS n FROM feed_event WHERE user_id = $1', [userId]);
  return Number(rows[0]!.n);
}

/** Walk Delta from `cursor` to the head. */
async function drain(caller: SyncCaller, cursor = '', limit = 0): Promise<{ events: SyncEvent[]; cursor: string; pages: number }> {
  const events: SyncEvent[] = [];
  let pages = 0;
  for (;;) {
    const page = ok(await caller.delta({ cursor, limit }));
    pages += 1;
    events.push(...page.events);
    cursor = page.nextCursor;
    if (!page.hasMore) return { events, cursor, pages };
  }
}

describe('(7) the edge guards Delta, Push and Status', () => {
  const METHODS = ['Delta', 'Push', 'Status'] as const;

  it.each(METHODS)('%s without any credential is 401 and carries DPoP-Nonce', async (method) => {
    const res = await h.app.inject({
      method: 'POST',
      url: `${SYNC_SERVICE_PATH}/${method}`,
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['dpop-nonce']).toMatch(/.+/);
  });

  it.each(METHODS)('%s with a valid token but no proof is 401 and carries DPoP-Nonce', async (method) => {
    const caller = await SyncCaller.enrol(h);
    const res = await h.app.inject({
      method: 'POST',
      url: `${SYNC_SERVICE_PATH}/${method}`,
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        authorization: `DPoP ${caller.token}`,
      },
      payload: '{}',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['dpop-nonce']).toMatch(/.+/);
    expect(res.headers['www-authenticate']).toContain('invalid_dpop_proof');
  });

  it('registers all three routes as guarded, by the absence of config.auth', () => {
    const sync = h.app.auth.routes.filter((r) => r.url.startsWith(SYNC_SERVICE_PATH));
    expect([...new Set(sync.map((r) => r.url))].sort()).toEqual(METHODS.map((m) => `${SYNC_SERVICE_PATH}/${m}`).sort());
    expect(new Set(sync.map((r) => r.auth))).toEqual(new Set(['guarded']));
  });
});

describe('Push', () => {
  it('(3) replays a client_id as DUPLICATE and writes one feed_event', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = userFacetKey(randomUUID(), 'status');
    const batch = { clientId: randomUUID(), events: [upsert(key, mint(caller), status('owned'))] };

    const first = await caller.pushBinary(batch);
    expect(first.message.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED]);

    const replay = await caller.pushBinary(batch);
    expect(replay.message.results.map((r) => r.outcome)).toEqual([PushOutcome.DUPLICATE]);
    expect(replay.message.results[0]!.current).toEqual(first.message.results[0]!.current);
    expect(await feedCount(caller.userId)).toBe(1);

    const json = ok(await caller.push(batch));
    expect(json.results.map((r) => r.outcome)).toEqual([PushOutcome.DUPLICATE]);
    expect(await feedCount(caller.userId)).toBe(1);
  });

  it('replays APPLIED as DUPLICATE and each REJECTED with its first reason, from a receipt of outcomes and reasons', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = userFacetKey(randomUUID(), 'score');
    const future = canonicalVersion({ instant: new Date(Date.now() + MAX_FUTURE_SKEW_MS + 60_000), counter: 1, deviceId: caller.deviceId });
    // A server-owned key the server holds a value for: REJECTED on it never carries `current`.
    const serverKey = `identity/${randomUUID()}`;
    const serverVersion = canonicalVersion({ instant: new Date(Date.now() - 60_000), counter: 0, deviceId: SERVER_DEVICE_ID });
    await db.admin.query(
      `WITH fed AS (INSERT INTO feed_event (user_id, facet_key, version, op, payload) VALUES ($1, $2, $3, 'upsert', '{}') RETURNING seq)
       INSERT INTO facet_state (user_id, facet_key, version, op, payload, seq) SELECT $1, $2, $3, 'upsert', '{}', seq FROM fed`,
      [caller.userId, serverKey, serverVersion],
    );
    const batch = {
      clientId: randomUUID(),
      events: [upsert(key, mint(caller), score(4)), upsert(key, future, score(5)), upsert(serverKey, mint(caller, 2), '{}')],
    };
    const first = await caller.pushBinary(batch);
    const shape = (r: PushResult) => [r.outcome, r.reason.split(':')[0], r.current?.version];
    const applied = first.message.results[0]!.current?.version;
    expect(first.message.results.map(shape)).toEqual([
      [PushOutcome.APPLIED, '', applied],
      [PushOutcome.REJECTED, 'version_future', applied],
      [PushOutcome.REJECTED, 'facet_key_not_user_owned', undefined],
    ]);

    const stored = await db.admin.query<{ outcomes: Buffer }>(
      'SELECT outcomes FROM mutation_receipt WHERE user_id = $1 AND client_id = $2',
      [caller.userId, batch.clientId],
    );
    const recorded = fromBinary(PushResponseSchema, stored.rows[0]!.outcomes).results;
    expect(recorded.map((r) => [r.facetKey, r.outcome, r.reason, r.version, r.current])).toEqual(
      first.message.results.map((r) => [r.facetKey, r.outcome, r.reason, '', undefined]),
    );

    for (const replay of [await caller.pushBinary(batch), await caller.pushBinary(batch)]) {
      expect(replay.message.results.map(shape)).toEqual([
        [PushOutcome.DUPLICATE, '', applied],
        [PushOutcome.REJECTED, 'version_future', applied],
        [PushOutcome.REJECTED, 'facet_key_not_user_owned', undefined],
      ]);
      expect(replay.message.results.map((r) => r.reason)).toEqual(first.message.results.map((r) => r.reason));
    }
    expect(await feedCount(caller.userId)).toBe(2);
  });

  // A replay repeats the recorded outcome and reason, but `current` is the facet as held at the
  // replay: the client adopts it whole while it still holds the edit, and a sibling may have written.
  it.each([
    ['APPLIED', 'upserts', PushOutcome.DUPLICATE],
    ['APPLIED', 'tombstones', PushOutcome.DUPLICATE],
    ['STALE', 'upserts', PushOutcome.STALE],
  ] as const)('answers a replayed %s, after a sibling %s the key, with its recorded outcome and the facet as held now', async (was, sibling, outcome) => {
    const a = await SyncCaller.enrol(h);
    const b = (await SyncCaller.sibling(h, a)).via(h2);
    const key = userFacetKey(randomUUID(), 'score');
    if (was === 'STALE') ok(await b.push({ clientId: randomUUID(), events: [upsert(key, mint(b, 0, -300_000), score(3))] }));
    const batch = { clientId: randomUUID(), events: [upsert(key, mint(a, 0, -400_000), score(5))] };
    const lost = ok(await a.push(batch)).results[0]!;
    expect(PushOutcome[lost.outcome]).toBe(was);

    const later = mint(b, 1, -200_000);
    const write = sibling === 'upserts' ? upsert(key, later, score(8)) : { facetKey: key, version: later, op: SyncOp.DELETE, payload: '' };
    ok(await b.push({ clientId: randomUUID(), events: [write] }));
    const written = await feedCount(a.userId);

    for (const replay of [ok(await a.push(batch)).results[0]!, ok(await a.via(h2).push(batch)).results[0]!]) {
      expect(replay).toMatchObject({ facetKey: key, outcome, reason: '', version: later });
      expect(replay.current).toMatchObject({ facetKey: key, version: later, op: write.op, payload: write.payload });
    }
    expect(await feedCount(a.userId)).toBe(written);
  });

  // The client rule adopts a REJECTED `current` whole when it still holds the rejected edit. A
  // device that lost the answer may since have pulled a sibling's write it did not adopt, being
  // older than its pending edit, so a replay must carry the facet as held at the replay.
  it.each([
    ['a value the server held at the first answer', true],
    ['no value at the first answer', false],
  ])('answers a replayed REJECTED event with the facet as held now, from %s', async (_why, seeded) => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.sibling(h, a);
    const key = userFacetKey(randomUUID(), 'score');
    const v1 = mint(b, 0, -600_000);
    const v2 = mint(b, 0, -500_000);
    const vA = mint(a, 0, -300_000);
    if (seeded) ok(await b.push({ clientId: randomUUID(), events: [upsert(key, v1, score(3))] }));

    const batch = { clientId: randomUUID(), events: [upsert(key, vA, score(11))] };
    const lost = ok(await a.push(batch)).results[0]!;
    expect(lost.outcome).toBe(PushOutcome.REJECTED);
    expect(lost.current?.version).toBe(seeded ? v1 : undefined);

    ok(await b.push({ clientId: randomUUID(), events: [upsert(key, v2, score(7))] }));
    const written = await feedCount(a.userId);
    const replay = ok(await a.push(batch)).results[0]!;
    expect(replay).toMatchObject({ outcome: PushOutcome.REJECTED, reason: lost.reason, version: v2 });
    expect(replay.current).toMatchObject({ facetKey: key, version: v2, op: SyncOp.UPSERT, payload: score(7) });
    expect(await feedCount(a.userId)).toBe(written);
  });

  it('refuses the same client_id with a different body as INVALID_ARGUMENT and writes nothing', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = userFacetKey(randomUUID(), 'status');
    const clientId = randomUUID();
    ok(await caller.push({ clientId, events: [upsert(key, mint(caller, 0), status('owned'))] }));

    const reused = await caller.push({ clientId, events: [upsert(key, mint(caller, 1), status('wished'))] });
    expect(reused).toMatchObject({ ok: false, status: 400, code: 'invalid_argument' });
    expect(await feedCount(caller.userId)).toBe(1);
  });

  it('(4) STALE carries current with the server payload, and DUPLICATE carries it too', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = userFacetKey(randomUUID(), 'note');
    const [newer, older] = mintTogether(caller, 5, 4) as [string, string];
    ok(await caller.push({ clientId: randomUUID(), events: [upsert(key, newer, note('server copy'))] }));

    for (const version of [older, newer]) {
      const batch = { clientId: randomUUID(), events: [upsert(key, version, note('losing copy'))] };
      const stale = ok(await caller.push(batch)).results[0]!;
      expect(stale.outcome).toBe(PushOutcome.STALE);
      expect(stale.version).toBe(newer);
      expect(stale.current).toMatchObject({ facetKey: key, version: newer, op: SyncOp.UPSERT, payload: note('server copy') });

      const duplicate = ok(await caller.push(batch)).results[0]!;
      expect(duplicate.outcome).toBe(PushOutcome.STALE);
      expect(duplicate.current?.payload).toBe(note('server copy'));
    }

    const fresh = { clientId: randomUUID(), events: [upsert(key, mint(caller, 6), note('third'))] };
    ok(await caller.push(fresh));
    const dup = ok(await caller.push(fresh)).results[0]!;
    expect(dup.outcome).toBe(PushOutcome.DUPLICATE);
    expect(dup.current?.payload).toBe(note('third'));
  });

  it('(5) rejects each bad event with a reason while the rest of the batch is APPLIED', async () => {
    const caller = await SyncCaller.enrol(h);
    const other = await SyncCaller.sibling(h, caller);
    const head = randomUUID();
    const statusKey = userFacetKey(head, 'status');
    const countKey = userFacetKey(head, 'count');
    const first = mint(caller, 1);
    const future = canonicalVersion({
      instant: new Date(Date.now() + MAX_FUTURE_SKEW_MS + 60_000),
      counter: 0,
      deviceId: caller.deviceId,
    });
    const nonCanonical = parseVersion(first)!.instant.replace(/\d{3}Z$/, 'Z') + first.slice(27);

    const res = ok(
      await caller.push({
        clientId: randomUUID(),
        events: [
          upsert(statusKey, first, status('owned')),
          upsert(statusKey, nonCanonical, status('wished')),
          upsert(statusKey, future, status('wished')),
          upsert(`identity/${head}`, mint(caller, 2), '{"title":"x"}'),
          upsert(statusKey, mint(other, 3), status('wished')),
          upsert(countKey, mint(caller, 4), JSON.stringify({ count: 2, ...DISPLAY })),
        ],
      }),
    );

    expect(res.results.map((r) => [r.outcome, r.reason.split(':')[0]])).toEqual([
      [PushOutcome.APPLIED, ''],
      [PushOutcome.REJECTED, 'version_malformed'],
      [PushOutcome.REJECTED, 'version_future'],
      [PushOutcome.REJECTED, 'facet_key_not_user_owned'],
      [PushOutcome.REJECTED, 'device_mismatch'],
      [PushOutcome.APPLIED, ''],
    ]);
    // A user-owned key the server holds comes back with the server's copy; a server key does not.
    for (const i of [1, 2, 4]) expect(res.results[i]!.current?.version).toBe(first);
    expect(res.results[3]!.current).toBeUndefined();
    expect(res.results[3]!.version).toBe('');

    const feed = await drain(caller);
    expect(feed.events.map((e) => e.facetKey)).toEqual([statusKey, countKey]);
  });

  it.each([
    ['a bare instant on a user-owned key', 'version_malformed', (c: SyncCaller) => upsert(userFacetKey(randomUUID(), 'score'), parseVersion(mint(c))!.instant, '{}')],
    ['the reserved server device', 'device_mismatch', () => upsert(userFacetKey(randomUUID(), 'score'), canonicalVersion({ instant: new Date(Date.now() - 1000), counter: 0, deviceId: SERVER_DEVICE_ID }), JSON.stringify({ score: 7, ...DISPLAY }))],
    ['a DELETE carrying a payload', 'payload_invalid', (c: SyncCaller) => ({ ...upsert(userFacetKey(randomUUID(), 'score'), mint(c), '{}'), op: SyncOp.DELETE })],
    ['an UPSERT with no payload', 'payload_invalid', (c: SyncCaller) => upsert(userFacetKey(randomUUID(), 'score'), mint(c), '')],
    ['an unspecified op', 'payload_invalid', (c: SyncCaller) => ({ ...upsert(userFacetKey(randomUUID(), 'score'), mint(c), '{}'), op: SyncOp.UNSPECIFIED })],
    ['a payload that is not JSON', 'payload_invalid', (c: SyncCaller) => upsert(userFacetKey(randomUUID(), 'score'), mint(c), '{score: 7')],
    ['a payload outside its schema', 'payload_invalid', (c: SyncCaller) => upsert(userFacetKey(randomUUID(), 'score'), mint(c), JSON.stringify({ score: 11, ...DISPLAY }))],
    ['a payload that is not an object', 'payload_invalid', (c: SyncCaller) => upsert(userFacetKey(randomUUID(), 'note'), mint(c), '"just text"')],
  ])('rejects %s as %s', async (_why, reason, build) => {
    const caller = await SyncCaller.enrol(h);
    const result = ok(await caller.push({ clientId: randomUUID(), events: [build(caller)] })).results[0]!;
    expect(result.outcome).toBe(PushOutcome.REJECTED);
    expect(result.reason.split(':')[0]).toBe(reason);
    expect(result.current).toBeUndefined();
  });

  it('rejects a past-bound version as version_future even where the stored version is higher', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = userFacetKey(randomUUID(), 'score');
    const ahead = canonicalVersion({ instant: new Date(Date.now() + 3_600_000), counter: 0, deviceId: caller.deviceId });
    await db.admin.query(
      `WITH fed AS (INSERT INTO feed_event (user_id, facet_key, version, op, payload) VALUES ($1, $2, $3, 'upsert', $4) RETURNING seq)
       INSERT INTO facet_state (user_id, facet_key, version, op, payload, seq) SELECT $1, $2, $3, 'upsert', $4, seq FROM fed`,
      [caller.userId, key, ahead, score(9)],
    );
    const past = canonicalVersion({ instant: new Date(Date.now() + MAX_FUTURE_SKEW_MS + 60_000), counter: 0, deviceId: caller.deviceId });
    const res = ok(await caller.push({ clientId: randomUUID(), events: [upsert(key, past, score(2))] })).results[0]!;
    expect(res.outcome).toBe(PushOutcome.REJECTED);
    expect(res.reason.split(':')[0]).toBe('version_future');
    expect(res.current?.version).toBe(ahead);
  });

  it('accepts a version inside the future skew and rejects one past it', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = userFacetKey(randomUUID(), 'score');
    const at = (ms: number) => canonicalVersion({ instant: new Date(Date.now() + ms), counter: 0, deviceId: caller.deviceId });
    const res = ok(
      await caller.push({
        clientId: randomUUID(),
        events: [
          upsert(key, at(MAX_FUTURE_SKEW_MS - 60_000), JSON.stringify({ score: 8, ...DISPLAY })),
          upsert(userFacetKey(randomUUID(), 'score'), at(MAX_FUTURE_SKEW_MS + 60_000), JSON.stringify({ score: 8, ...DISPLAY })),
        ],
      }),
    );
    expect(res.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.REJECTED]);
  });

  it('applies a DELETE as a tombstone and keeps the payload bytes of an UPSERT exactly', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = userFacetKey(randomUUID(), 'note');
    const exact = `{ "tz":"Asia/Tokyo",\n  "note" : "\\u7bb1\\u306b\\u50b7 café 🎎", "edited_at":"2026-09-26T08:00:00.1+09:00" }`;
    ok(await caller.push({ clientId: randomUUID(), events: [upsert(key, mint(caller, 1), exact)] }));
    ok(await caller.push({ clientId: randomUUID(), events: [{ facetKey: key, version: mint(caller, 2), op: SyncOp.DELETE, payload: '' }] }));

    const feed = await drain(caller);
    expect(feed.events.map((e) => [e.op, e.payload])).toEqual([
      [SyncOp.UPSERT, exact],
      [SyncOp.DELETE, ''],
    ]);
  });

  it('applies two events for one key in batch order', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = userFacetKey(randomUUID(), 'status');
    const [v1, v2, v0] = mintTogether(caller, 1, 2, 0) as [string, string, string];
    const res = ok(
      await caller.push({
        clientId: randomUUID(),
        events: [upsert(key, v1, status('ordered')), upsert(key, v2, status('owned')), upsert(key, v0, status('wished'))],
      }),
    );
    expect(res.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.APPLIED, PushOutcome.STALE]);
    expect(res.results[2]!.current?.payload).toBe(status('owned'));
  });

  it('takes 200 events in one batch and refuses 201 with INVALID_ARGUMENT', async () => {
    const caller = await SyncCaller.enrol(h);
    const events = (n: number) =>
      Array.from({ length: n }, (_, i) => upsert(userFacetKey(randomUUID(), 'score'), mint(caller, i), JSON.stringify({ score: 1 + (i % 10), ...DISPLAY })));
    const full = ok(await caller.push({ clientId: randomUUID(), events: events(200) }));
    expect(full.results.every((r) => r.outcome === PushOutcome.APPLIED)).toBe(true);

    const over = await caller.push({ clientId: randomUUID(), events: events(201) });
    expect(over).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await feedCount(caller.userId)).toBe(200);
  });

  it.each([
    ['an empty client_id', ''],
    ['a NUL inside', 'a\u0000b'],
    ['129 characters', 'c'.repeat(129)],
    ['4000 characters', 'd'.repeat(4000)],
    ['a space inside', 'a b'],
    ['a non-ASCII character', 'caf\u00e9'],
  ])('refuses %s with INVALID_ARGUMENT, never an internal error', async (_why, clientId) => {
    const caller = await SyncCaller.enrol(h);
    const res = await caller.push({ clientId, events: [upsert(userFacetKey(randomUUID(), 'score'), mint(caller), score(3))] });
    expect(res).toMatchObject({ ok: false, status: 400, code: 'invalid_argument' });
    expect(await feedCount(caller.userId)).toBe(0);
  });

  it('takes a client_id of 128 printable ASCII characters', async () => {
    const caller = await SyncCaller.enrol(h);
    const clientId = `${'~!'.repeat(63)}Az`;
    const res = ok(await caller.push({ clientId, events: [upsert(userFacetKey(randomUUID(), 'score'), mint(caller), score(3))] }));
    expect(clientId).toHaveLength(128);
    expect(res.results[0]!.outcome).toBe(PushOutcome.APPLIED);
  });

  it('keys receipts per user: another user may reuse a client_id', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.enrol(h);
    const clientId = randomUUID();
    ok(await a.push({ clientId, events: [upsert(userFacetKey(randomUUID(), 'score'), mint(a), JSON.stringify({ score: 3, ...DISPLAY }))] }));
    const res = ok(await b.push({ clientId, events: [upsert(userFacetKey(randomUUID(), 'score'), mint(b), JSON.stringify({ score: 4, ...DISPLAY }))] }));
    expect(res.results[0]!.outcome).toBe(PushOutcome.APPLIED);
  });

  it("never shows user B user A's facet through STALE, REJECTED or a replay of A's batch", async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.enrol(h);
    const k = userFacetKey(randomUUID(), 'note');
    const k2 = userFacetKey(randomUUID(), 'note');
    const aBatch = { clientId: randomUUID(), events: [upsert(k, mint(a, 0, -1_000), note('A-SECRET-1')), upsert(k2, mint(a, 1, -1_000), note('A-SECRET-2'))] };
    ok(await a.push(aBatch));

    const older = ok(await b.push({ clientId: randomUUID(), events: [upsert(k, mint(b, 0, -500_000), note('b'))] })).results[0]!;
    expect(older.outcome).toBe(PushOutcome.APPLIED);
    const rejected = ok(await b.push({ clientId: randomUUID(), events: [upsert(k2, mint(b, 0, -500_000), '{')] })).results[0]!;
    expect(rejected.outcome).toBe(PushOutcome.REJECTED);
    expect(rejected.current).toBeUndefined();

    const replay = await b.push(aBatch);
    expect(replay.raw.body).not.toContain('A-SECRET');
    expect(ok(replay).results.map((r) => r.reason.split(':')[0])).toEqual(['device_mismatch', 'device_mismatch']);
    expect(JSON.stringify((await drain(b)).events)).not.toContain('A-SECRET');
  });
});

describe('Delta', () => {
  it('(6) never shows user B the facets of user A, whatever cursor B presents', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.enrol(h);
    const aKey = userFacetKey(randomUUID(), 'note');
    const bKey = userFacetKey(randomUUID(), 'note');
    ok(await a.push({ clientId: randomUUID(), events: [upsert(aKey, mint(a), note('a private'))] }));
    ok(await b.push({ clientId: randomUUID(), events: [upsert(bKey, mint(b), note('b'))] }));
    ok(await a.push({ clientId: randomUUID(), events: [upsert(aKey, mint(a, 1), note('a private 2'))] }));

    const fromEmpty = await drain(b);
    expect(fromEmpty.events.map((e) => e.facetKey)).toEqual([bKey]);
    const aCursorBeforeB = ok(await a.delta({ limit: 1 })).nextCursor;
    const withA = await drain(b, aCursorBeforeB);
    expect(withA.events.every((e) => e.facetKey === bKey)).toBe(true);
    expect(JSON.stringify(withA.events)).not.toContain('a private');
  });

  it.each([
    ['garbage', 'not-a-cursor!'],
    ['a foreign version prefix', Buffer.from('v2:5').toString('base64url')],
    ['a negative seq', Buffer.from('v1:-5').toString('base64url')],
    ['a seq with a leading zero', Buffer.from('v1:05').toString('base64url')],
    ['a seq past int8', Buffer.from('v1:9223372036854775808').toString('base64url')],
    ['padded base64', `${Buffer.from('v1:5').toString('base64')}==`],
    ['a position this database never issued', Buffer.from('v1:900000000000').toString('base64url')],
  ])('(8) answers %s with INVALID_ARGUMENT', async (_why, cursor) => {
    const caller = await SyncCaller.enrol(h);
    expect(await caller.delta({ cursor })).toMatchObject({ ok: false, status: 400, code: 'invalid_argument' });
  });

  it('pages 500 by default, caps a page at 1000, and resumes exactly from next_cursor', async () => {
    const caller = await SyncCaller.enrol(h);
    for (let batch = 0; batch < 6; batch += 1) {
      const events = Array.from({ length: 200 }, (_, i) =>
        upsert(userFacetKey(randomUUID(), 'score'), mint(caller, batch * 200 + i), JSON.stringify({ score: 5, ...DISPLAY })),
      );
      ok(await caller.push({ clientId: randomUUID(), events }));
    }

    const byDefault = ok(await caller.delta({}));
    expect(byDefault.events).toHaveLength(500);
    expect(byDefault.hasMore).toBe(true);

    const capped = ok(await caller.delta({ limit: 5000 }));
    expect(capped.events).toHaveLength(1000);
    expect(capped.hasMore).toBe(true);

    const rest = ok(await caller.delta({ cursor: capped.nextCursor, limit: 5000 }));
    expect(rest.events).toHaveLength(200);
    expect(rest.hasMore).toBe(false);
    expect([...capped.events, ...rest.events].map((e) => e.version)).toEqual(
      (await drain(caller, '', 7)).events.map((e) => e.version),
    );
    const parked = ok(await caller.delta({ cursor: rest.nextCursor }));
    expect(parked).toMatchObject({ events: [], nextCursor: rest.nextCursor, hasMore: false });
  });

  it('records the cursor per (user, device) on every call', async () => {
    const caller = await SyncCaller.enrol(h);
    const sibling = await SyncCaller.sibling(h, caller);
    for (let i = 0; i < 3; i += 1) {
      ok(await caller.push({ clientId: randomUUID(), events: [upsert(userFacetKey(randomUUID(), 'score'), mint(caller, i), JSON.stringify({ score: 2, ...DISPLAY }))] }));
    }
    const seqs = await db.admin.query<{ seq: string }>('SELECT seq FROM feed_event WHERE user_id = $1 ORDER BY seq', [caller.userId]);
    const page1 = ok(await caller.delta({ limit: 2 }));
    ok(await caller.delta({ cursor: page1.nextCursor, limit: 2 }));
    ok(await sibling.delta({ limit: 1 }));

    const cursors = await db.admin.query<{ device_id: string; acked_seq: string; delivered_seq: string }>(
      'SELECT device_id, acked_seq, delivered_seq FROM feed_cursor WHERE user_id = $1 ORDER BY acked_seq DESC',
      [caller.userId],
    );
    expect(cursors.rows).toEqual([
      { device_id: caller.deviceId, acked_seq: seqs.rows[1]!.seq, delivered_seq: seqs.rows[2]!.seq },
      { device_id: sibling.deviceId, acked_seq: '0', delivered_seq: seqs.rows[0]!.seq },
    ]);
  });
});

describe('Status', () => {
  it('reports the head cursor, zero pending review, and the Postgres clock in canonical form', async () => {
    const caller = await SyncCaller.enrol(h);
    const other = await SyncCaller.enrol(h);
    ok(await other.push({ clientId: randomUUID(), events: [upsert(userFacetKey(randomUUID(), 'score'), mint(other), score(1))] }));
    const empty = ok(await caller.status());
    expect(empty.cursor).toBe(ok(await caller.delta({})).nextCursor);

    ok(await caller.push({ clientId: randomUUID(), events: [upsert(userFacetKey(randomUUID(), 'score'), mint(caller), JSON.stringify({ score: 9, ...DISPLAY }))] }));
    const before = await db.admin.query<{ t: string }>("SELECT to_json(clock_timestamp()) #>> '{}' AS t");
    const res = ok(await caller.status());
    const after = await db.admin.query<{ t: string }>("SELECT to_json(clock_timestamp()) #>> '{}' AS t");

    expect(res.pendingReview).toBe(0n);
    expect(res.cursor).not.toBe(empty.cursor);
    expect(res.cursor).toBe((await drain(caller)).cursor);
    expect(isCanonicalVersion(res.serverNowIso)).toBe(true);
    expect(parseVersion(res.serverNowIso)!.counter).toBeNull();
    expect(res.serverNowIso >= canonicalInstant(before.rows[0]!.t)).toBe(true);
    expect(res.serverNowIso <= canonicalInstant(after.rows[0]!.t)).toBe(true);
  });
});

// The second writer runs on the other replica: a replica queues one user's Pushes before the
// pool, so only another process meets the advisory lock.
describe('(2) commit order: a Delta reader never skips a late-committing lower seq', () => {
  it('holds the second writer until the first commits', async () => {
    const caller = await SyncCaller.enrol(h);
    const sibling = (await SyncCaller.sibling(h, caller)).via(h2);
    const reader = await SyncCaller.sibling(h, caller);
    const k1 = userFacetKey(randomUUID(), 'status');
    const k2 = userFacetKey(randomUUID(), 'status');
    const firstId = randomUUID();

    // Park the first Push after it has taken its seq: its receipt INSERT waits on this row.
    const blocker = await db.admin.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      "INSERT INTO mutation_receipt (user_id, client_id, request_sha256, outcomes) VALUES ($1, $2, sha256('x'), '')",
      [caller.userId, firstId],
    );
    try {
      const first = caller.push({ clientId: firstId, events: [upsert(k1, mint(caller, 1), status('owned'))] });
      await until(() => waiting('transactionid', 'INSERT INTO mutation_receipt'), 'the first push to park');

      let secondDone = false;
      const second = sibling.push({ clientId: randomUUID(), events: [upsert(k2, mint(sibling, 2), status('wished'))] }).finally(() => {
        secondDone = true;
      });
      await until(async () => secondDone || (await waiting('advisory', 'SELECT pg_advisory_xact_lock')), 'the second push to finish or queue');

      const between = ok(await reader.delta({}));
      await blocker.query('ROLLBACK');
      const [r1, r2] = await Promise.all([first, second]);
      expect(ok(r1).results[0]!.outcome).toBe(PushOutcome.APPLIED);
      expect(ok(r2).results[0]!.outcome).toBe(PushOutcome.APPLIED);

      const after = await drain(reader, between.nextCursor);
      expect([...between.events, ...after.events].map((e) => e.facetKey).sort()).toEqual([k1, k2].sort());
    } finally {
      blocker.release();
    }
  });

  it('holds the second writer while the first is parked after taking its seq', async () => {
    const caller = await SyncCaller.enrol(h);
    const sibling = (await SyncCaller.sibling(h, caller)).via(h2);
    const reader = await SyncCaller.sibling(h, caller);
    const k1 = userFacetKey(randomUUID(), 'score');
    const k2 = userFacetKey(randomUUID(), 'score');

    // An uncommitted facet_state row for k1 parks the first Push at its upsert, after nextval.
    const blocker = await db.admin.connect();
    await blocker.query('BEGIN');
    const v0 = mint(caller, 0, -900_000);
    await blocker.query(
      `WITH fed AS (INSERT INTO feed_event (user_id, facet_key, version, op, payload) VALUES ($1, $2, $3, 'upsert', '{}') RETURNING seq)
       INSERT INTO facet_state (user_id, facet_key, version, op, payload, seq) SELECT $1, $2, $3, 'upsert', '{}', seq FROM fed`,
      [caller.userId, k1, v0],
    );
    try {
      const first = caller.push({ clientId: randomUUID(), events: [upsert(k1, mint(caller, 1), score(1))] });
      await until(() => waiting('transactionid', 'WITH fed AS'), 'the first push to park at its upsert');

      let secondDone = false;
      const second = sibling.push({ clientId: randomUUID(), events: [upsert(k2, mint(sibling, 2), score(2))] }).finally(() => {
        secondDone = true;
      });
      await until(async () => secondDone || (await waiting('advisory', 'SELECT pg_advisory_xact_lock')), 'the second push to finish or queue');

      const between = ok(await reader.delta({}));
      await blocker.query('ROLLBACK');
      const [r1, r2] = await Promise.all([first, second]);
      expect(ok(r1).results[0]!.outcome).toBe(PushOutcome.APPLIED);
      expect(ok(r2).results[0]!.outcome).toBe(PushOutcome.APPLIED);

      const after = await drain(reader, between.nextCursor);
      expect([...between.events, ...after.events].map((e) => e.facetKey).sort()).toEqual([k1, k2].sort());
    } finally {
      blocker.release();
    }
  });
});

describe('a user whose Pushes queue behind its lock', () => {
  it('holds one pooled connection on this replica, answers another user meanwhile, and refuses a ninth Push', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.enrol(h);
    const scored = (caller: SyncCaller, i: number) => ({
      clientId: randomUUID(),
      events: [upsert(userFacetKey(randomUUID(), 'score'), mint(caller, i), score(2))],
    });
    // Another replica holds A's lock; the test pool has 12 connections.
    const holder = await db.admin.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_NAMESPACE, a.userId]);
    let pushes: ReturnType<SyncCaller['push']>[] = [];
    let refused: unknown;
    let statusB: unknown;
    let pushB: unknown;
    let waiters = -1;
    try {
      pushes = Array.from({ length: 9 }, (_, i) => a.push(scored(a, i)));
      await until(async () => (await lockWaiters()) >= 1, 'a push to queue on the lock');
      // Eight fit the queue, running one included; the ninth to arrive is answered at once.
      refused = await within(Promise.race(pushes), 4_000);
      statusB = await within(b.status(), 5_000);
      pushB = await within(b.push(scored(b, 0)), 5_000);
      waiters = await lockWaiters();
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(refused).toMatchObject({ ok: false, status: 429, code: 'resource_exhausted' });
    expect(statusB).not.toBe('timed out');
    expect(pushB).not.toBe('timed out');
    expect(ok(pushB as Awaited<ReturnType<SyncCaller['push']>>).results[0]!.outcome).toBe(PushOutcome.APPLIED);
    expect(waiters).toBe(1);

    const answers = await Promise.all(pushes);
    expect(answers.filter((r) => r.ok).map((r) => ok(r).results[0]!.outcome)).toEqual(Array(8).fill(PushOutcome.APPLIED));
    expect(answers.filter((r) => !r.ok)).toHaveLength(1);
    expect(await feedCount(a.userId)).toBe(8);
    expect(ok(await a.push(scored(a, 9))).results[0]!.outcome).toBe(PushOutcome.APPLIED);
  });

  it('gives up on a lock held elsewhere after 5 s with UNAVAILABLE, writes nothing, and serves the next Push', async () => {
    const a = await SyncCaller.enrol(h);
    const holder = await db.admin.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_NAMESPACE, a.userId]);
    let answer: unknown;
    let elapsed = -1;
    try {
      const started = performance.now();
      answer = await within(a.push({ clientId: randomUUID(), events: [upsert(userFacetKey(randomUUID(), 'score'), mint(a), score(4))] }), 9_000);
      elapsed = performance.now() - started;
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(answer).toMatchObject({ ok: false, status: 503, code: 'unavailable' });
    expect(elapsed).toBeGreaterThanOrEqual(4_950);
    expect(elapsed).toBeLessThan(8_000);
    expect(await feedCount(a.userId)).toBe(0);
    expect(ok(await a.push({ clientId: randomUUID(), events: [upsert(userFacetKey(randomUUID(), 'score'), mint(a, 1), score(5))] })).results[0]!.outcome).toBe(
      PushOutcome.APPLIED,
    );
  }, 30_000);

  it('drops a queued Push whose client went away: it frees its place and never writes', async () => {
    const writers = new KeyedSerialiser(8);
    const h3 = await startSyncApp(db.app, h.issuer, writers);
    let first: ReturnType<SyncCaller['push']> | undefined;
    try {
      const baseUrl = await h3.app.listen({ port: 0, host: '127.0.0.1' });
      const a = (await SyncCaller.enrol(h)).via(h3);
      ok(await a.status());
      const kept = userFacetKey(randomUUID(), 'score');
      const dropped = userFacetKey(randomUUID(), 'score');

      const holder = await db.admin.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_NAMESPACE, a.userId]);
      let gone: unknown;
      try {
        first = a.push({ clientId: randomUUID(), events: [upsert(kept, mint(a, 1), score(1))] });
        await until(async () => writers.depth(a.userId) === 1 && (await lockWaiters()) >= 1, 'the first push to wait on the lock');

        const url = `${SYNC_SERVICE_PATH}/Push`;
        const leaving = new AbortController();
        const second = fetch(`${baseUrl}${url}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'connect-protocol-version': '1',
            authorization: `DPoP ${a.token}`,
            dpop: await makeProof(a.key, { htm: 'POST', htu: `${TEST_ORIGIN}${url}`, accessToken: a.token, nonce: a.nonce! }),
          },
          body: toJsonString(PushRequestSchema, create(PushRequestSchema, { clientId: randomUUID(), events: [upsert(dropped, mint(a, 2), score(2))] })),
          signal: leaving.signal,
        }).catch((err: unknown) => err);
        await until(async () => writers.depth(a.userId) === 2, 'the second push to queue');
        leaving.abort();
        gone = await second;
        await until(async () => writers.depth(a.userId) === 1, 'the abandoned push to leave the queue');
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect((gone as Error).name).toBe('AbortError');
      expect(ok(await first!).results[0]!.outcome).toBe(PushOutcome.APPLIED);
      await until(async () => writers.depth(a.userId) === 0, 'the queue to empty');
      const { rows } = await db.admin.query<{ facet_key: string }>('SELECT facet_key FROM feed_event WHERE user_id = $1', [a.userId]);
      expect(rows.map((r) => r.facet_key)).toEqual([kept]);
    } finally {
      await first?.catch(() => undefined);
      await h3.close();
    }
  });
});

// 200 events of the largest payload JSON.stringify writes for a valid facet: a 10,000 code point
// note of U+0001 is \u0001 each, 7 bytes once the JSON envelope escapes the backslash.
describe('the Connect read cap', () => {
  const CAP = 16 * 1024 * 1024;

  it('takes the largest Push a conforming client sends', async () => {
    const caller = await SyncCaller.enrol(h);
    const payload = JSON.stringify({ note: '\u0001'.repeat(10_000), edited_at: '2026-09-26T09:15:00.123456789+18:00', tz: 'A'.repeat(64) });
    const at = new Date(Date.now() - 60_000);
    const events = Array.from({ length: 200 }, (_, i) =>
      upsert(userFacetKey(randomUUID(), 'note'), canonicalVersion({ instant: at, counter: 9_999_999_999 - i, deviceId: caller.deviceId }), payload),
    );
    const request = { clientId: '~'.repeat(128), events };
    const bytes = Buffer.byteLength(toJsonString(PushRequestSchema, create(PushRequestSchema, request)));
    expect(bytes).toBe(14_064_954);
    expect(bytes).toBeLessThan(CAP);

    const res = ok(await caller.push(request));
    expect(res.results.map((r) => r.outcome)).toEqual(Array(200).fill(PushOutcome.APPLIED));
  });

  it.each([
    [CAP, 200],
    [CAP + 1, 429],
  ])('answers a Push body of %i bytes with HTTP %i', async (size, statusCode) => {
    const caller = await SyncCaller.enrol(h);
    const body = toJsonString(
      PushRequestSchema,
      create(PushRequestSchema, { clientId: randomUUID(), events: [upsert(userFacetKey(randomUUID(), 'score'), mint(caller), score(3))] }),
    );
    const res = await caller.send('Push', body.padEnd(size, ' '));
    expect(res.statusCode).toBe(statusCode);
    expect(await feedCount(caller.userId)).toBe(statusCode === 200 ? 1 : 0);
    if (statusCode !== 200) expect(res.json()).toMatchObject({ code: 'resource_exhausted' });
  });
});

describe('through a real Connect client over a socket', () => {
  it('serves Status and Push to connect-node with DPoP headers', async () => {
    const caller = await SyncCaller.enrol(h);
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    expect(address).toContain('127.0.0.1');
    const baseUrl = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    const client = createClient(SyncService, createConnectTransport({ baseUrl, httpVersion: '1.1' }));
    const headers = async (method: string) => ({
      authorization: `DPoP ${caller.token}`,
      dpop: await makeProof(caller.key, {
        htm: 'POST',
        htu: `${TEST_ORIGIN}${SYNC_SERVICE_PATH}/${method}`,
        accessToken: caller.token,
        nonce: caller.nonce!,
      }),
    });

    const onHeader = (h: Headers) => {
      caller.nonce = h.get('dpop-nonce') ?? caller.nonce;
    };
    const now = await client.status(create(StatusRequestSchema), { headers: await headers('Status'), onHeader });
    expect(isCanonicalVersion(now.serverNowIso)).toBe(true);
    const pushed = await client.push(
      create(PushRequestSchema, { clientId: randomUUID(), events: [upsert(userFacetKey(randomUUID(), 'score'), mint(caller), JSON.stringify({ score: 6, ...DISPLAY }))] }),
      { headers: await headers('Push'), onHeader },
    );
    expect(pushed.results[0]!.outcome).toBe(PushOutcome.APPLIED);
  });
});
