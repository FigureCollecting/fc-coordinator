import { MAX_FUTURE_SKEW_MS, MAX_PAYLOAD_BYTES, SyncOp, canonicalVersion, userFacetKey } from '@figurecollecting/fc-api-contract';
import { describe, expect, it } from 'vitest';
import { validateEvent } from './validate.js';

const DEVICE = '0f3a5c7e-9b1d-2f4a-6c8e-0b2d4f6a8c0e';
const DEVICE_HEX = DEVICE.replaceAll('-', '');
const NOW = new Date('2026-09-26T12:00:00.000Z');
const NOW_MICROS = BigInt(NOW.getTime()) * 1000n;
const ctx = { deviceHex: DEVICE_HEX, nowMicros: NOW_MICROS };
const DISPLAY = { edited_at: '2026-09-26T07:00:00-05:00', tz: 'America/Chicago' };
const KEY = userFacetKey('5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', 'status');

const at = (ms: number, deviceId = DEVICE) =>
  canonicalVersion({ instant: new Date(NOW.getTime() + ms), counter: 3, deviceId });
const event = (over: Partial<{ facetKey: string; version: string; op: SyncOp; payload: string }> = {}) => ({
  facetKey: KEY,
  version: at(-1000),
  op: SyncOp.UPSERT,
  payload: JSON.stringify({ status: 'owned', ...DISPLAY }),
  ...over,
});

