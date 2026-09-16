/**
 * ONE case, in its OWN file: the mint's promise that it NEVER THROWS, proven at
 * the only point that is otherwise unreachable — a signing call that fails
 * after a perfectly good Ed25519 key has already loaded.
 *
 * WHY A SEPARATE FILE. Reaching that point needs `node:crypto`'s `sign` to be
 * replaceable, and it is a non-configurable property, so vi.spyOn cannot touch
 * it — only a module factory can. Doing that in the main suite would substitute
 * the crypto module for every test in it, including the ones whose whole job is
 * to run REAL Ed25519. Here the blast radius is this file, and the factory
 * delegates to the real module for everything except the one call under test.
 *
 * WHY THE GUARANTEE MATTERS. A read that would have succeeded with stock
 * magnitudes withheld must never become a 500 because the signing layer had a
 * bad moment. Degrade to showing less; never to failing.
 *
 * Ported from fc-backend tests/services/entitlements/signing-failure.test.ts.
 * `jest.mock` + `jest.requireActual` become `vi.mock` + `importOriginal`, and
 * the mutable flag moves into `vi.hoisted` because vi.mock factories are
 * hoisted above every other statement in the file.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const mockState = vi.hoisted(() => ({ signThrows: false }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    default: actual,
    sign: (...args: unknown[]) => {
      if (mockState.signThrows) throw new Error('signing backend unavailable');
      return (actual.sign as unknown as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import * as crypto from 'node:crypto';
import { INVENTORY_LEVELS } from '@figurecollecting/ingest-contract/entitlement';
import {
  mintEntitlementAssertion,
  entitlementMintCounters,
  resetEntitlementSigningForTest,
} from '../../src/entitlements/assertion.js';

const KID = 'ent-test-2026-09';
const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';

describe('mintEntitlementAssertion — a failing signing layer', () => {
  const saved = {
    pem: process.env['ENTITLEMENT_SIGNING_KEY_PEM'],
    kid: process.env['ENTITLEMENT_SIGNING_KID'],
  };
  let warnSpy: MockInstance<typeof console.warn>;
  let privatePem: string;

  beforeEach(() => {
    resetEntitlementSigningForTest();
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    mockState.signThrows = false;
    warnSpy.mockRestore();
    resetEntitlementSigningForTest();
    if (saved.pem === undefined) delete process.env['ENTITLEMENT_SIGNING_KEY_PEM'];
    else process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = saved.pem;
    if (saved.kid === undefined) delete process.env['ENTITLEMENT_SIGNING_KID'];
    else process.env['ENTITLEMENT_SIGNING_KID'] = saved.kid;
  });

  it('mints normally while the signing layer is healthy', () => {
    expect(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] })).not.toBeNull();
  });

  it('returns null, warns, and never throws when signing fails', () => {
    mockState.signThrows = true;

    expect(() => mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] })).not.toThrow();
    expect(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] })).toBeNull();
    expect(entitlementMintCounters()['disabled']).toBeGreaterThanOrEqual(1);
    expect(warnSpy).toHaveBeenCalled();
    // Not even in the failure path does the key reach a log line.
    const logged = warnSpy.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('PRIVATE KEY');
    expect(logged).not.toContain(privatePem.trim());
  });
});
