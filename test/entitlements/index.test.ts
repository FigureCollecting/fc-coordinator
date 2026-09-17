/**
 * THE MODULE'S PUBLIC SURFACE.
 *
 * A module whose whole promise is "copy this directory into another service"
 * has an API that is a contract, not an accident: the porting target imports
 * these names, and anything not on this list is an internal the next refactor
 * may move. Pinning the set here means widening it is a deliberate edit rather
 * than a side effect of exporting something for one test's convenience.
 *
 * Ported from fc-backend tests/services/entitlements/index.test.ts. The set is
 * UNCHANGED by the port, which is the claim worth pinning: fc-coordinator
 * consumes exactly the surface fc-backend did.
 */
import { describe, expect, it } from 'vitest';
import * as entitlements from '../../src/entitlements/index.js';

const EXPECTED_FUNCTIONS = [
  // the one call a host application needs
  'entitlementHeaderFor',
  // its two halves, exported for callers that want them separately
  'grantsForSubject',
  'mintEntitlementAssertion',
  // boot
  'initEntitlementSigning',
  'initOpenFgaAuth',
  // the identity rule, exported so a host can check its own source against it
  'isEntitlementSubject',
  // observability
  'entitlementGrantCounters',
  'entitlementMintCounters',
  // the OpenFGA credential: which path is active, and its counters
  'describeOpenFgaAuth',
  'openFgaAuthMode',
  'openFgaTokenCounters',
  // the caller-side audit trail: the host installs its own logger
  'setEntitlementAuditSink',
  // test seams
  'resetEntitlementGrantsForTest',
  'resetEntitlementSigningForTest',
  'resetOpenFgaTokenForTest',
].sort();

/** Exported values that are not functions. */
const EXPECTED_VALUES = ['ENTITLEMENT_SUBJECT_PATTERN'].sort();

describe('src/entitlements public surface', () => {
  it('exports exactly the documented names', () => {
    expect(Object.keys(entitlements).sort()).toEqual(
      [...EXPECTED_FUNCTIONS, ...EXPECTED_VALUES].sort(),
    );
  });

  it.each(EXPECTED_FUNCTIONS)('%s is callable', (name) => {
    expect(typeof (entitlements as unknown as Record<string, unknown>)[name]).toBe('function');
  });

  it('ENTITLEMENT_SUBJECT_PATTERN is the uuid rule the write side uses', () => {
    // Pinned against fc-infra tools/entitlements/grant-inventory-levels.sh, so
    // a read side that accepts what the write side refuses cannot ship.
    expect(
      entitlements.ENTITLEMENT_SUBJECT_PATTERN.test('7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33'),
    ).toBe(true);
    expect(entitlements.ENTITLEMENT_SUBJECT_PATTERN.test('68c1f0a9b2d4e5f6a7b8c9d0')).toBe(false);
  });

  it('the guard and the pattern agree', () => {
    expect(entitlements.isEntitlementSubject('7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33')).toBe(true);
    expect(entitlements.isEntitlementSubject('ross@example.com')).toBe(false);
    expect(entitlements.isEntitlementSubject(undefined)).toBe(false);
  });
});
