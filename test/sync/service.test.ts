// SyncService acceptance through the real Fastify app: the OIDC + DPoP edge, enrolled devices
// in a real database, and every call signed with the repo's makeProof helper.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { create } from '@bufbuild/protobuf';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import {
  MAX_FUTURE_SKEW_MS,
  PushOutcome,
  PushRequestSchema,
  SERVER_DEVICE_ID,
  StatusRequestSchema,
  SyncOp,
  SyncService,
  canonicalInstant,
  canonicalVersion,
  isCanonicalVersion,
  parseVersion,
  userFacetKey,
  type SyncEvent,
} from '@figurecollecting/fc-api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeProof, TEST_ORIGIN } from '../helpers/auth.js';
import { DISPLAY, ok, startSyncApp, SyncCaller, SYNC_SERVICE_PATH, type SyncApp } from '../helpers/syncClient.js';
import { startSyncDatabase, type SyncDatabase } from '../helpers/syncDatabase.js';

let db: SyncDatabase;
let h: SyncApp;

beforeAll(async () => {
  db = await startSyncDatabase();
  h = await startSyncApp(db.app);
}, 240_000);

afterAll(async () => {
  await h?.close();
  await db?.close();
});

const status = (s: string) => JSON.stringify({ status: s, ...DISPLAY });
const note = (n: string) => JSON.stringify({ note: n, ...DISPLAY });

/** A version for `caller`, `offsetMs` from now, with `counter`. */
function mint(caller: SyncCaller, counter = 0, offsetMs = -60_000): string {
  return canonicalVersion({ instant: new Date(Date.now() + offsetMs), counter, deviceId: caller.deviceId });
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
  it('(3) replays a client_id as DUPLICATE with the byte-identical stored response and one feed_event', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = userFacetKey(randomUUID(), 'status');
    const batch = { clientId: randomUUID(), events: [upsert(key, mint(caller), status('owned'))] };

    const first = await caller.pushBinary(batch);
    expect(first.message.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED]);

    const replay = await caller.pushBinary(batch);
    const stored = await db.admin.query<{ response: Buffer }>(
      'SELECT response FROM mutation_receipt WHERE user_id = $1 AND client_id = $2',
      [caller.userId, batch.clientId],
    );
    expect(replay.bytes.equals(stored.rows[0]!.response)).toBe(true);
    expect((await caller.pushBinary(batch)).bytes.equals(replay.bytes)).toBe(true);

    expect(replay.message.results.map((r) => r.outcome)).toEqual([PushOutcome.DUPLICATE]);
    expect(replay.message.results[0]!.current).toEqual(first.message.results[0]!.current);
    expect(await feedCount(caller.userId)).toBe(1);

    const json = ok(await caller.push(batch));
    expect(json.results.map((r) => r.outcome)).toEqual([PushOutcome.DUPLICATE]);
    expect(await feedCount(caller.userId)).toBe(1);
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
    const newer = mint(caller, 5);
    const older = mint(caller, 4);
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
    const res = ok(
      await caller.push({
        clientId: randomUUID(),
        events: [upsert(key, mint(caller, 1), status('ordered')), upsert(key, mint(caller, 2), status('owned')), upsert(key, mint(caller, 0), status('wished'))],
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

  it('refuses an empty client_id with INVALID_ARGUMENT', async () => {
    const caller = await SyncCaller.enrol(h);
    const res = await caller.push({ clientId: '', events: [upsert(userFacetKey(randomUUID(), 'score'), mint(caller), JSON.stringify({ score: 3, ...DISPLAY }))] });
    expect(res).toMatchObject({ ok: false, code: 'invalid_argument' });
    expect(await feedCount(caller.userId)).toBe(0);
  });

  it('keys receipts per user: another user may reuse a client_id', async () => {
    const a = await SyncCaller.enrol(h);
    const b = await SyncCaller.enrol(h);
    const clientId = randomUUID();
    ok(await a.push({ clientId, events: [upsert(userFacetKey(randomUUID(), 'score'), mint(a), JSON.stringify({ score: 3, ...DISPLAY }))] }));
    const res = ok(await b.push({ clientId, events: [upsert(userFacetKey(randomUUID(), 'score'), mint(b), JSON.stringify({ score: 4, ...DISPLAY }))] }));
    expect(res.results[0]!.outcome).toBe(PushOutcome.APPLIED);
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

describe('(2) commit order: a Delta reader never skips a late-committing lower seq', () => {
  async function waiting(event: string, statement: string): Promise<boolean> {
    const { rows } = await db.admin.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE usename = 'coordinator' AND wait_event_type = 'Lock' AND wait_event = $1 AND query LIKE $2`,
      [event, `${statement}%`],
    );
    return rows.length > 0;
  }

  async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 500; i += 1) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  it('holds the second writer until the first commits', async () => {
    const caller = await SyncCaller.enrol(h);
    const sibling = await SyncCaller.sibling(h, caller);
    const reader = await SyncCaller.sibling(h, caller);
    const k1 = userFacetKey(randomUUID(), 'status');
    const k2 = userFacetKey(randomUUID(), 'status');
    const firstId = randomUUID();

    // Park the first Push after it has taken its seq: its receipt INSERT waits on this row.
    const blocker = await db.admin.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      "INSERT INTO mutation_receipt (user_id, client_id, request_sha256, response) VALUES ($1, $2, sha256('x'), '')",
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
