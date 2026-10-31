// SyncEvent.origin_trace (fc-api-contract 0.7.0) through the real app on a real database: not part
// of replay identity in either wire format, never stored, never echoed, never a REJECTED reason.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { create, fromBinary, fromJsonString, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import {
  DeltaRequestSchema,
  DeltaResponseSchema,
  MAX_FUTURE_SKEW_MS,
  PushOutcome,
  PushRequestSchema,
  PushResponseSchema,
  SyncOp,
  canonicalVersion,
  occFacetKey,
  ufFacetKey,
  type PushResponse,
} from '@figurecollecting/fc-api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HoldPolicy } from '../../src/sync/service.js';
import { DISPLAY, startSyncApp, SyncCaller, type SyncApp } from '../helpers/syncClient.js';
import { startSyncDatabase, type SyncDatabase } from '../helpers/syncDatabase.js';

let db: SyncDatabase;
let h: SyncApp;

/** Keys the stand-in hold policy holds (import.proto HELD), so a Push can be answered HELD. */
const holdKeys = new Set<string>();
const holdListed: HoldPolicy = async (_tx, _userId, edits) =>
  new Map(edits.filter((edit) => holdKeys.has(edit.facetKey)).map((edit) => [edit.index, 'held' as const]));

beforeAll(async () => {
  db = await startSyncDatabase();
  h = await startSyncApp(db.app, undefined, undefined, holdListed);
}, 240_000);

afterAll(async () => {
  await h?.close();
  await db?.close();
});

type PushInit = MessageInitShape<typeof PushRequestSchema>;
type Format = 'json' | 'binary';
type Answer = { ok: true; message: PushResponse; body: Buffer } | { ok: false; code: string; message: string };

const status = (s: string) => JSON.stringify({ status: s, ...DISPLAY });
const score = (n: number) => JSON.stringify({ score: n, ...DISPLAY });
const upsert = (facetKey: string, version: string, payload: string) => ({ facetKey, version, op: SyncOp.UPSERT, payload, basis: '' });
const mint = (caller: SyncCaller, offsetMs = -60_000, counter = 0) =>
  canonicalVersion({ instant: new Date(Date.now() + offsetMs), counter, deviceId: caller.deviceId });
const traceId = () => randomBytes(16).toString('hex');

interface EventInit {
  facetKey: string;
  version: string;
  op: SyncOp;
  payload: string;
  basis?: string;
  originTrace?: string;
}

/** `batch` with origin_trace set to `trace` on every event, or on none when `trace` is undefined. */
function tracing(batch: { clientId: string; events: EventInit[] }, trace: string | undefined): PushInit {
  return { ...batch, events: batch.events.map(({ originTrace: _dropped, ...rest }) => (trace === undefined ? rest : { ...rest, originTrace: trace })) };
}

/** One Push over either Connect wire format, with the raw body of a success. */
async function push(caller: SyncCaller, format: Format, init: PushInit): Promise<Answer> {
  if (format === 'json') {
    const rpc = await caller.push(init);
    return rpc.ok ? { ok: true, message: rpc.message, body: rpc.raw.rawPayload } : { ok: false, code: rpc.code, message: rpc.message };
  }
  const raw = await caller.send('Push', Buffer.from(toBinary(PushRequestSchema, create(PushRequestSchema, init))), true);
  if (raw.statusCode === 200) return { ok: true, message: fromBinary(PushResponseSchema, raw.rawPayload), body: raw.rawPayload };
  const err = raw.json() as { code?: string; message?: string };
  return { ok: false, code: err.code ?? '', message: err.message ?? '' };
}

function answered(answer: Answer): PushResponse {
  if (!answer.ok) throw new Error(`push failed: ${answer.code} ${answer.message}`);
  return answer.message;
}

async function feedCount(userId: string): Promise<number> {
  const { rows } = await db.admin.query<{ n: string }>('SELECT count(*) AS n FROM feed_event WHERE user_id = $1', [userId]);
  return Number(rows[0]!.n);
}

