import { create, type MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import {
  PUSH_REJECT_REASONS,
  PushOutcome,
  PushResponseSchema,
  PushResultSchema,
  SyncEventSchema,
  SyncOp,
  canonicalVersion,
  normaliseDeviceId,
  ufFacetKey,
} from '@figurecollecting/fc-api-contract';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AGE_BUCKETS, PUSH_LINE, SYNC_LOG_FIELDS, ageBucket, allowListed, pushErrorLine, pushLine, type Arrival } from './pushLog.js';

const DEVICE = '0f3a5c7e-9b1d-2f4a-6c8e-0b2d4f6a8c0e';
const KEY = ufFacetKey('5d0c9a1e-3b7f-4e2a-9c6d-1f8b0e4a7c35', 'note');
const VERSION = canonicalVersion({ instant: new Date('2026-10-30T09:00:00Z'), counter: 4, deviceId: DEVICE });
const PAYLOAD = JSON.stringify({ note: 'a private note' });

type ResultInit = MessageInitShape<typeof PushResultSchema>;

/** A result as the server answers it, `current` included, so the line has every value it must not copy. */
const result = (outcome: PushOutcome, reason = ''): ResultInit => ({
  facetKey: KEY,
  outcome,
  version: VERSION,
  current: create(SyncEventSchema, { facetKey: KEY, version: VERSION, op: SyncOp.UPSERT, payload: PAYLOAD, basis: '', commitCursor: 'c1' }),
  reason,
});
const response = (...results: ResultInit[]) => create(PushResponseSchema, { results });

const ZERO = { unspecified: 0, applied: 0, duplicate: 0, stale: 0, review: 0, rejected: 0, held: 0 };
/** The measures of a line with no arrival (a replay): nothing aged, nothing resent. */
const UNMEASURED = { age_basis: 'version', ages: {}, oldest_age: 'none', resend_stale: 0 };

describe('the sync.push line', () => {
  it('is named sync.push', () => {
    expect(PUSH_LINE).toBe('sync.push');
  });

  it('counts each outcome the server answered, with the event count and whether it was a replay', () => {
    const line = pushLine(
      response(
        result(PushOutcome.APPLIED),
        result(PushOutcome.APPLIED),
        result(PushOutcome.STALE),
        result(PushOutcome.HELD),
        result(PushOutcome.REJECTED, 'version_future: later than server_now + 300s'),
      ),
      false,
    );
    expect(line).toEqual({ outcome: 'ok', replay: false, events: 5, ...ZERO, applied: 2, stale: 1, held: 1, rejected: 1, reasons: { version_future: 1 }, ...UNMEASURED });
  });

  it('counts a replay\'s DUPLICATE and REVIEW, and marks it replay', () => {
    const line = pushLine(response(result(PushOutcome.DUPLICATE), result(PushOutcome.REVIEW)), true);
    expect(line).toEqual({ outcome: 'ok', replay: true, events: 2, ...ZERO, duplicate: 1, review: 1, reasons: {}, ...UNMEASURED });
  });

  it('carries every count at zero for an empty Push, so a query never meets a missing field', () => {
    expect(pushLine(response(), false)).toEqual({ outcome: 'ok', replay: false, events: 0, ...ZERO, reasons: {}, ...UNMEASURED });
  });

  it('counts an outcome this server never answers as unspecified, so the counts still add up to events', () => {
    const line = pushLine(response(result(PushOutcome.UNSPECIFIED), result(99 as PushOutcome)), false);
    expect(line).toMatchObject({ events: 2, unspecified: 2 });
  });

  it('counts each REJECTED by the code before its first colon, and never carries the detail', () => {
    const line = pushLine(
      response(
        ...PUSH_REJECT_REASONS.map((code) => result(PushOutcome.REJECTED, `${code}: detail for ${code}`)),
        result(PushOutcome.REJECTED, 'payload_invalid: /status must be equal to one of the allowed values'),
        result(PushOutcome.REJECTED, 'basis_missing'),
      ),
      false,
    );
    expect(line['reasons']).toEqual({ ...Object.fromEntries(PUSH_REJECT_REASONS.map((code) => [code, 1])), payload_invalid: 2, basis_missing: 2 });
    expect(JSON.stringify(line)).not.toMatch(/detail|allowed values/);
  });

  it('counts a reason outside the contract\'s codes as other, so free text never becomes a field name', () => {
    const line = pushLine(response(result(PushOutcome.REJECTED, 'the user typed this: and more'), result(PushOutcome.REJECTED, '')), false);
    expect(line['reasons']).toEqual({ other: 2 });
    expect(JSON.stringify(line)).not.toContain('typed');
  });

  it('reads a reason only on REJECTED', () => {
    expect(pushLine(response(result(PushOutcome.STALE, 'version_future: not a rejection')), false)['reasons']).toEqual({});
  });

  it('copies no key, version, device, payload or cursor from what it counts', () => {
    const text = JSON.stringify(pushLine(response(result(PushOutcome.APPLIED), result(PushOutcome.REJECTED, 'device_mismatch: x')), false));
    for (const value of [KEY, VERSION, normaliseDeviceId(DEVICE), DEVICE, PAYLOAD, 'a private note', 'c1']) {
      expect(text).not.toContain(value);
    }
  });
});

