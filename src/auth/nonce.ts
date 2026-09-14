// ============================================================================
// The PROCESS-BOUND nonce epoch (plan §A.4, "the restart residual").
//
// An in-memory `jti` window has one real hole: restart the coordinator inside
// the proof window and the replay cache is empty, so a proof captured seconds
// before the restart replays cleanly. The fix is NOT durable storage — it is to
// bind the nonce to the process:
//
//   nonce = base64url( epoch_id ‖ bucket ‖ HMAC-SHA256(K, epoch_id ‖ bucket)[0..15] )
//
//     epoch_id  16 random bytes, generated ONCE at construction
//     bucket     the coarse time bucket, so nonces roll with no coordination
//     K          a per-process HMAC key, also generated here — never persisted,
//                never shared, never logged
//
// `epoch_id` and `K` are new after a restart, so EVERY pre-restart nonce fails
// its MAC (or its epoch comparison) and is rejected HERE — before the replay
// cache is ever consulted. That is what makes an empty cache after a restart
// unexploitable, and it is why dpop.ts checks the nonce BEFORE the jti.
//
// Cost: a restart invalidates every outstanding nonce, so each client takes one
// extra round-trip through the `use_dpop_nonce` flow it must implement anyway.
//
// The nonce is NOT a credential: it is worthless without the device private key
// and an unused jti. It is still treated as opaque and never logged.
// ============================================================================
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const EPOCH_ID_BYTES = 16;
const BUCKET_BYTES = 8;
const MAC_BYTES = 16;
const HMAC_KEY_BYTES = 32;

/** Wire length of a nonce before base64url encoding. */
export const NONCE_BYTES = EPOCH_ID_BYTES + BUCKET_BYTES + MAC_BYTES;

export type NonceFailure = 'malformed' | 'wrong_epoch' | 'stale_bucket' | 'bad_mac';

export type NonceCheck = { ok: true } | { ok: false; reason: NonceFailure };

export interface NonceEpoch {
  /** base64url of this process's epoch id. Public: it travels inside every nonce. */
  readonly epochId: string;
  mint(now?: number): string;
  verify(nonce: string, now?: number): NonceCheck;
}

export interface NonceEpochOptions {
  /** Bucket rotation period. A few minutes (plan §A.4). */
  periodMs: number;
  now?: () => number;
}

function bucketOf(now: number, periodMs: number): bigint {
  return BigInt(Math.floor(now / periodMs));
}

export function createNonceEpoch(options: NonceEpochOptions): NonceEpoch {
  if (!Number.isFinite(options.periodMs) || options.periodMs <= 0) {
    throw new Error(`nonce periodMs must be a positive number, got ${options.periodMs}`);
  }
  const clock = options.now ?? Date.now;

  // Generated ONCE, here. Losing them on restart is the design, not a defect.
  const epochId = randomBytes(EPOCH_ID_BYTES);
  const key = randomBytes(HMAC_KEY_BYTES);

  const mac = (bucket: Buffer): Buffer =>
    createHmac('sha256', key).update(epochId).update(bucket).digest().subarray(0, MAC_BYTES);

  const bucketBuffer = (value: bigint): Buffer => {
    const buffer = Buffer.alloc(BUCKET_BYTES);
    buffer.writeBigUInt64BE(value);
    return buffer;
  };

  return {
    epochId: epochId.toString('base64url'),

    mint(now = clock()) {
      const bucket = bucketBuffer(bucketOf(now, options.periodMs));
      return Buffer.concat([epochId, bucket, mac(bucket)]).toString('base64url');
    },

    verify(nonce, now = clock()) {
      if (typeof nonce !== 'string' || nonce === '') return { ok: false, reason: 'malformed' };

      const raw = Buffer.from(nonce, 'base64url');
      // Buffer's base64url decoder is lenient (it skips characters it does not
      // recognise), so length alone does not prove the input was canonical.
      // Re-encoding and comparing does, and it costs nothing.
      if (raw.byteLength !== NONCE_BYTES || raw.toString('base64url') !== nonce) {
        return { ok: false, reason: 'malformed' };
      }

      // The epoch id is public — every nonce we hand out contains it — so a
      // plain comparison leaks nothing. Only the MAC is compared in constant
      // time, because only the MAC is derived from K.
      if (!raw.subarray(0, EPOCH_ID_BYTES).equals(epochId)) {
        return { ok: false, reason: 'wrong_epoch' };
      }

      const bucket = raw.subarray(EPOCH_ID_BYTES, EPOCH_ID_BYTES + BUCKET_BYTES);
      const presented = bucket.readBigUInt64BE();
      const current = bucketOf(now, options.periodMs);
      // Current and previous only: a client holding a slightly stale nonce is
      // not bounced mid-request, and a nonce from the future is not accepted.
      if (presented !== current && presented !== current - 1n) {
        return { ok: false, reason: 'stale_bucket' };
      }

      if (!timingSafeEqual(raw.subarray(EPOCH_ID_BYTES + BUCKET_BYTES), mac(Buffer.from(bucket)))) {
        return { ok: false, reason: 'bad_mac' };
      }

      return { ok: true };
    },
  };
}
