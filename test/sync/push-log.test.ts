// The sync log seam (LGMOB C2a) through the real app on a real database: one sync.push line per
// Push, written only once its transaction has committed, carrying the request's trace, the
// outcome counts and replay, and nothing the client sent. LGMOB C2b adds what the server measures
// of a placed Push on that same line: each event's age bucket, the oldest, and resend_stale.
import { randomBytes, randomUUID } from 'node:crypto';
import {
  MAX_FUTURE_SKEW_MS,
  PushOutcome,
  SyncOp,
  canonicalVersion,
  normaliseDeviceId,
  occFacetKey,
  ufFacetKey,
} from '@figurecollecting/fc-api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { AGE_BUCKETS, SYNC_LOG_FIELDS } from '../../src/sync/pushLog.js';
import type { HoldPolicy } from '../../src/sync/service.js';
import { DISPLAY, ok, startSyncApp, SyncCaller, type SyncApp } from '../helpers/syncClient.js';
import { startSyncDatabase, type SyncDatabase } from '../helpers/syncDatabase.js';
import { CapturedLog, LOGGER_FIELDS, traceIdOf, type LogLine } from '../helpers/syncLog.js';

let telemetry: Telemetry;
let db: SyncDatabase;
let h: SyncApp;
const log = new CapturedLog();

/** Keys the stand-in hold policy holds (import.proto HELD), so a Push can be answered HELD. */
const holdKeys = new Set<string>();
const holdListed: HoldPolicy = async (_tx, _userId, edits) =>
  new Map(edits.filter((edit) => holdKeys.has(edit.facetKey)).map((edit) => [edit.index, 'held' as const]));

beforeAll(async () => {
  telemetry = startTelemetry({ env: {}, serviceName: 'fc-coordinator-test' });
  db = await startSyncDatabase();
  h = await startSyncApp(db.app, undefined, undefined, holdListed, {}, log.sink);
}, 240_000);

afterAll(async () => {
  await h?.close();
  await db?.close();
  await telemetry?.shutdown();
});

const status = (s: string) => JSON.stringify({ status: s, ...DISPLAY });
const note = (n: string) => JSON.stringify({ note: n, ...DISPLAY });
const upsert = (facetKey: string, version: string, payload: string) => ({ facetKey, version, op: SyncOp.UPSERT, payload, basis: '' });
const mint = (caller: SyncCaller, offsetMs = -60_000, counter = 0) =>
  canonicalVersion({ instant: new Date(Date.now() + offsetMs), counter, deviceId: caller.deviceId });

/** A fresh W3C trace for one request: its trace id, and the header that carries it. */
function trace(): { traceId: string; traceparent: string } {
  const traceId = randomBytes(16).toString('hex');
  return { traceId, traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` };
}

async function feedCount(userId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>('SELECT count(*) AS n FROM feed_event WHERE user_id = $1', [userId]);
  return Number(rows[0]!.n);
}

/** Fail the receipt write of one client_id, now or at COMMIT, until the returned function drops it. */
async function failReceipt(clientId: string, at: 'insert' | 'commit'): Promise<() => Promise<void>> {
  const name = `fail_receipt_${randomBytes(4).toString('hex')}`;
  await db.admin.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by the test'; END $$`);
  const when = `WHEN (NEW.client_id = '${clientId}') EXECUTE FUNCTION ${name}()`;
  await db.admin.query(
    at === 'insert'
      ? `CREATE TRIGGER ${name} BEFORE INSERT ON mutation_receipt FOR EACH ROW ${when}`
      : `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT ON mutation_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW ${when}`,
  );
  return async () => {
    await db.admin.query(`DROP TRIGGER ${name} ON mutation_receipt`);
    await db.admin.query(`DROP FUNCTION ${name}()`);
  };
}