/** Every table, and every bytea column, of the app's schema that holds `value` anywhere. */
async function holders(value: string): Promise<string[]> {
  const found: string[] = [];
  const { rows: tables } = await db.admin.query<{ name: string }>(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['feed_event', 'facet_state', 'held_edit', 'mutation_receipt']));
  for (const { name } of tables) {
    const { rows } = await db.admin.query<{ n: string }>(`SELECT count(*) AS n FROM "${name}" t WHERE strpos(row_to_json(t)::text, $1) > 0`, [value]);
    if (Number(rows[0]!.n) > 0) found.push(name);
  }
  const { rows: blobs } = await db.admin.query<{ t: string; c: string }>(
    "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'bytea'",
  );
  for (const { t, c } of blobs) {
    const { rows } = await db.admin.query<{ n: string }>(`SELECT count(*) AS n FROM "${t}" WHERE position(convert_to($1, 'UTF8') IN "${c}") > 0`, [value]);
    if (Number(rows[0]!.n) > 0) found.push(`${t}.${c}`);
  }
  return found;
}

describe('the replay identity of a Push: origin_trace is cleared before the batch is hashed', () => {
  const T1 = traceId();
  const T2 = traceId();
  // first and retry: [wire format, origin_trace]; undefined is an app built before 0.7.0.
  const cases: [string, [Format, string | undefined], [Format, string | undefined]][] = [
    ['an old app, then the update (JSON)', ['json', undefined], ['json', T1]],
    ['the update, then a rollback (JSON)', ['json', T1], ['json', undefined]],
    ['another id on the retry (JSON)', ['json', T1], ['json', T2]],
    ['a malformed id on the retry (JSON)', ['json', T1], ['json', 'zz']],
    ['the update, then a rollback (binary)', ['binary', T1], ['binary', undefined]],
    ['an old app, then the update (binary)', ['binary', undefined], ['binary', T2]],
    ['another id on the retry (binary)', ['binary', T1], ['binary', T2]],
    ['JSON first, binary on the retry', ['json', T1], ['binary', '']],
    ['binary first, JSON on the retry', ['binary', 'zz'], ['json', T2]],
  ];

  it.each(cases)('replays the same events under the same client_id: %s', async (_name, [firstFormat, firstTrace], [retryFormat, retryTrace]) => {
    const caller = await SyncCaller.enrol(h);
    const batch = {
      clientId: randomUUID(),
      events: [upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, 1), status('owned')), upsert(ufFacetKey(randomUUID(), 'score'), mint(caller, -60_000, 2), score(3))],
    };
    const first = answered(await push(caller, firstFormat, tracing(batch, firstTrace)));
    expect(first.results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.APPLIED]);

    const retry = answered(await push(caller, retryFormat, tracing(batch, retryTrace)));
    expect(retry.results.map((r) => r.outcome)).toEqual([PushOutcome.DUPLICATE, PushOutcome.DUPLICATE]);
    expect(retry.results.map((r) => r.current)).toEqual(first.results.map((r) => r.current));
    expect(await feedCount(caller.userId)).toBe(2);
  });

  it.each(['json', 'binary'] as const)('still refuses the same client_id with different events, origin_trace or not (%s)', async (format) => {
    const caller = await SyncCaller.enrol(h);
    const key = occFacetKey(randomUUID(), 'status');
    const clientId = randomUUID();
    const T = traceId();
    answered(await push(caller, format, tracing({ clientId, events: [upsert(key, mint(caller, -60_000), status('owned'))] }, T)));

    for (const trace of [T, undefined, traceId()]) {
      const reused = await push(caller, format, tracing({ clientId, events: [upsert(key, mint(caller, -30_000), status('wished'))] }, trace));
      expect(reused).toMatchObject({ ok: false, code: 'invalid_argument', message: expect.stringContaining('client_id was already used for a different batch') });
    }
    expect(await feedCount(caller.userId)).toBe(1);
  });

  it('records a batch that carries origin_trace under the hash of the batch without it', async () => {
    const caller = await SyncCaller.enrol(h);
    const batch = { clientId: randomUUID(), events: [upsert(occFacetKey(randomUUID(), 'status'), mint(caller), status('owned'))] };
    answered(await push(caller, 'binary', tracing(batch, traceId())));

    const { rows } = await db.admin.query<{ request_sha256: Buffer }>('SELECT request_sha256 FROM mutation_receipt WHERE user_id = $1 AND client_id = $2', [
      caller.userId,
      batch.clientId,
    ]);
    const without = createHash('sha256').update(toBinary(PushRequestSchema, create(PushRequestSchema, batch))).digest();
    expect(rows[0]!.request_sha256.equals(without)).toBe(true);
  });

  it('matches a receipt recorded before 0.7.0, whose hash never saw the field, when the retry carries it', async () => {
    const caller = await SyncCaller.enrol(h);
    const key = occFacetKey(randomUUID(), 'status');
    const batch = { clientId: randomUUID(), events: [upsert(key, mint(caller), status('owned'))] };
    // What a 0.6.0 server wrote: sha256 of the request as it decoded it, and each first outcome.
    const preUpgradeSha256 = createHash('sha256').update(toBinary(PushRequestSchema, create(PushRequestSchema, batch))).digest();
    const outcomes = toBinary(PushResponseSchema, create(PushResponseSchema, { results: [{ facetKey: key, outcome: PushOutcome.APPLIED, reason: '' }] }));
    await db.admin.query('INSERT INTO mutation_receipt (user_id, client_id, request_sha256, outcomes) VALUES ($1, $2, $3, $4)', [
      caller.userId,
      batch.clientId,
      preUpgradeSha256,
      Buffer.from(outcomes),
    ]);

    for (const format of ['json', 'binary'] as const) {
      const retry = answered(await push(caller, format, tracing(batch, traceId())));
      expect(retry.results.map((r) => r.outcome)).toEqual([PushOutcome.DUPLICATE]);
    }
    expect(await feedCount(caller.userId)).toBe(0);
  });
});

