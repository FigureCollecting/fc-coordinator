// ============================================================================
// The DPoP `jti` replay window (plan §A.4, "state budget": in-memory LRU).
//
// A proof may be presented ONCE. This is the last check in the verification
// order, so nothing is recorded here for a proof that failed an earlier step —
// an attacker cannot fill the window with junk that a legitimate client would
// then collide with.
//
// TWO bounds, and the interaction between them is the whole design:
//
//   ttlMs       set by the caller to the `iat` acceptance window (max age plus
//               clock skew). An entry that expires is therefore a proof that
//               the iat check would already reject, so eviction by time can
//               never open a replay hole.
//   maxEntries  a hard cap so a flood cannot exhaust memory. Eviction here is
//               oldest-first, and it CAN open a replay hole for the evicted
//               jti — bounded, deliberate, and the reason the cap is sized well
//               above the request rate the window can hold.
//
// Single-replica only, as slice 1 ships. Two replicas with independent windows
// let a replayed proof succeed on whichever has not seen the jti; the plan's
// answer at that point is a per-replica nonce epoch (which this design already
// gives, since epoch_id is per process) or a shared window in Redis.
// ============================================================================

export type JtiVerdict = 'fresh' | 'replay';

export interface JtiWindow {
  /** Records an unseen jti and returns 'fresh'; returns 'replay' for one already held. */
  check(jti: string, now?: number): JtiVerdict;
  readonly size: number;
}

export interface JtiWindowOptions {
  /** Must match the `iat` acceptance window, or eviction opens a hole. */
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

export function createJtiWindow(options: JtiWindowOptions): JtiWindow {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error(`jti window ttlMs must be a positive number, got ${options.ttlMs}`);
  }
  if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
    throw new Error(`jti window maxEntries must be a positive integer, got ${options.maxEntries}`);
  }
  const clock = options.now ?? Date.now;

  // Insertion-ordered, and every entry carries the SAME ttl, so the oldest
  // entry is always at the front: pruning stops at the first live one and costs
  // O(expired) rather than O(size).
  const seenAt = new Map<string, number>();

  const prune = (now: number): void => {
    for (const [jti, at] of seenAt) {
      // STRICTLY greater: an entry must survive at exactly ttlMs, because a
      // proof of exactly that age is still inside the `iat` window and would
      // otherwise replay in the one millisecond between the two rules.
      if (now - at <= options.ttlMs) break;
      seenAt.delete(jti);
    }
  };

  return {
    check(jti, now = clock()) {
      prune(now);
      if (seenAt.has(jti)) return 'replay';

      seenAt.set(jti, now);
      if (seenAt.size > options.maxEntries) {
        const oldest = seenAt.keys().next();
        if (!oldest.done) seenAt.delete(oldest.value);
      }
      return 'fresh';
    },

    get size() {
      return seenAt.size;
    },
  };
}