describe('the sync.push line', () => {
  it('is one line per Push, with the outcome counts and the trace of the request it answered', async () => {
    const caller = await SyncCaller.enrol(h);
    const staleKey = ufFacetKey(randomUUID(), 'score');
    ok(await caller.push({ clientId: randomUUID(), events: [upsert(staleKey, mint(caller, -30_000), JSON.stringify({ score: 4, ...DISPLAY }))] }));
    const heldKey = occFacetKey(randomUUID(), 'status');
    holdKeys.add(heldKey);

    const { traceId, traceparent } = trace();
    caller.headers = { traceparent };
    const mark = log.mark();
    const res = ok(
      await caller.push({
        clientId: randomUUID(),
        events: [
          upsert(occFacetKey(randomUUID(), 'status'), mint(caller), status('owned')),
          upsert(staleKey, mint(caller, -90_000), JSON.stringify({ score: 2, ...DISPLAY })),
          upsert(ufFacetKey(randomUUID(), 'score'), mint(caller, MAX_FUTURE_SKEW_MS + 60_000), JSON.stringify({ score: 8, ...DISPLAY })),
          upsert(heldKey, mint(caller), status('wished')),
        ],
      }),
    );
    expect(res.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.STALE, PushOutcome.REJECTED, PushOutcome.HELD]);

    // One line for the Push, never one per event.
    const lines = log.sync(mark);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      msg: 'sync.push',
      outcome: 'ok',
      replay: false,
      events: 4,
      applied: 1,
      duplicate: 0,
      stale: 1,
      rejected: 1,
      held: 1,
      reasons: { version_future: 1 },
    });
    expect(traceIdOf(lines[0]!)).toBe(traceId);
  });

  it('marks a resend of a client_id replay=true and counts what the replay answered', async () => {
    const caller = await SyncCaller.enrol(h);
    const batch = {
      clientId: randomUUID(),
      events: [
        upsert(occFacetKey(randomUUID(), 'status'), mint(caller), status('owned')),
        upsert(ufFacetKey(randomUUID(), 'score'), mint(caller, MAX_FUTURE_SKEW_MS + 60_000), JSON.stringify({ score: 8, ...DISPLAY })),
      ],
    };
    ok(await caller.push(batch));

    const { traceId, traceparent } = trace();
    caller.headers = { traceparent };
    const mark = log.mark();
    const replay = ok(await caller.push(batch));
    expect(replay.results.map((r) => r.outcome)).toEqual([PushOutcome.DUPLICATE, PushOutcome.REJECTED]);

    const lines = log.sync(mark);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'sync.push', outcome: 'ok', replay: true, events: 2, applied: 0, duplicate: 1, rejected: 1, reasons: { version_future: 1 } });
    expect(traceIdOf(lines[0]!)).toBe(traceId);
    expect(await feedCount(caller.userId)).toBe(1);
  });

  it('names the code of a Push that is refused, and is not a replay', async () => {
    const caller = await SyncCaller.enrol(h);
    const clientId = randomUUID();
    const key = occFacetKey(randomUUID(), 'status');
    ok(await caller.push({ clientId, events: [upsert(key, mint(caller, -60_000), status('owned'))] }));

    const mark = log.mark();
    const reused = await caller.push({ clientId, events: [upsert(key, mint(caller, -30_000), status('wished'))] });
    expect(reused).toMatchObject({ ok: false, code: 'invalid_argument' });
    const malformed = await caller.push({ clientId: 'a client id', events: [] });
    expect(malformed).toMatchObject({ ok: false, code: 'invalid_argument' });

    const lines = log.sync(mark);
    expect(lines).toEqual([
      expect.objectContaining({ level: 'warn', msg: 'sync.push', outcome: 'error', code: 'invalid_argument', events: 1 }),
      expect.objectContaining({ level: 'warn', msg: 'sync.push', outcome: 'error', code: 'invalid_argument', events: 0 }),
    ]);
    for (const line of lines) {
      expect(line).not.toHaveProperty('replay');
      expect(line).not.toHaveProperty('applied');
    }
  });
});

const HOUR_MS = 3_600_000;

