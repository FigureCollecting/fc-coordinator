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
import { describe, expect, it } from 'vitest';
import { PUSH_LINE, SYNC_LOG_FIELDS, allowListed, pushErrorLine, pushLine } from './pushLog.js';

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
    expect(line).toEqual({ outcome: 'ok', replay: false, events: 5, ...ZERO, applied: 2, stale: 1, held: 1, rejected: 1, reasons: { version_future: 1 } });
  });

  it('counts a replay\'s DUPLICATE and REVIEW, and marks it replay', () => {
    const line = pushLine(response(result(PushOutcome.DUPLICATE), result(PushOutcome.REVIEW)), true);
    expect(line).toEqual({ outcome: 'ok', replay: true, events: 2, ...ZERO, duplicate: 1, review: 1, reasons: {} });
  });

  it('carries every count at zero for an empty Push, so a query never meets a missing field', () => {
    expect(pushLine(response(), false)).toEqual({ outcome: 'ok', replay: false, events: 0, ...ZERO, reasons: {} });
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
      ['applied', 'code', 'duplicate', 'events', 'held', 'outcome', 'reasons', 'rejected', 'replay', 'review', 'stale', 'unspecified'].sort(),
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
