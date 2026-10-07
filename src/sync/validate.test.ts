import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  MAX_FUTURE_SKEW_MS,
  MAX_PAYLOAD_BYTES,
  SyncOp,
  USER_FACET_FAMILIES,
  USER_FACET_PAYLOAD_SCHEMAS,
  answerKey,
  canonicalVersion,
  collNameKey,
  importPrefKey,
  occFacetKey,
  occOriginKey,
  occTagKey,
  tagNameKey,
  ufFacetKey,
  ufKindTagKey,
  ufTagKey,
  type UserFacetFamily,
} from '@figurecollecting/fc-api-contract';
import { describe, expect, it } from 'vitest';
import { validateEvent } from './validate.js';

const DEVICE = '0f3a5c7e-9b1d-2f4a-6c8e-0b2d4f6a8c0e';
const DEVICE_HEX = DEVICE.replaceAll('-', '');
const NOW = new Date('2026-09-26T12:00:00.000Z');
const NOW_MICROS = BigInt(NOW.getTime()) * 1000n;
const ctx = { deviceHex: DEVICE_HEX, nowMicros: NOW_MICROS };
const DISPLAY = { edited_at: '2026-09-26T07:00:00-05:00', tz: 'America/Chicago' };
const OCC = '5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0';
const HEAD = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const TAG = '0c1d2e3f-4a5b-4c6d-9e7f-8a9b0c1d2e3f';
const KEY = occFacetKey(OCC, 'status');
const SERVER_OWNED = occOriginKey(OCC);

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
    ['a key no family names', { facetKey: 'identity/5b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0' }, 'facet_key_not_user_owned', false],
    ['the server-owned origin of a copy', { facetKey: SERVER_OWNED, payload: JSON.stringify({ site: 'mfc', native_id: '1144', ordinal: 1 }) }, 'facet_key_not_user_owned', false],
    ['a retired 0.2.x holding status', { facetKey: `holding/${HEAD}/status` }, 'facet_key_not_user_owned', false],
    ['a retired 0.2.x holding count', { facetKey: `holding/${HEAD}/count`, payload: JSON.stringify({ count: 2, ...DISPLAY }) }, 'facet_key_not_user_owned', false],
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

  // One key, one payload that fits its family's schema and one that does not, per user-owned family.
  const FAMILIES: Record<UserFacetFamily, { key: string; valid: object; invalid: object }> = {
    'occ/head': { key: occFacetKey(OCC, 'head'), valid: { head_id: HEAD }, invalid: { head_id: HEAD.toUpperCase() } },
    'occ/status': { key: occFacetKey(OCC, 'status'), valid: { status: 'former' }, invalid: { status: 'lent' } },
    'occ/collection': { key: occFacetKey(OCC, 'collection'), valid: { collection: 'owned/default' }, invalid: { collection: 'lent/default' } },
    'occ/disposal': {
      key: occFacetKey(OCC, 'disposal'),
      valid: { reason: 'sold', on: '2026-09-01', price: { amount: '12800', currency: 'JPY' } },
      invalid: { reason: 'sold', price: { amount: '12,800', currency: 'JPY' } },
    },
    'occ/tag': { key: occTagKey(OCC, TAG), valid: {}, invalid: { name: 'x' } },
    'uf/score': { key: ufFacetKey(HEAD, 'score'), valid: { score: 10 }, invalid: { score: 11 } },
    'uf/note': { key: ufFacetKey(HEAD, 'note'), valid: { note: 'x'.repeat(10_000) }, invalid: { note: 'x'.repeat(10_001) } },
    'uf/wishability': { key: ufFacetKey(HEAD, 'wishability'), valid: { wishability: 5 }, invalid: { wishability: 6 } },
    'uf/tag': { key: ufTagKey(HEAD, TAG), valid: {}, invalid: { tag: TAG } },
    'uf/ktag': { key: ufKindTagKey(HEAD, 'ordered', TAG), valid: {}, invalid: { kind: 'ordered' } },
    'coll/name': { key: collNameKey('wished', 'default'), valid: { name: 'Grails' }, invalid: { name: '' } },
    'tag/name': { key: tagNameKey(TAG), valid: { name: 'x'.repeat(100) }, invalid: { name: 'x'.repeat(101) } },
    'res/answer': {
      key: answerKey('mfc', HEAD),
      valid: { item: 'figure', rev: 'r1', choice: 'per_copy', copies: [{ occ: OCC, status: 'removed' }] },
      invalid: { item: 'figure', rev: 'r1', choice: 'keep', copies: [{ occ: OCC, status: 'removed' }] },
    },
    'pref/import': { key: importPrefKey('mfc'), valid: { import_policy: 'FAVOR_APP', disposition_list: '1144' }, invalid: { import_policy: 'favor_app' } },
  };
  const withDisplay = (payload: object) => JSON.stringify({ ...payload, ...DISPLAY });
  const check = (key: string, payload: object) => validateEvent(event({ facetKey: key, payload: withDisplay(payload) }), ctx);

  it('covers every user-owned family of the contract', () => {
    expect(Object.keys(FAMILIES).sort()).toEqual([...USER_FACET_FAMILIES].sort());
  });

  it.each(USER_FACET_FAMILIES.map((family) => [family]))('accepts %s with a payload its schema allows, and a DELETE', (family) => {
    const { key, valid } = FAMILIES[family];
    expect(check(key, valid)).toEqual({ ok: true });
    expect(validateEvent(event({ facetKey: key, op: SyncOp.DELETE, payload: '' }), ctx)).toEqual({ ok: true });
  });

  it.each(USER_FACET_FAMILIES.map((family) => [family]))('refuses %s with a payload its schema does not allow', (family) => {
    const { key, invalid } = FAMILIES[family];
    expect(check(key, invalid)).toMatchObject({ ok: false, userOwned: true, reason: expect.stringMatching(/^payload_invalid: /) });
  });

  it.each(USER_FACET_FAMILIES.map((family) => [family]))('refuses %s with only the display time where the schema needs more', (family) => {
    const { key, valid } = FAMILIES[family];
    // {} families need nothing else; every other family needs its own property.
    expect(check(key, {}).ok).toBe(Object.keys(valid).length === 0);
  });

  // The schema is picked by the parsed family: a payload is accepted under another family's key
  // only when the two schemas say the same thing (the {} memberships; the two names).
  const require = createRequire(import.meta.url);
  const rules = (family: UserFacetFamily) => {
    const schema = JSON.parse(readFileSync(require.resolve(`@figurecollecting/fc-api-contract/${USER_FACET_PAYLOAD_SCHEMAS[family]}`), 'utf8'));
    return JSON.stringify(schema, (k, v) => (k === '$id' || k === 'title' || k === 'description' ? undefined : v));
  };
  it.each(USER_FACET_FAMILIES.flatMap((sent) => USER_FACET_FAMILIES.filter((under) => under !== sent).map((under) => [sent, under])))(
    "checks %s's payload under %s against the key's own schema",
    (sent, under) => {
      expect(check(FAMILIES[under].key, FAMILIES[sent].valid).ok).toBe(rules(sent) === rules(under));
    },
  );

  // golden/key-vectors.json, shared with fc-mobile: every user-owned spelling is accepted under its
  // family's schema; every server-owned, retired or malformed one is facet_key_not_user_owned.
  const vectors = JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/golden/key-vectors.json'), 'utf8')) as {
    valid: { key: string; owner: 'user' | 'server'; parsed: { family: string } }[];
    invalid: { key: string }[];
  };
  const userVectors = vectors.valid.filter((v) => v.owner === 'user');
  const refused = [...vectors.valid.filter((v) => v.owner === 'server'), ...vectors.invalid];

  it('meets every user-owned family and some refused key in the golden vectors', () => {
    expect(new Set(userVectors.map((v) => v.parsed.family))).toEqual(new Set(USER_FACET_FAMILIES));
    expect(refused.filter((v) => v.key.startsWith('holding/')).length).toBeGreaterThanOrEqual(2);
    expect(refused.some((v) => v.key.endsWith('/origin'))).toBe(true);
  });

  it.each(userVectors.map((v) => [v.key, v.parsed.family as UserFacetFamily]))('accepts the golden user-owned key %s', (key, family) => {
    expect(check(key, FAMILIES[family].valid)).toEqual({ ok: true });
  });

  it.each(refused.map((v) => [v.key]))('refuses the golden key %s as not user-owned', (key) => {
    expect(check(key, {})).toMatchObject({ ok: false, userOwned: false, reason: expect.stringMatching(/^facet_key_not_user_owned: /) });
  });

  it('takes a schema-valid payload of MAX_PAYLOAD_BYTES and refuses one byte more, counted as UTF-8', () => {
    const noteKey = ufFacetKey(HEAD, 'note');
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
    ['a malformed version on a copy origin', { facetKey: SERVER_OWNED, version: 'x' }, 'version_malformed', false],
    ['a past-bound version on a retired holding key', { facetKey: `holding/${HEAD}/status`, version: at(MAX_FUTURE_SKEW_MS + 1) }, 'version_future', false],
    ['a copy origin from another device with a bad payload', { facetKey: SERVER_OWNED, version: at(-1000, '9c1e3a5b-7d9f-1b3d-5f7a-9c1e3b5d7f9a'), payload: '{' }, 'facet_key_not_user_owned', false],
    ['a retired holding key from another device with an oversized payload', { facetKey: `holding/${HEAD}/count`, version: at(-1000, '9c1e3a5b-7d9f-1b3d-5f7a-9c1e3b5d7f9a'), payload: OVERSIZED }, 'facet_key_not_user_owned', false],
    ['a bare instant on a retired holding key', { facetKey: `holding/${HEAD}/status`, version: at(-1000).slice(0, 27) }, 'facet_key_not_user_owned', false],
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
