// ============================================================================
// Step 2 of the DPoP order: is the presented device key bound to THIS token?
//
// TWO PATHS, coexisting with no flag day (plan §A.4, "Migration to the
// IdP-bound path"):
//
//   path B, today  Authentik 2026.5.4 pops `cnf` before encoding an access
//                  token, so no token names a key. The binding is the
//                  ENROLMENT: a live `device` row for (this user, this
//                  thumbprint). Revoking that row ends the device's access
//                  without touching the user's credentials or any other device.
//   path A, later  a future Authentik issues `cnf.jkt`. It is PREFERRED — the
//                  presented thumbprint must equal it — and the live-device
//                  lookup still runs, so revocation keeps working for a token
//                  the IdP itself bound. No re-enrolment, no migration.
//
// A cnf mismatch is refused WITHOUT a database round trip: it is decidable from
// the token alone, and making it free denies an attacker a cheap way to make us
// query.
//
// THE CACHE is the plan's "device public keys — in-process cache". It holds
// MISSES as well as hits, so an unknown thumbprint costs one lookup per ttl
// rather than one per request. The price is that a revocation performed in
// ANOTHER process is invisible for up to ttlMs; the revoke route invalidates
// its own entry, so a single-replica deployment (slice 1) sees it at once.
// Keep the ttl small — this is a liveness/latency trade, not a security one.
// ============================================================================
import { timingSafeEqual } from 'node:crypto';
import type { BindingOutcome } from './dpop.js';
import type { LiveDevice } from '../db/devices.js';

export interface BindingResolverOptions {
  findLiveDevice: (userId: string, jkt: string) => Promise<LiveDevice | undefined>;
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

export interface BindingResolver {
  /** Per-request resolver, closed over the token's subject and its cnf.jkt. */
  for(userId: string, cnfJkt?: string | undefined): (jkt: string) => Promise<BindingOutcome>;
  /** Drop one entry — called by enrolment and revocation so they take effect now. */
  invalidate(userId: string, jkt: string): void;
  readonly size: number;
}

interface CacheEntry {
  at: number;
  deviceId: string | undefined;
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function createBindingResolver(options: BindingResolverOptions): BindingResolver {
  if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
    throw new Error(`binding cache ttlMs must be a positive number, got ${options.ttlMs}`);
  }
  if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) {
    throw new Error(`binding cache maxEntries must be a positive integer, got ${options.maxEntries}`);
  }
  const clock = options.now ?? Date.now;
  const cache = new Map<string, CacheEntry>();
  const keyOf = (userId: string, jkt: string): string => `${userId}|${jkt}`;

  const lookup = async (userId: string, jkt: string): Promise<string | undefined> => {
    const key = keyOf(userId, jkt);
    const now = clock();
    const hit = cache.get(key);
    if (hit !== undefined && now - hit.at <= options.ttlMs) return hit.deviceId;

    const device = await options.findLiveDevice(userId, jkt);
    cache.delete(key);
    cache.set(key, { at: now, deviceId: device?.deviceId });
    if (cache.size > options.maxEntries) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
    return device?.deviceId;
  };

  return {
    for(userId, cnfJkt) {
      return async (jkt) => {
        if (cnfJkt !== undefined && !equals(cnfJkt, jkt)) return { bound: false };
        const deviceId = await lookup(userId, jkt);
        return deviceId === undefined ? { bound: false } : { bound: true, deviceId };
      };
    },

    invalidate(userId, jkt) {
      cache.delete(keyOf(userId, jkt));
    },

    get size() {
      return cache.size;
    },
  };
}
