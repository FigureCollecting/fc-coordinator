// The sync log seam (LGMOB C2a) through the real app on a real database: one sync.push line per
// Push, written only once its transaction has committed, carrying the request's trace, the
// outcome counts and replay, and nothing the client sent.
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
import { SYNC_LOG_FIELDS } from '../../src/sync/pushLog.js';
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
    ok(await caller.push({ clientId: randomUUID(), events: [upsert(occFacetKey(randomUUID(), 'status'), mint(caller), status('owned'))] }));
    await caller.push({ clientId: '', events: [] });
    const lines: LogLine[] = log.sync(mark);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      for (const field of Object.keys(line)) expect(LOGGER_FIELDS.has(field) || SYNC_LOG_FIELDS.has(field)).toBe(true);
    }
  });
});