describe('the sync delay on the sync.push line', () => {
  it('counts each event by the age of its version, names the oldest, labelled as read from the version, with the request\'s trace', async () => {
    const caller = await SyncCaller.enrol(h);
    const { traceId, traceparent } = trace();
    caller.headers = { traceparent };
    const mark = log.mark();
    const res = ok(
      await caller.push({
        clientId: randomUUID(),
        events: [
          upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -3 * HOUR_MS), status('owned')),
          upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -30_000), status('owned')),
          // A phone whose clock runs 2 s ahead: within its offset error, so not ahead.
          upsert(occFacetKey(randomUUID(), 'status'), mint(caller, 2_000), status('owned')),
          upsert(ufFacetKey(randomUUID(), 'score'), mint(caller, MAX_FUTURE_SKEW_MS + 60_000), JSON.stringify({ score: 8, ...DISPLAY })),
          upsert(occFacetKey(randomUUID(), 'status'), 'not a version', status('owned')),
        ],
      }),
    );
    expect(res.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.APPLIED, PushOutcome.APPLIED, PushOutcome.REJECTED, PushOutcome.REJECTED]);

    const lines = log.sync(mark);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'sync.push',
      events: 5,
      reasons: { version_future: 1, version_malformed: 1 },
      age_basis: 'version',
      // The version_future reject is aged ahead; the malformed version is not aged.
      ages: { '<6h': 1, '<1m': 1, '<10s': 1, ahead: 1 },
      oldest_age: '<6h',
      resend_stale: 0,
    });
    expect(Object.keys(lines[0]!['ages'] as object).sort()).toEqual(['<10s', '<1m', '<6h', 'ahead']);
    expect(traceIdOf(lines[0]!)).toBe(traceId);
  });

  it('ages nothing on a replay: its edits arrived with the Push it repeats', async () => {
    const caller = await SyncCaller.enrol(h);
    const batch = { clientId: randomUUID(), events: [upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -3 * HOUR_MS), status('owned'))] };
    const mark = log.mark();
    ok(await caller.push(batch));
    ok(await caller.push(batch));

    const lines = log.sync(mark);
    expect(lines).toEqual([
      expect.objectContaining({ replay: false, age_basis: 'version', ages: { '<6h': 1 }, oldest_age: '<6h', resend_stale: 0 }),
      expect.objectContaining({ replay: true, duplicate: 1, age_basis: 'version', ages: {}, oldest_age: 'none', resend_stale: 0 }),
    ]);
  });

  it('carries no age on a Push that failed: its edits are aged when a retry places them', async () => {
    const caller = await SyncCaller.enrol(h);
    const mark = log.mark();
    await caller.push({ clientId: 'a client id', events: [upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -3 * HOUR_MS), status('owned'))] });
    const lines = log.sync(mark);
    expect(lines).toEqual([expect.objectContaining({ outcome: 'error', events: 1 })]);
    for (const field of ['age_basis', 'ages', 'oldest_age', 'resend_stale']) expect(lines[0]).not.toHaveProperty(field);
  });

  it('is only ever a bucket name and a count, never a delay or an instant', async () => {
    const caller = await SyncCaller.enrol(h);
    const versions = [mint(caller, -3 * HOUR_MS - 4_321), mint(caller, -26 * HOUR_MS)];
    const mark = log.mark();
    ok(await caller.push({ clientId: randomUUID(), events: versions.map((v) => upsert(occFacetKey(randomUUID(), 'status'), v, status('owned'))) }));

    const [line] = log.sync(mark);
    expect(AGE_BUCKETS).toContain(line!['oldest_age']);
    for (const [bucket, count] of Object.entries(line!['ages'] as Record<string, unknown>)) {
      expect(AGE_BUCKETS).toContain(bucket);
      expect(Number.isInteger(count)).toBe(true);
    }
    const own = JSON.stringify(Object.fromEntries(Object.entries(line!).filter(([field]) => !LOGGER_FIELDS.has(field))));
    expect(own).not.toMatch(/\d{4}-\d{2}-\d{2}T|\d{5,}/);
  });
});

describe('resend_stale on the sync.push line, a client-bug detector that should read 0', () => {
  it('counts an identical edit sent again under a new client_id, and not an edit merely older than the stored one', async () => {
    const caller = await SyncCaller.enrol(h);
    const resent = upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000), status('owned'));
    const olderKey = occFacetKey(randomUUID(), 'status');
    ok(await caller.push({ clientId: randomUUID(), events: [resent, upsert(olderKey, mint(caller, -30_000), status('owned'))] }));

    const mark = log.mark();
    const res = ok(await caller.push({ clientId: randomUUID(), events: [resent, upsert(olderKey, mint(caller, -90_000), status('wished'))] }));
    expect(res.results.map((r) => r.outcome)).toEqual([PushOutcome.STALE, PushOutcome.STALE]);
    expect(log.sync(mark)).toEqual([expect.objectContaining({ replay: false, stale: 2, resend_stale: 1 })]);
  });

  it('counts the same edit twice in one batch', async () => {
    const caller = await SyncCaller.enrol(h);
    const twice = upsert(occFacetKey(randomUUID(), 'status'), mint(caller), status('owned'));
    const mark = log.mark();
    const res = ok(await caller.push({ clientId: randomUUID(), events: [twice, twice] }));
    expect(res.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.STALE]);
    expect(log.sync(mark)).toEqual([expect.objectContaining({ applied: 1, stale: 1, resend_stale: 1 })]);
  });

  it('reads 0 on the ordinary resend, the same batch under its own client_id: that is replay=true', async () => {
    const caller = await SyncCaller.enrol(h);
    const batch = { clientId: randomUUID(), events: [upsert(occFacetKey(randomUUID(), 'status'), mint(caller), status('owned'))] };
    ok(await caller.push(batch));
    const mark = log.mark();
    ok(await caller.push(batch));
    expect(log.sync(mark)).toEqual([expect.objectContaining({ replay: true, duplicate: 1, resend_stale: 0 })]);
  });
});