describe('origin_trace is never stored and never echoed', () => {
  /** One Push answered APPLIED, STALE, REJECTED with `current`, and HELD, each event carrying `trace`. */
  async function everyOutcome(caller: SyncCaller, format: Format, trace: string) {
    // Both keys hold a value first, so STALE, REJECTED and HELD each answer with `current`.
    const staleKey = ufFacetKey(randomUUID(), 'score');
    const heldKey = occFacetKey(randomUUID(), 'status');
    const bases = [upsert(staleKey, mint(caller, -30_000, 9), score(4)), upsert(heldKey, mint(caller, -120_000, 8), status('owned'))];
    answered(await push(caller, format, { clientId: randomUUID(), events: bases }));
    holdKeys.add(heldKey);
    const batch = tracing(
      {
        clientId: randomUUID(),
        events: [
          upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, 1), status('owned')),
          upsert(staleKey, mint(caller, -90_000, 2), score(2)),
          upsert(staleKey, mint(caller, MAX_FUTURE_SKEW_MS + 60_000, 3), score(8)),
          upsert(heldKey, mint(caller, -60_000, 4), status('wished')),
        ],
      },
      trace,
    );
    const first = await push(caller, format, batch);
    expect(answered(first).results.map((r) => r.outcome)).toEqual([PushOutcome.APPLIED, PushOutcome.STALE, PushOutcome.REJECTED, PushOutcome.HELD]);
    return { batch, first };
  }

  /** No result, and no `current`, carries the field, and the raw body never holds its value. */
  function echoesNothing(answer: Answer, trace: string) {
    const response = answered(answer);
    expect(response.results.filter((r) => r.current !== undefined)).toHaveLength(4);
    for (const r of response.results) expect(r.current?.originTrace).toBeUndefined();
    expect(answer.ok && answer.body.includes(trace)).toBe(false);
    expect(answer.ok && answer.body.includes('originTrace')).toBe(false);
  }

  it.each(['json', 'binary'] as const)('keeps it in no table and answers no Push or replay with it (%s)', async (format) => {
    const caller = await SyncCaller.enrol(h);
    const T = traceId();
    const { batch, first } = await everyOutcome(caller, format, T);
    echoesNothing(first, T);

    const replay = await push(caller, format, batch);
    expect(answered(replay).results.map((r) => r.outcome)).toEqual([PushOutcome.DUPLICATE, PushOutcome.STALE, PushOutcome.REJECTED, PushOutcome.HELD]);
    echoesNothing(replay, T);

    expect(await holders(T)).toEqual([]);
  });

  it.each(['json', 'binary'] as const)('sends no Delta event with it (%s)', async (format) => {
    const caller = await SyncCaller.enrol(h);
    const T = traceId();
    await everyOutcome(caller, format, T);

    const body = toBinary(DeltaRequestSchema, create(DeltaRequestSchema, {}));
    const raw = format === 'json' ? await caller.send('Delta', '{}') : await caller.send('Delta', Buffer.from(body), true);
    expect(raw.statusCode).toBe(200);
    const delta = format === 'json' ? fromJsonString(DeltaResponseSchema, raw.body) : fromBinary(DeltaResponseSchema, raw.rawPayload);
    expect(delta.events.length).toBeGreaterThanOrEqual(3);
    for (const event of delta.events) expect(event.originTrace).toBeUndefined();
    expect(raw.rawPayload.includes(T)).toBe(false);
    expect(raw.rawPayload.includes('originTrace')).toBe(false);
  });
});

