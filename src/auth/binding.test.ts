import { describe, expect, it } from 'vitest';
import { createBindingResolver } from './binding.js';
import type { LiveDevice } from '../db/devices.js';

const USER = 'e7f3b4c1-2d5a-4f8e-9b6c-1a2b3c4d5e6f';
const OTHER_USER = 'aa11bb22-cc33-4d44-9e55-ff6677889900';
const JKT = 'thumbprint-A';

function store(live: Record<string, string> = { [`${USER}|${JKT}`]: 'device-1' }) {
  const calls: string[] = [];
  return {
    calls,
    findLiveDevice: async (userId: string, jkt: string): Promise<LiveDevice | undefined> => {
      calls.push(`${userId}|${jkt}`);
      const deviceId = live[`${userId}|${jkt}`];
      return deviceId ? { deviceId, jkt } : undefined;
    },
  };
}

describe('createBindingResolver', () => {
  it('binds a live enrolled device', async () => {
    const devices = store();
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 5_000, maxEntries: 10 });
    expect(await resolver.for(USER)(JKT)).toEqual({ bound: true, deviceId: 'device-1' });
  });

  it('refuses a thumbprint this user has not enrolled', async () => {
    const devices = store();
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 5_000, maxEntries: 10 });
    expect(await resolver.for(USER)('unknown-thumb')).toEqual({ bound: false });
  });

  it('refuses one user’s key presented for ANOTHER user’s token', async () => {
    const devices = store();
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 5_000, maxEntries: 10 });
    expect(await resolver.for(OTHER_USER)(JKT)).toEqual({ bound: false });
  });

  it('caches a HIT so a burst of requests is one lookup', async () => {
    const devices = store();
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 5_000, maxEntries: 10 });
    await resolver.for(USER)(JKT);
    await resolver.for(USER)(JKT);
    await resolver.for(USER)(JKT);
    expect(devices.calls).toHaveLength(1);
  });

  it('caches a MISS too, so an unknown thumbprint cannot be used to hammer Postgres', async () => {
    const devices = store();
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 5_000, maxEntries: 10 });
    await resolver.for(USER)('junk');
    await resolver.for(USER)('junk');
    expect(devices.calls).toHaveLength(1);
  });

  it('re-reads once the entry is older than the ttl', async () => {
    const now = { value: 0 };
    const devices = store();
    const resolver = createBindingResolver({
      findLiveDevice: devices.findLiveDevice,
      ttlMs: 1_000,
      maxEntries: 10,
      now: () => now.value,
    });
    await resolver.for(USER)(JKT);
    now.value = 1_001;
    await resolver.for(USER)(JKT);
    expect(devices.calls).toHaveLength(2);
  });

  it('invalidate() makes a revocation take effect at once, not after the ttl', async () => {
    const live: Record<string, string> = { [`${USER}|${JKT}`]: 'device-1' };
    const devices = store(live);
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 60_000, maxEntries: 10 });

    expect((await resolver.for(USER)(JKT)).bound).toBe(true);
    delete live[`${USER}|${JKT}`];
    expect((await resolver.for(USER)(JKT)).bound).toBe(true); // still cached

    resolver.invalidate(USER, JKT);
    expect(await resolver.for(USER)(JKT)).toEqual({ bound: false });
  });

  it('bounds the cache and evicts the oldest entry', async () => {
    const devices = store();
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 60_000, maxEntries: 2 });
    await resolver.for(USER)('a');
    await resolver.for(USER)('b');
    await resolver.for(USER)('c');
    expect(resolver.size).toBe(2);
    await resolver.for(USER)('a');
    expect(devices.calls).toHaveLength(4);
  });

  it('PREFERS cnf.jkt when the token carries one, and refuses a mismatch without touching the database', async () => {
    const devices = store();
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 5_000, maxEntries: 10 });
    expect(await resolver.for(USER, 'a-different-thumbprint')(JKT)).toEqual({ bound: false });
    expect(devices.calls).toHaveLength(0);
  });

  it('still requires a LIVE device row when cnf.jkt matches, so revocation survives an IdP-bound token', async () => {
    const devices = store({});
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 5_000, maxEntries: 10 });
    expect(await resolver.for(USER, JKT)(JKT)).toEqual({ bound: false });
    expect(devices.calls).toHaveLength(1);
  });

  it('binds when cnf.jkt matches AND the device is live', async () => {
    const devices = store();
    const resolver = createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 5_000, maxEntries: 10 });
    expect(await resolver.for(USER, JKT)(JKT)).toEqual({ bound: true, deviceId: 'device-1' });
  });

  it('rejects a non-positive ttl or cap', () => {
    const devices = store();
    expect(() =>
      createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 0, maxEntries: 10 }),
    ).toThrow(/ttlMs/);
    expect(() =>
      createBindingResolver({ findLiveDevice: devices.findLiveDevice, ttlMs: 10, maxEntries: 0 }),
    ).toThrow(/maxEntries/);
  });
});