describe('the sync.push line of a Push that failed', () => {
  it('names the Connect code the client was answered, with the event count', () => {
    const err = new ConnectError('client_id was already used for a different batch', Code.InvalidArgument);
    expect(pushErrorLine(err, 3)).toEqual({ outcome: 'error', code: 'invalid_argument', events: 3 });
    expect(pushErrorLine(new ConnectError('retry later', Code.Unavailable), 1)).toMatchObject({ code: 'unavailable' });
  });

  it('names INTERNAL for any other error, as Connect answers it, and never its message', () => {
    const text = JSON.stringify(pushErrorLine(new Error('invalid input syntax for type uuid: "a-value"'), 1));
    expect(JSON.parse(text)).toEqual({ outcome: 'error', code: 'internal', events: 1 });
    expect(text).not.toContain('a-value');
    expect(pushErrorLine('thrown as a string', 0)).toEqual({ outcome: 'error', code: 'internal', events: 0 });
  });
});

describe('the sync field allow-list', () => {
  it('names exactly the fields a sync line may carry', () => {
    expect([...SYNC_LOG_FIELDS].sort()).toEqual(
      [
        'age_basis',
        'ages',
        'applied',
        'code',
        'duplicate',
        'events',
        'held',
        'oldest_age',
        'outcome',
        'reasons',
        'rejected',
        'replay',
        'resend_stale',
        'review',
        'stale',
        'unspecified',
      ].sort(),
    );
  });

  it('drops every field it does not name, and keeps the ones it does', () => {
    const fields = { events: 1, applied: 1, facet_key: KEY, facetKey: KEY, version: VERSION, sub: 'u', deviceId: DEVICE, client_id: 'c', payload: PAYLOAD, reason: 'x: y' };
    expect(allowListed(fields)).toEqual({ events: 1, applied: 1 });
  });

  it('takes another list, for a line with fields of its own', () => {
    expect(allowListed({ events: 1, origin_trace: 'none' }, new Set(['origin_trace']))).toEqual({ origin_trace: 'none' });
  });
});

const SECOND = 1_000_000n;
const MINUTE = 60n * SECOND;
const HOUR = 60n * MINUTE;
const DAY = 24n * HOUR;
const NOW_MICROS = BigInt(Date.parse('2026-10-30T12:00:00Z')) * 1000n;
const OLDER = canonicalVersion({ instant: new Date('2026-10-30T08:00:00Z'), counter: 1, deviceId: DEVICE });

/** A Push placed at NOW_MICROS whose events are this old (undefined: the version did not parse), each sent as `versions`. */
const arrival = (delays: (bigint | undefined)[], versions: string[] = delays.map(() => VERSION)): Arrival => ({
  nowMicros: NOW_MICROS,
  instants: delays.map((delay) => (delay === undefined ? undefined : NOW_MICROS - delay)),
  versions,
});

describe('the age bucket of a sync delay (server_now minus the version instant)', () => {
  it.each([
    [-7n * DAY, 'ahead'],
    [-3n * SECOND - 1n, 'ahead'],
    [-3n * SECOND, '<10s'],
    [-1n, '<10s'],
    [0n, '<10s'],
    [10n * SECOND - 1n, '<10s'],
    [10n * SECOND, '<1m'],
    [MINUTE - 1n, '<1m'],
    [MINUTE, '<10m'],
    [10n * MINUTE - 1n, '<10m'],
    [10n * MINUTE, '<1h'],
    [HOUR - 1n, '<1h'],
    [HOUR, '<6h'],
    [6n * HOUR - 1n, '<6h'],
    [6n * HOUR, '<24h'],
    [DAY - 1n, '<24h'],
    [DAY, '<7d'],
    [7n * DAY - 1n, '<7d'],
    [7n * DAY, '>=7d'],
    [3650n * DAY, '>=7d'],
  ])('puts a delay of %s microseconds in %s', (delay, bucket) => {
    expect(ageBucket(delay)).toBe(bucket);
  });

  it('names its buckets youngest first, ahead before them all', () => {
    expect(AGE_BUCKETS).toEqual(['ahead', '<10s', '<1m', '<10m', '<1h', '<6h', '<24h', '<7d', '>=7d']);
  });

  it('never puts a longer delay in a younger bucket', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -30n * DAY, max: 30n * DAY }), fc.bigInt({ min: 0n, max: 30n * DAY }), (delay, more) => {
        expect(AGE_BUCKETS.indexOf(ageBucket(delay))).toBeLessThanOrEqual(AGE_BUCKETS.indexOf(ageBucket(delay + more)));
      }),
    );
  });
});

