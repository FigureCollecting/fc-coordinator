import { SERVER_DEVICE_ID, compareVersion, isCanonicalVersion } from '@figurecollecting/fc-api-contract';
import { describe, expect, it } from 'vitest';
import { importVersion, writeVersion } from './version.js';

const Z = SERVER_DEVICE_ID;

describe('importVersion', () => {
  it('is <server instant>#<import number>#<reserved server device>', () => {
    expect(importVersion('2026-10-07T12:00:00.123456Z', 3)).toBe(`2026-10-07T12:00:00.123456Z#0000000003#${Z}`);
  });
});

describe('writeVersion', () => {
  const V = importVersion('2026-10-07T12:00:00.123456Z', 3);

  it("is the import's version over a facet it is above, or a facet that has none", () => {
    expect(writeVersion(V, undefined)).toBe(V);
    expect(writeVersion(V, '2026-10-07T11:59:59.999999Z#0000000009#ffffffffffffffffffffffffffffffff')).toBe(V);
  });

  it("is minted just above a facet's version that is not below it: the next counter, on the server device", () => {
    const device = '2026-10-07T12:03:00.000000Z#0000000004#0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
    expect(writeVersion(V, device)).toBe(`2026-10-07T12:03:00.000000Z#0000000005#${Z}`);
    expect(writeVersion(V, V)).toBe(`2026-10-07T12:00:00.123456Z#0000000004#${Z}`);
  });

  it('lifts a bare instant to its first full version, and carries a spent counter into the next microsecond', () => {
    expect(writeVersion(V, '2026-10-07T12:05:00.000000Z')).toBe(`2026-10-07T12:05:00.000000Z#0000000000#${Z}`);
    expect(writeVersion(V, `2026-10-07T12:05:00.999999Z#9999999999#${'f'.repeat(32)}`)).toBe(`2026-10-07T12:05:01.000000Z#0000000000#${Z}`);
    expect(writeVersion(V, `2026-12-31T23:59:59.999999Z#9999999999#${'f'.repeat(32)}`)).toBe(`2027-01-01T00:00:00.000000Z#0000000000#${Z}`);
  });

  it('always mints a canonical version above the one it is given', () => {
    for (const current of [V, '2026-10-07T12:05:00.000000Z', `2026-10-07T12:05:00.999999Z#9999999999#${'f'.repeat(32)}`, `2030-01-01T00:00:00.000001Z#0000000000#${Z}`]) {
      const next = writeVersion(V, current);
      expect(isCanonicalVersion(next)).toBe(true);
      expect(compareVersion(next, current)).toBe(1);
    }
  });
});
