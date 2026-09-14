import { describe, expect, it } from 'vitest';
import { NONCE_BYTES, createNonceEpoch } from './nonce.js';

const PERIOD_MS = 300_000;

function at(ms: number): () => number {
  return () => ms;
}

describe('createNonceEpoch', () => {
  it('mints a nonce this epoch accepts', () => {
    const epoch = createNonceEpoch({ periodMs: PERIOD_MS });
    const nonce = epoch.mint();
    expect(epoch.verify(nonce)).toEqual({ ok: true });
  });

  it('mints base64url of exactly epoch_id + bucket + truncated mac', () => {
    const epoch = createNonceEpoch({ periodMs: PERIOD_MS });
    const nonce = epoch.mint();
    const raw = Buffer.from(nonce, 'base64url');
    expect(raw.byteLength).toBe(NONCE_BYTES);
    expect(raw.subarray(0, 16).toString('base64url')).toBe(epoch.epochId);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts the PREVIOUS bucket so a slightly stale client is not bounced', () => {
    const now = { value: 10 * PERIOD_MS };
    const epoch = createNonceEpoch({ periodMs: PERIOD_MS, now: () => now.value });
    const nonce = epoch.mint();
    now.value += PERIOD_MS;
    expect(epoch.verify(nonce)).toEqual({ ok: true });
  });

  it('rejects a bucket two periods old', () => {
    const now = { value: 10 * PERIOD_MS };
    const epoch = createNonceEpoch({ periodMs: PERIOD_MS, now: () => now.value });
    const nonce = epoch.mint();
    now.value += 2 * PERIOD_MS;
    expect(epoch.verify(nonce)).toEqual({ ok: false, reason: 'stale_bucket' });
  });

  it('rejects a bucket from the future', () => {
    const early = createNonceEpoch({ periodMs: PERIOD_MS, now: at(50 * PERIOD_MS) });
    const nonce = early.mint();
    expect(early.verify(nonce, at(48 * PERIOD_MS)())).toEqual({ ok: false, reason: 'stale_bucket' });
  });

  it('rejects a nonce minted by a DIFFERENT process epoch (the restart property)', () => {
    const before = createNonceEpoch({ periodMs: PERIOD_MS });
    const nonce = before.mint();
    const afterRestart = createNonceEpoch({ periodMs: PERIOD_MS });
    expect(afterRestart.verify(nonce)).toEqual({ ok: false, reason: 'wrong_epoch' });
    expect(afterRestart.epochId).not.toBe(before.epochId);
  });

  it('rejects a nonce whose mac was tampered with, same epoch and bucket', () => {
    const epoch = createNonceEpoch({ periodMs: PERIOD_MS });
    const raw = Buffer.from(epoch.mint(), 'base64url');
    raw[raw.byteLength - 1] = raw[raw.byteLength - 1]! ^ 0xff;
    expect(epoch.verify(raw.toString('base64url'))).toEqual({ ok: false, reason: 'bad_mac' });
  });

  it('rejects malformed input rather than throwing', () => {
    const epoch = createNonceEpoch({ periodMs: PERIOD_MS });
    expect(epoch.verify('')).toEqual({ ok: false, reason: 'malformed' });
    expect(epoch.verify('not base64url!!')).toEqual({ ok: false, reason: 'malformed' });
    expect(epoch.verify(Buffer.alloc(NONCE_BYTES - 1).toString('base64url'))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(epoch.verify(Buffer.alloc(NONCE_BYTES + 1).toString('base64url'))).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects non-canonical base64url that decodes to the right length', () => {
    const epoch = createNonceEpoch({ periodMs: PERIOD_MS });
    const nonce = epoch.mint();
    expect(epoch.verify(`${nonce}=`)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('gives two processes different keys even at the same instant', () => {
    const a = createNonceEpoch({ periodMs: PERIOD_MS, now: at(1_000_000) });
    const b = createNonceEpoch({ periodMs: PERIOD_MS, now: at(1_000_000) });
    expect(a.mint()).not.toBe(b.mint());
  });

  it('rejects a non-positive period rather than minting a degenerate nonce', () => {
    expect(() => createNonceEpoch({ periodMs: 0 })).toThrow(/periodMs/);
  });
});
