// The replay identity of a Push, without a database (sync.proto SyncEvent.origin_trace, 0.7.0):
// origin_trace is cleared on every event before a batch is hashed, whatever wire format it came
// in, so a retry that adds, changes or drops it is a replay and a receipt recorded before 0.7.0
// still matches.
import { createHash } from 'node:crypto';
import { create, fromBinary, fromJsonString, toBinary } from '@bufbuild/protobuf';
import * as contract from '@figurecollecting/fc-api-contract';
import { PushRequestSchema, SyncEventSchema, type PushRequest } from '@figurecollecting/fc-api-contract';
import { describe, expect, it } from 'vitest';
import { replayDigest } from '../../src/sync/service.js';

describe('the contract this reads', () => {
  it('is 0.7.0 or later: SyncEvent.origin_trace is field 7, and isTraceId checks its form', () => {
    expect(SyncEventSchema.field.originTrace?.number).toBe(7);
    expect(typeof contract.isTraceId).toBe('function');
  });
});

// Two JSON Pushes of the same batch, one with origin_trace on its events. Decoded by
// fc-api-contract 0.6.0 as Connect decodes JSON (unknown fields ignored), both hash to GOLDEN_060:
// what a 0.6.0 server stored as their receipt's request_sha256. Recorded by
// ~/tmp/lgmob/c3/golden/golden.mjs before the bump (golden-0.6.0.log).
const GOLDEN_060 = '3ad6a9c02d5d0ae6bfa43a1356d1eee9857357ea0a0416babe9c244e4176a91b';
const K1 = 'uf/5d0c9a1e-3b7f-4e2a-9c6d-1f8b0e4a7c35/note';
const K2 = 'uf/5d0c9a1e-3b7f-4e2a-9c6d-1f8b0e4a7c35/score';
const V1 = '2026-10-30T09:00:00.000000Z#0001#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
const V2 = '2026-10-30T09:00:00.000000Z#0002#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
const P1 = '{"note":"golden","edited_at":"2026-10-30T04:00:00.000-05:00","tz":"America/Chicago"}';
const P2 = '{"score":7,"edited_at":"2026-10-30T04:00:00.000-05:00","tz":"America/Chicago"}';
const T = '4bf92f3577b34da6a3ce929d0e0e4736';
const event = (facetKey: string, version: string, payload: string, extra: object = {}) => ({ facetKey, version, op: 'SYNC_OP_UPSERT', payload, basis: '', ...extra });
const ABSENT = JSON.stringify({ clientId: 'golden-batch', events: [event(K1, V1, P1), event(K2, V2, P2)] });
const PRESENT = JSON.stringify({ clientId: 'golden-batch', events: [event(K1, V1, P1, { originTrace: T }), event(K2, V2, P2, { originTrace: 'zz' })] });

/** As the Connect handler decodes a JSON Push (connect-es ignores unknown JSON fields by default). */
const fromJson = (json: string): PushRequest => fromJsonString(PushRequestSchema, json, { ignoreUnknownFields: true });
const hex = (req: PushRequest) => replayDigest(req).toString('hex');

describe('the replay digest of a Push', () => {
  it('is what a 0.6.0 server recorded for the same batch, with origin_trace on it or not', () => {
    expect(hex(fromJson(ABSENT))).toBe(GOLDEN_060);
    expect(hex(fromJson(PRESENT))).toBe(GOLDEN_060);
  });

  it('is the plain sha256 of the request when no event carries origin_trace: a receipt from before 0.7.0 matches', () => {
    const req = fromJson(ABSENT);
    expect(replayDigest(req).equals(createHash('sha256').update(toBinary(PushRequestSchema, req)).digest())).toBe(true);
  });

  it('clears the field rather than emptying it: "" and a malformed value hash as absent', () => {
    for (const trace of ['', 'zz', T.toUpperCase(), 'x'.repeat(10_000)]) {
      expect(hex(fromJson(JSON.stringify({ clientId: 'golden-batch', events: [event(K1, V1, P1, { originTrace: trace }), event(K2, V2, P2)] })))).toBe(GOLDEN_060);
    }
  });

  it('is the same over binary, where the field is decoded and kept, as over JSON', () => {
    const binary = fromBinary(PushRequestSchema, toBinary(PushRequestSchema, fromJson(PRESENT)));
    expect(binary.events.map((e) => e.originTrace)).toEqual([T, 'zz']);
    expect(binary.events.every((e) => e.$unknown === undefined || e.$unknown.length === 0)).toBe(true);
    expect(hex(binary)).toBe(GOLDEN_060);
  });

  it('leaves the request as it came: the log reads origin_trace from it afterwards', () => {
    const req = fromJson(PRESENT);
    replayDigest(req);
    expect(req.events.map((e) => e.originTrace)).toEqual([T, 'zz']);
  });

  it('still tells apart a batch whose client_id or any other event field differs', () => {
    const base = fromJson(PRESENT);
    const variants: PushRequest[] = [
      create(PushRequestSchema, { ...base, clientId: 'another-batch' }),
      create(PushRequestSchema, { ...base, events: base.events.slice(0, 1) }),
      create(PushRequestSchema, { ...base, events: [...base.events].reverse() }),
      ...(['facetKey', 'version', 'payload', 'basis'] as const).map((field) =>
        create(PushRequestSchema, { ...base, events: [create(SyncEventSchema, { ...base.events[0]!, [field]: 'changed' }), base.events[1]!] }),
      ),
      create(PushRequestSchema, { ...base, events: [create(SyncEventSchema, { ...base.events[0]!, op: contract.SyncOp.DELETE }), base.events[1]!] }),
      create(PushRequestSchema, { ...base, events: [create(SyncEventSchema, { ...base.events[0]!, basis: undefined }), base.events[1]!] }),
    ];
    const digests = new Set(variants.map(hex));
    expect(digests.size).toBe(variants.length);
    expect(digests.has(GOLDEN_060)).toBe(false);
  });
});