describe('the origin_trace on the sync.push line (fc-api-contract 0.7.0)', () => {
  const traceIdNew = () => randomBytes(16).toString('hex');

  it('lists each action\'s origin_trace beside the request\'s trace, so the 09:00 action joins the 15:00 Push', async () => {
    const caller = await SyncCaller.enrol(h);
    const [actionA, actionB] = [traceIdNew(), traceIdNew()];
    const canary = `zz-${randomUUID()}`;
    const { traceId, traceparent } = trace();
    caller.headers = { traceparent };
    const mark = log.mark();
    ok(
      await caller.push({
        clientId: randomUUID(),
        events: [
          { ...upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, 1), status('owned')), originTrace: actionA },
          { ...upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, 2), status('owned')), originTrace: actionA },
          { ...upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, 3), status('wished')), originTrace: actionB },
          upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, 4), status('owned')),
          { ...upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, 5), status('owned')), originTrace: canary },
        ],
      }),
    );

    const lines = log.sync(mark);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'sync.push',
      outcome: 'ok',
      events: 5,
      applied: 5,
      origin_trace: [actionA, actionB],
      origin_trace_more: 0,
      origin_trace_malformed: 1,
      origin_trace_absent: 1,
    });
    expect(traceIdOf(lines[0]!)).toBe(traceId);
    expect(log.raw.slice(mark).join('\n')).not.toContain(canary);
  });

  it('never writes a malformed value, whatever its length, and never one per event', async () => {
    const caller = await SyncCaller.enrol(h);
    const malformed = [`canary-${randomUUID()}`, traceIdNew().toUpperCase(), `${traceIdNew()}0`, `x${randomUUID()}`.repeat(300)];
    const mark = log.mark();
    ok(
      await caller.push({
        clientId: randomUUID(),
        events: malformed.map((originTrace, i) => ({ ...upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, i), status('owned')), originTrace })),
      }),
    );
    const lines = log.sync(mark);
    expect(lines).toEqual([expect.objectContaining({ msg: 'sync.push', events: 4, origin_trace: [], origin_trace_malformed: 4, origin_trace_absent: 0 })]);
    const text = log.raw.slice(mark).join('\n');
    for (const value of malformed) expect(text).not.toContain(value.slice(0, 33));
  });

  it(`lists at most 20 actions and counts the rest`, async () => {
    const caller = await SyncCaller.enrol(h);
    const actions = Array.from({ length: 23 }, traceIdNew);
    const mark = log.mark();
    ok(
      await caller.push({
        clientId: randomUUID(),
        events: actions.map((originTrace, i) => ({ ...upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, i), status('owned')), originTrace })),
      }),
    );
    expect(log.sync(mark)).toEqual([expect.objectContaining({ events: 23, origin_trace: actions.slice(0, 20), origin_trace_more: 3 })]);
  });

  it('lists the origin_trace a replay carries, and what a refused Push carried', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = occFacetKey(randomUUID(), 'status');
    const batch = { clientId: randomUUID(), events: [upsert(key, mint(caller), status('owned'))] };
    const [first, retry, refused] = [traceIdNew(), traceIdNew(), traceIdNew()];
    ok(await caller.push({ ...batch, events: [{ ...batch.events[0]!, originTrace: first }] }));

    const mark = log.mark();
    ok(await caller.push({ ...batch, events: [{ ...batch.events[0]!, originTrace: retry }] }));
    ok(await caller.push(batch));
    const reused = await caller.push({ clientId: batch.clientId, events: [{ ...upsert(key, mint(caller, -30_000), status('wished')), originTrace: refused }] });
    expect(reused).toMatchObject({ ok: false, code: 'invalid_argument' });

    expect(log.sync(mark)).toEqual([
      expect.objectContaining({ outcome: 'ok', replay: true, duplicate: 1, origin_trace: [retry], origin_trace_absent: 0 }),
      expect.objectContaining({ outcome: 'ok', replay: true, duplicate: 1, origin_trace: [], origin_trace_absent: 1 }),
      expect.objectContaining({ level: 'warn', outcome: 'error', code: 'invalid_argument', events: 1, origin_trace: [refused], origin_trace_malformed: 0 }),
    ]);
  });
});