describe('origin_trace is never a REJECTED reason', () => {
  const MALFORMED = ['zz', '', '4BF92F3577B34DA6A3CE929D0E0E4736', '0'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(31)}g`, 'é'.repeat(32), 'x'.repeat(10_000)];

  it('places an edit whatever its origin_trace: a malformed one is ignored', async () => {
    const caller = await SyncCaller.enrol(h);
    const traces = [undefined, traceId(), ...MALFORMED];
    for (const format of ['json', 'binary'] as const) {
      const events = traces.map((trace, i) => ({
        ...upsert(occFacetKey(randomUUID(), 'status'), mint(caller, -60_000, i), status('owned')),
        ...(trace !== undefined ? { originTrace: trace } : {}),
      }));
      const res = answered(await push(caller, format, { clientId: randomUUID(), events }));
      expect(res.results.map((r) => [r.outcome, r.reason])).toEqual(traces.map(() => [PushOutcome.APPLIED, '']));
    }
  });

  it('answers each REJECTED check, in its order, with the reason it gives without origin_trace', async () => {
    const caller = await SyncCaller.enrol(h);
    const other = await SyncCaller.enrol(h);
    const key = ufFacetKey(randomUUID(), 'score');
    // One event per check that fails it first (sync.proto PushOutcome REJECTED, in order).
    const failing = [
      upsert(key, 'not a version', score(1)),
      upsert(key, mint(caller, MAX_FUTURE_SKEW_MS + 60_000), score(1)),
      upsert(`identity/${randomUUID()}`, mint(caller), '{}'),
      upsert(key, mint(other), score(1)),
      upsert(key, mint(caller), '{"score":"not a number"}'),
      { ...upsert(key, mint(caller), score(1)), basis: undefined },
      { ...upsert(key, mint(caller), score(1)), basis: 'not a cursor' },
      // Fails two checks: the earlier one names it.
      upsert(`identity/${randomUUID()}`, mint(caller, MAX_FUTURE_SKEW_MS + 60_000), '{}'),
    ];
    const reasons = (res: PushResponse) => res.results.map((r) => [r.outcome, r.reason]);
    const plain = reasons(answered(await push(caller, 'json', { clientId: randomUUID(), events: failing })));
    expect(plain.map(([outcome, reason]) => [outcome, String(reason).split(':')[0]])).toEqual(
      [
        'version_malformed',
        'version_future',
        'facet_key_not_user_owned',
        'device_mismatch',
        'payload_invalid',
        'basis_missing',
        'basis_missing',
        'version_future',
      ].map((code) => [PushOutcome.REJECTED, code]),
    );
    for (const trace of [traceId(), ...MALFORMED]) {
      expect(reasons(answered(await push(caller, 'json', tracing({ clientId: randomUUID(), events: failing }, trace))))).toEqual(plain);
    }
  });
});
