/**
 * THE 401 MINT STORM, MEASURED AND PINNED.
 *
 * A review measured 50 distinct subjects against a permanently-401 OpenFGA and
 * counted 26 token mints. The per-subject reasoning predicts two: one cold
 * mint, one forced re-mint, then the retry is spent and the subject denies.
 * Two is true of ONE subject and is what the unit test for it measures. It is
 * not true of a fleet, and the fleet number is what an identity provider's
 * capacity has to be planned against.
 *
 * WHAT THE COUNTERS SAY, and they are the reason this file exists rather than
 * another round of reasoning. Measured here, identically on 24 consecutive
 * runs including under two concurrent full suites:
 *
 *   CONCURRENT   50 subjects, one tick apart
 *     checks 100   mints 26   cold 1   forced 25
 *     refresh_requested 50   refresh_discarded 25   coalesced 74   peak 50
 *
 *   SEQUENTIAL   50 subjects, one after another
 *     checks 100   mints 51   cold 1   forced 50
 *     refresh_requested 50   refresh_discarded 50   cache_hit 49   peak 1
 *
 * THE MECHANISM, which the `refresh_discarded` column settles. Every subject's
 * 401 retry calls for a refresh, and a refresh throws away the PROCESS-WIDE
 * token. Concurrently, half those callers arrive while someone else's re-mint
 * is still in flight, find an empty cache, and coalesce — so the storm is
 * damped to one mint per two subjects by nothing but arrival timing.
 * Sequentially there is no such accident: each subject reads the previous
 * subject's fresh token out of the cache (`cache_hit` 49), is refused with it,
 * and throws it away (`refresh_discarded` 50). One mint per subject, plus the
 * cold one.
 *
 * WHY THE OBVIOUS FIX MEASURED IDENTICAL. The candidate was "invalidate the
 * caller's own token, not the process-wide one". Its predicate is
 * `the cached token is the one I presented` — and these numbers show that is
 * TRUE for every caller in both shapes: concurrently they all hold the single
 * wave-one token, sequentially each holds the one it just cache-hit. A
 * predicate that is always true is a no-op, which is exactly what "measured
 * identical" means. It was not a failed fix; it was not a fix.
 *
 * THIS FILE DOES NOT FIX IT. It pins the shape so that a change to the retry
 * path cannot move these numbers silently, in either direction — the target of
 * one mint per five subjects is asserted as NOT met, so reaching it turns this
 * file red and whoever reaches it has to say so here.
 *
 * NOTHING FAILS OPEN. Every one of these requests denies; the per-subject retry
 * bound is honoured exactly (100 checks for 50 subjects, never a loop). This is
 * a load fact about the identity provider, not a correctness or security
 * defect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  entitlementGrantCounters,
  grantsForSubject,
  resetEntitlementGrantsForTest,
} from '../../src/entitlements/grants.js';
import {
  openFgaTokenCounters,
  resetOpenFgaTokenForTest,
} from '../../src/entitlements/openfgaToken.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';
import { startFakeTokenEndpoint, type FakeTokenEndpoint } from '../helpers/fakeTokenEndpoint.js';

const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const T0 = 1_780_000_000_000;
const SUBJECTS = 50;
/** The fleet target: no more than one mint per five subjects under a 401. NOT met. */
const TARGET_MINT_FRACTION = 0.4;
const PASSWORD = 'app-password-never-print-me';

let fga: FakeOpenFga;
let idp: FakeTokenEndpoint;
let printed: unknown[][];

/** Distinct, well-formed Authentik user uuids — the grant cache is keyed on them. */
const subjects = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `7f3a1c62-9d44-4e51-8b0a-${String(i).padStart(12, '0')}`);

const env = (): NodeJS.ProcessEnv =>
  ({
    OPENFGA_API_URL: fga.baseUrl,
    OPENFGA_STORE_ID: STORE,
    OPENFGA_OIDC_TOKEN_ENDPOINT: idp.url,
    OPENFGA_OIDC_CLIENT_ID: 'openfga',
    OPENFGA_OIDC_USERNAME: 'svc-openfga-fc-coordinator',
    OPENFGA_OIDC_PASSWORD: PASSWORD,
  }) as NodeJS.ProcessEnv;

/** Fifty subjects arriving in one tick, all refused. */
const stormConcurrent = async (): Promise<ReadonlyArray<readonly string[]>> => {
  fga.reply({ status: 401, body: { code: 'unauthenticated' } });
  return Promise.all(subjects(SUBJECTS).map((s) => grantsForSubject(s, T0, env())));
};

/** The same fifty, one after another. */
const stormSequential = async (): Promise<void> => {
  fga.reply({ status: 401, body: { code: 'unauthenticated' } });
  for (const s of subjects(SUBJECTS)) await grantsForSubject(s, T0, env());
};

