// The replay identity of a Push, without a database (sync.proto SyncEvent.origin_trace, 0.7.0):
// origin_trace is cleared on every event before a batch is hashed, whatever wire format it came
// in, so a retry that adds, changes or drops it is a replay and a receipt recorded before 0.7.0
// still matches.
import * as contract from '@figurecollecting/fc-api-contract';
import { SyncEventSchema } from '@figurecollecting/fc-api-contract';
import { describe, expect, it } from 'vitest';

describe('the contract this reads', () => {
  it('is 0.7.0 or later: SyncEvent.origin_trace is field 7, and isTraceId checks its form', () => {
    expect(SyncEventSchema.field.originTrace?.number).toBe(7);
    expect(typeof contract.isTraceId).toBe('function');
  });
});