describe('the sync delay on the sync.push line', () => {
  it('counts each event by its age bucket, names the oldest, and labels both as read from the version', () => {
    const line = pushLine(
      response(result(PushOutcome.APPLIED), result(PushOutcome.APPLIED), result(PushOutcome.STALE), result(PushOutcome.REJECTED, 'version_future: x')),
      false,
      arrival([3n * HOUR, 30n * SECOND, 2n * DAY, -10n * MINUTE], [VERSION, VERSION, OLDER, VERSION]),
    );
    expect(line).toMatchObject({ age_basis: 'version', ages: { '<6h': 1, '<1m': 1, '<7d': 1, ahead: 1 }, oldest_age: '<7d' });
  });

  it('names the oldest by the largest delay, wherever it sits in the batch', () => {
    const applied = response(result(PushOutcome.APPLIED), result(PushOutcome.APPLIED), result(PushOutcome.APPLIED));
    expect(pushLine(applied, false, arrival([SECOND, 8n * DAY, 2n * MINUTE]))['oldest_age']).toBe('>=7d');
    expect(pushLine(applied, false, arrival([8n * DAY, SECOND, 2n * MINUTE]))['oldest_age']).toBe('>=7d');
    expect(pushLine(applied, false, arrival([SECOND, 2n * MINUTE, 8n * DAY]))['oldest_age']).toBe('>=7d');
  });

  it('puts an edit up to 3 s ahead of the server in <10s: the phone samples its offset to within about 1.5 s', () => {
    const two = response(result(PushOutcome.APPLIED), result(PushOutcome.APPLIED));
    expect(pushLine(two, false, arrival([-2n * SECOND, -3n * SECOND]))).toMatchObject({ ages: { '<10s': 2 }, oldest_age: '<10s' });
    expect(pushLine(two, false, arrival([-3n * SECOND - 1n, -HOUR]))).toMatchObject({ ages: { ahead: 2 }, oldest_age: 'ahead' });
  });

  it('ages no event whose version did not parse, and names no oldest when none did', () => {
    const two = response(result(PushOutcome.REJECTED, 'version_malformed: x'), result(PushOutcome.APPLIED));
    expect(pushLine(two, false, arrival([undefined, 5n * MINUTE]))).toMatchObject({ ages: { '<10m': 1 }, oldest_age: '<10m' });
    expect(pushLine(two, false, arrival([5n * MINUTE, undefined]))).toMatchObject({ ages: { '<10m': 1 }, oldest_age: '<10m' });
    const malformed = response(result(PushOutcome.REJECTED, 'version_malformed: x'));
    expect(pushLine(malformed, false, arrival([undefined]))).toMatchObject({ age_basis: 'version', ages: {}, oldest_age: 'none' });
    expect(pushLine(response(), false, arrival([]))).toMatchObject({ ages: {}, oldest_age: 'none' });
  });

  it('measures nothing on a replay: its edits arrived with the Push it repeats, whose line aged them', () => {
    const line = pushLine(response(result(PushOutcome.DUPLICATE), result(PushOutcome.STALE)), true);
    expect(line).toMatchObject({ replay: true, ...UNMEASURED });
  });

  it('carries buckets and counts, never a delay or an instant', () => {
    const delays = [3n * HOUR + 17n, 30n * SECOND + 5n];
    const text = JSON.stringify(pushLine(response(result(PushOutcome.APPLIED), result(PushOutcome.APPLIED)), false, arrival(delays)));
    for (const value of [...delays.flatMap((d) => [String(d), String(d / 1000n)]), String(NOW_MICROS), String(NOW_MICROS / 1000n), '2026-10-30']) {
      expect(text).not.toContain(value);
    }
  });
});

describe('resend_stale on the sync.push line', () => {
  it('counts a STALE answered with the very version the event was sent with', () => {
    const line = pushLine(response(result(PushOutcome.STALE), result(PushOutcome.STALE)), false, arrival([HOUR, HOUR], [VERSION, OLDER]));
    expect(line).toMatchObject({ stale: 2, resend_stale: 1 });
  });

  it('counts only STALE: an APPLIED or REJECTED with its own version is no resend', () => {
    const line = pushLine(response(result(PushOutcome.APPLIED), result(PushOutcome.REJECTED, 'device_mismatch: x'), result(PushOutcome.HELD)), false, arrival([HOUR, HOUR, HOUR]));
    expect(line['resend_stale']).toBe(0);
  });

  it('counts no STALE that carries no current, whatever was sent', () => {
    const bare = create(PushResponseSchema, { results: [{ facetKey: KEY, outcome: PushOutcome.STALE, version: '' }] });
    expect(pushLine(bare, false, arrival([HOUR], ['']))['resend_stale']).toBe(0);
  });

  it('counts nothing on a replay: the STALE it repeats was counted when it was placed', () => {
    expect(pushLine(response(result(PushOutcome.STALE)), true)['resend_stale']).toBe(0);
  });
});