beforeEach(async () => {
  fga = await startFakeOpenFga(() => true);
  idp = await startFakeTokenEndpoint();
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  printed = [];
  for (const level of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      printed.push(args);
    });
  }
});

afterEach(async () => {
  await fga.close();
  await idp.close();
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

describe('50 subjects against a permanently unauthenticated OpenFGA', () => {
  it('honours the per-subject retry bound exactly — the storm is in mints, not checks', async () => {
    // FIRST, because it is the part that is NOT broken and the part a reader
    // will otherwise assume is. Two checks per subject, no loop, every subject
    // denied. Whatever the mint count does, this is the bound that holds.
    const results = await stormConcurrent();

    expect(results.every((grants) => grants.length === 0)).toBe(true);
    expect(fga.calls).toHaveLength(SUBJECTS * 2);
    expect(entitlementGrantCounters()['reminted']).toBe(SUBJECTS);
    expect(entitlementGrantCounters()['error']).toBe(SUBJECTS);
  }, 60_000);

  it('CONCURRENT: costs one mint per two subjects, and misses the one-per-five target', async () => {
    await stormConcurrent();

    // The headline, as a band rather than a point: the interleaving is driven
    // by socket-callback ordering and measured identically 24 times here, but
    // this must not go red on a runner that schedules two callbacks
    // differently. What it must NOT tolerate is the target being met — see the
    // next assertion.
    expect(idp.calls.length).toBeGreaterThan(SUBJECTS * 0.4);
    expect(idp.calls.length).toBeLessThanOrEqual(SUBJECTS * 0.6);

    // THE TARGET IS PINNED AS UNMET. When someone fixes the retry path this
    // line is what turns red, which is the point: a fix must arrive with a
    // measurement, not as a quiet improvement nobody recorded.
    expect(idp.calls.length).toBeGreaterThan(SUBJECTS * TARGET_MINT_FRACTION);
  }, 60_000);

  it('CONCURRENT: every extra mint is a forced refresh that took a live token off someone', async () => {
    await stormConcurrent();
    const c = openFgaTokenCounters();

    // Deterministic regardless of interleaving: one refresh per retrying
    // subject, exactly one cold mint, and the rest of the mints forced.
    expect(c['token_refresh_requested']).toBe(SUBJECTS);
    expect(c['token_mint_cold']).toBe(1);
    expect(c['token_mint']).toBe(1 + (c['token_mint_forced'] ?? 0));

    // THE MECHANISM. A forced refresh either discards a live token and mints,
    // or finds the cache already empty — a re-mint in flight — and coalesces.
    // The two together account for every retrying subject, and the discards
    // account for every forced mint. That equality is the storm's whole shape.
    expect(c['token_mint_forced']).toBe(c['token_refresh_discarded']);
    // The cold wave coalesced 49 of the 50; everything above that belongs to
    // the retry wave, and discards plus retry-coalesces account for all fifty
    // retrying subjects with nothing left over.
    const coldWaveCoalesced = SUBJECTS - 1;
    const retryCoalesced = (c['token_coalesced'] ?? 0) - coldWaveCoalesced;
    expect((c['token_refresh_discarded'] ?? 0) + retryCoalesced).toBe(SUBJECTS);

    // All fifty arrived inside one tick, which is why the cold wave cost one
    // mint and not fifty. The single-flight guarantee is intact; it just does
    // not reach the retry wave, because those do not arrive together.
    expect(c['token_inflight_peak']).toBe(SUBJECTS);
  }, 60_000);

  it('SEQUENTIAL: costs MORE than one mint per subject, because nothing coalesces', async () => {
    // The worse shape, and the realistic one for a service answering ordinary
    // traffic rather than a thundering herd. Fully deterministic — there is no
    // concurrency for the interleaving to vary.
    await stormSequential();
    const c = openFgaTokenCounters();

    expect(idp.calls.length).toBe(SUBJECTS + 1);
    expect(c['token_mint_cold']).toBe(1);
    expect(c['token_mint_forced']).toBe(SUBJECTS);

    // EVERY retry threw away a live token, and every FIRST attempt read the
    // previous subject's token out of the cache. That is the storm stated
    // plainly: fifty callers taking turns to discard each other's credential.
    expect(c['token_refresh_discarded']).toBe(SUBJECTS);
    expect(c['token_cache_hit']).toBe(SUBJECTS - 1);
    expect(c['token_coalesced']).toBeUndefined();
    expect(c['token_inflight_peak']).toBe(1);
  }, 60_000);

  it('prints neither the token nor the service password, storm or no storm', async () => {
    // A hundred failures produce a hundred log lines, which is the condition
    // under which a leak is least likely to be noticed and most likely to be
    // shipped to an aggregator. The module's hygiene rule is asserted at the
    // volume that tests it.
    await stormConcurrent();

    expect(printed.length).toBeGreaterThan(0);
    const text = JSON.stringify(printed);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain('token-1');
    expect(text).not.toContain('Bearer');
  }, 60_000);
});