describe('validateEvent', () => {
  it('accepts a user-owned UPSERT from the calling device', () => {
    expect(validateEvent(event(), ctx)).toEqual({ ok: true });
  });

  it('accepts a DELETE with an empty payload', () => {
    expect(validateEvent(event({ op: SyncOp.DELETE, payload: '' }), ctx)).toEqual({ ok: true });
  });

  it('accepts a version exactly at the skew bound and refuses one microsecond past it', () => {
    const bound = canonicalVersion({ instant: new Date(NOW.getTime() + MAX_FUTURE_SKEW_MS), counter: 0, deviceId: DEVICE });
    expect(validateEvent(event({ version: bound }), ctx)).toEqual({ ok: true });
    expect(validateEvent(event({ version: bound }), { ...ctx, nowMicros: NOW_MICROS - 1n })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^version_future: /),
    });
  });

  it.each([
    ['a server-owned key', { facetKey: 'identity/5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0' }, 'facet_key_not_user_owned', false],
    ['a key with an uppercase head', { facetKey: KEY.toUpperCase() }, 'facet_key_not_user_owned', false],
    ['a bare instant', { version: '2026-09-26T11:00:00.000000Z' }, 'version_malformed', true],
    ['millisecond precision', { version: at(-1000).replace(/(\.\d{3})\d{3}Z/, '$1Z') }, 'version_malformed', true],
    ['another device', { version: at(-1000, '9c1e3a5b-7d9f-1b3d-5f7a-9c1e3b5d7f9a') }, 'device_mismatch', true],
    ['the reserved server device', { version: at(-1000, '00000000000000000000000000000000') }, 'device_mismatch', true],
    ['a version past the skew', { version: at(MAX_FUTURE_SKEW_MS + 1) }, 'version_future', true],
    ['an UPSERT with no payload', { payload: '' }, 'payload_invalid', true],
    ['a DELETE with a payload', { op: SyncOp.DELETE }, 'payload_invalid', true],
    ['an unspecified op', { op: SyncOp.UNSPECIFIED }, 'payload_invalid', true],
    ['an op this build does not know', { op: 9 as SyncOp }, 'payload_invalid', true],
    ['a payload that is not JSON', { payload: '{' }, 'payload_invalid', true],
    ['a payload outside its schema', { payload: JSON.stringify({ status: 'lent', ...DISPLAY }) }, 'payload_invalid', true],
    ['a payload with no display time', { payload: JSON.stringify({ status: 'owned' }) }, 'payload_invalid', true],
  ])('rejects %s', (_why, over, reason, userOwned) => {
    const verdict = validateEvent(event(over), ctx);
    expect(verdict).toMatchObject({ ok: false, userOwned });
    expect(verdict.ok === false && verdict.reason.split(':')[0]).toBe(reason);
  });

  it('checks each field against its own schema', () => {
    const head = '5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
    const ok = (field: 'count' | 'score' | 'note', payload: object) =>
      validateEvent(event({ facetKey: userFacetKey(head, field), payload: JSON.stringify({ ...payload, ...DISPLAY }) }), ctx).ok;
    expect(ok('count', { count: 2 })).toBe(true);
    expect(ok('count', { count: 0 })).toBe(false);
    expect(ok('score', { score: 10 })).toBe(true);
    expect(ok('score', { score: 11 })).toBe(false);
    expect(ok('note', { note: 'x'.repeat(10_000) })).toBe(true);
    expect(ok('note', { note: 'x'.repeat(10_001) })).toBe(false);
    expect(ok('note', { status: 'owned' })).toBe(false);
  });

  it('takes a schema-valid payload of MAX_PAYLOAD_BYTES and refuses one byte more, counted as UTF-8', () => {
    const noteKey = userFacetKey('5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', 'note');
    const padded = (text: string, bytes: number) => {
      const json = JSON.stringify({ note: text, ...DISPLAY });
      return json + ' '.repeat(bytes - Buffer.byteLength(json, 'utf8'));
    };
    const at = (payload: string) => validateEvent(event({ facetKey: noteKey, payload }), ctx);
    expect(MAX_PAYLOAD_BYTES).toBe(65_536);
    expect(at(padded('x', MAX_PAYLOAD_BYTES))).toEqual({ ok: true });
    const over = { ok: false, reason: 'payload_invalid: payload over 65536 bytes', userOwned: true };
    expect(at(padded('x', MAX_PAYLOAD_BYTES + 1))).toEqual(over);
    // 10,000 three-byte characters: fewer UTF-16 units than the cap, more UTF-8 bytes.
    const wide = padded('\u20ac'.repeat(10_000), MAX_PAYLOAD_BYTES + 1);
    expect(wide.length).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(at(wide)).toEqual(over);
    expect(validateEvent(event({ op: SyncOp.DELETE, payload: ' '.repeat(MAX_PAYLOAD_BYTES + 1) }), ctx)).toEqual(over);
  });

  // sync.proto: the REJECTED checks run in the listed order, so an event failing two gets the first.
  const OVERSIZED = JSON.stringify({ status: 'owned', ...DISPLAY }) + ' '.repeat(MAX_PAYLOAD_BYTES);
  it.each([
    ['a malformed version on a server-owned key', { facetKey: 'identity/5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', version: 'x' }, 'version_malformed', false],
    ['a past-bound version on a server-owned key', { facetKey: 'identity/5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', version: at(MAX_FUTURE_SKEW_MS + 1) }, 'version_future', false],
    [
      'a past-bound bare instant on a server-owned key',
      { facetKey: 'identity/5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', version: at(MAX_FUTURE_SKEW_MS + 1).slice(0, 27) },
      'version_future',
      false,
    ],
    ['a past-bound version from another device', { version: at(MAX_FUTURE_SKEW_MS + 1, '9c1e3a5b-7d9f-1b3d-5f7a-9c1e3b5d7f9a') }, 'version_future', true],
    ['a past-bound version with a bad payload', { version: at(MAX_FUTURE_SKEW_MS + 1), payload: '{' }, 'version_future', true],
    ['a server-owned key with another device', { facetKey: 'identity/5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', version: at(-1000, '9c1e3a5b-7d9f-1b3d-5f7a-9c1e3b5d7f9a') }, 'facet_key_not_user_owned', false],
    ['a bare instant on a server-owned key', { facetKey: 'identity/5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', version: at(-1000).slice(0, 27) }, 'facet_key_not_user_owned', false],
    ['another device with a bad payload', { version: at(-1000, '9c1e3a5b-7d9f-1b3d-5f7a-9c1e3b5d7f9a'), payload: '{' }, 'device_mismatch', true],
    ['a malformed version with an oversized payload', { version: 'x', payload: OVERSIZED }, 'version_malformed', true],
    ['a past-bound version with an oversized payload', { version: at(MAX_FUTURE_SKEW_MS + 1), payload: OVERSIZED }, 'version_future', true],
    ['a server-owned key with an oversized payload', { facetKey: 'identity/5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0', payload: OVERSIZED }, 'facet_key_not_user_owned', false],
    ['another device with an oversized payload', { version: at(-1000, '9c1e3a5b-7d9f-1b3d-5f7a-9c1e3b5d7f9a'), payload: OVERSIZED }, 'device_mismatch', true],
    ['an oversized payload alone', { payload: OVERSIZED }, 'payload_invalid: payload over 65536 bytes', true],
  ])('answers %s with the first listed reason', (_why, over, reason, userOwned) => {
    const verdict = validateEvent(event(over), ctx);
    expect(verdict).toMatchObject({ ok: false, userOwned });
    // A bare code matches the reason's code; a full reason must match exactly.
    expect(verdict.ok === false && (reason.includes(':') ? verdict.reason : verdict.reason.split(':')[0])).toBe(reason);
  });

  it('names the failing location without echoing the payload', () => {
    const verdict = validateEvent(event({ payload: JSON.stringify({ status: 'secret-value', ...DISPLAY }) }), ctx);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toMatch(/^payload_invalid: \/status /);
    expect(verdict.ok === false && verdict.reason).not.toContain('secret-value');
  });
});