describe('a Push whose transaction rolls back', () => {
  // CRITIQUE 3: a line written inside the transaction calls a rolled-back edit applied, and the
  // retry, which finds no receipt, applied a second time instead of replay=true.
  it.each(['insert', 'commit'] as const)('logs nothing as placed when the receipt fails at %s, and its retry is placed once', async (at) => {
    const caller = await SyncCaller.enrol(h);
    const batch = { clientId: randomUUID(), events: [upsert(occFacetKey(randomUUID(), 'status'), mint(caller), status('owned'))] };
    const drop = await failReceipt(batch.clientId, at);
    const mark = log.mark();
    try {
      const failed = await caller.push(batch);
      expect(failed).toMatchObject({ ok: false, status: 500, code: 'internal' });
    } finally {
      await drop();
    }
    expect(await feedCount(caller.userId)).toBe(0);
    expect(log.sync(mark)).toEqual([expect.objectContaining({ level: 'warn', msg: 'sync.push', outcome: 'error', code: 'internal', events: 1 })]);

    const retry = ok(await caller.push(batch));
    expect(retry.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED]);
    const lines = log.sync(mark);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ outcome: 'ok', replay: false, applied: 1, duplicate: 0 });
    // As many edits logged applied as the feed holds.
    expect(lines.reduce((sum, line) => sum + (typeof line['applied'] === 'number' ? line['applied'] : 0), 0)).toBe(await feedCount(caller.userId));
  });
});

describe('what a sync line never carries', () => {
  it('carries only allow-listed fields: no sub, device, client_id, key, version, payload or reason detail', async () => {
    const caller = await SyncCaller.enrol(h);
    const canary = `canary-${randomUUID()}`;
    const keys = [ufFacetKey(randomUUID(), 'note'), ufFacetKey(randomUUID(), 'score'), occFacetKey(randomUUID(), 'status')];
    const versions = [mint(caller, -60_000, 1), mint(caller, MAX_FUTURE_SKEW_MS + 60_000, 2), mint(caller, -60_000, 3)];
    const batch = {
      clientId: randomUUID(),
      events: [upsert(keys[0]!, versions[0]!, note(canary)), upsert(keys[1]!, versions[1]!, JSON.stringify({ score: 8, ...DISPLAY })), upsert(keys[2]!, versions[2]!, '{}')],
    };
    const mark = log.mark();
    ok(await caller.push(batch));
    ok(await caller.push(batch));
    await caller.push({ clientId: batch.clientId, events: [upsert(keys[0]!, mint(caller, -30_000), note(canary))] });

    const lines = log.sync(mark);
    expect(lines.map((line) => [line['replay'], line['outcome']])).toEqual([[false, 'ok'], [true, 'ok'], [undefined, 'error']]);
    const text = JSON.stringify(lines);
    for (const value of [caller.userId, caller.deviceId, normaliseDeviceId(caller.deviceId), batch.clientId, canary, ...keys, ...versions]) {
      expect(text).not.toContain(value);
    }
    // The code is kept, its detail is not: a schema error can quote the payload.
    expect(lines[0]).toMatchObject({ reasons: { version_future: 1, payload_invalid: 1 } });
    expect(text).not.toMatch(/later than|must have|required property/);
  });

  it('has only the logger\'s own fields beside the allow-listed ones', async () => {
    const caller = await SyncCaller.enrol(h);
    caller.headers = { traceparent: trace().traceparent };
    const mark = log.mark();
    const events = [{ ...upsert(occFacetKey(randomUUID(), 'status'), mint(caller), status('owned')), originTrace: randomBytes(16).toString('hex') }];
    ok(await caller.push({ clientId: randomUUID(), events }));
    await caller.push({ clientId: '', events });
    const lines: LogLine[] = log.sync(mark);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      for (const field of Object.keys(line)) expect(LOGGER_FIELDS.has(field) || SYNC_LOG_FIELDS.has(field)).toBe(true);
    }
  });
});
