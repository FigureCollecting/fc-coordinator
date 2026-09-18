/**
 * THE 401 MINT STORM — MEASURED, HALF FIXED, AND PINNED BOTH WAYS.
 *
 * A review measured 50 distinct subjects against a permanently-401 OpenFGA and
 * counted 26 token mints. The per-subject reasoning predicts two: one cold
 * mint, one forced re-mint, then the retry is spent and the subject denies.
 * Two is true of ONE subject and is what the unit test for it measures. It is
 * not true of a fleet, and the fleet number is what a shared identity provider
 * has to be sized for.
 *
 * THE MECHANISM. Every subject's 401 retry asked for a refresh, and a refresh
 * threw away the PROCESS-WIDE token — including the one a neighbour had just
 * minted and twenty-five others were about to use.
 *
 * A NOTE ON HOW THIS WAS GOT WRONG ONCE, because the correction is the
 * interesting part. The first pass concluded that targeting the invalidation —
 * discard only the token the caller was actually refused with — could not help,
 * on the grounds that every caller holds the cached token anyway. That was an
 * artifact of the harness: test/helpers/fakeTokenEndpoint.ts handed out the
 * constant `token-1` on every request, so "is the cached token the one I
 * presented?" answered yes by string identity whatever had happened in between.
 * Authentik issues a distinct JWT per grant. Re-measured against distinct
 * tokens the same change takes the concurrent shape from 26 mints to 2, and the
 * numbers below are that measurement. The fake now mints distinct tokens by
 * default and this file asserts that it does, because the assumption that hid a
 * working fix is exactly the kind that should not be left implicit.
 *
 * WHAT IS FIXED, and what is not. Concurrently, one re-mint now serves the
 * whole fleet: the first retry discards the token it was refused with, and the
 * other forty-nine find a token they have not tried and take it. Sequentially
 * nothing is fixed and nothing can be by this change — a subject arriving after
 * the previous one finished reads the current token out of the cache, is
 * refused with it, and so genuinely IS holding the cached one. That shape still
 * costs one mint per subject and is pinned below as open.
 *
 * NOTHING FAILS OPEN. Every one of these requests denies and the per-subject
 * retry bound holds exactly — 100 checks for 50 subjects, never a loop.
 */
import { inspect } from 'node:util';
import { Code } from '@connectrpc/connect';
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
/**
 * The ceiling for the concurrent shape. Measured 2 — one cold mint and one
 * re-mint — and pinned with headroom rather than exactly, because the retry
 * wave's interleaving is a runner's business. Two is also the FLOOR: the
 * credential is genuinely being refused, so one re-mint has to happen.
 */
const CONCURRENT_MINT_CEILING = 5;
const PASSWORD = 'app-password-never-print-me';
/**
 * Hung off every refusal as gRPC response metadata. It stands in for anything
 * the far side might attach to an error — a session cookie from an ingress, an
 * internal hostname, a request id that identifies a user — and it is here
 * because a ConnectError CARRIES that metadata, which the axios error did not.
 * The leak it guards is `console.error(err)` instead of `console.error(err.message)`.
 */
const SERVER_METADATA_SECRET = 'trailer-secret-never-print-me';

let fga: FakeOpenFga;
let idp: FakeTokenEndpoint;
let printed: unknown[][];

/** Distinct, well-formed Authentik user uuids — the grant cache is keyed on them. */
const subjects = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `7f3a1c62-9d44-4e51-8b0a-${String(i).padStart(12, '0')}`);

const env = (): NodeJS.ProcessEnv =>
  ({
    OPENFGA_GRPC_URL: fga.baseUrl,
    OPENFGA_STORE_ID: STORE,
    OPENFGA_OIDC_TOKEN_ENDPOINT: idp.url,
    OPENFGA_OIDC_CLIENT_ID: 'openfga',
    OPENFGA_OIDC_USERNAME: 'svc-openfga-fc-coordinator',
    OPENFGA_OIDC_PASSWORD: PASSWORD,
  }) as NodeJS.ProcessEnv;

/** Fifty subjects arriving in one tick, all refused. */
const stormConcurrent = async (): Promise<ReadonlyArray<readonly string[]>> => {
  fga.reply({ code: Code.Unauthenticated, metadata: { 'x-fake-trailer': SERVER_METADATA_SECRET } });
  return Promise.all(subjects(SUBJECTS).map((s) => grantsForSubject(s, T0, env())));
};

/** The same fifty, one after another. */
const stormSequential = async (): Promise<void> => {
  fga.reply({ code: Code.Unauthenticated, metadata: { 'x-fake-trailer': SERVER_METADATA_SECRET } });
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
  it('is measured against an IdP that mints a DISTINCT token per grant', async () => {
    // THE PREMISE OF EVERY OTHER CASE IN THIS FILE, asserted rather than
    // assumed. It was assumed once, wrongly, and a constant-token fake turned a
    // working fix into an apparent no-op — see the header. If this file is ever
    // re-pointed at a pinned reply, this is what says so.
    await stormConcurrent();

    expect(idp.issued.length).toBe(idp.calls.length);
    expect(new Set(idp.issued).size).toBe(idp.issued.length);

    // And the module's own counter agrees with the socket's request log, so a
    // mis-attributed or double-bumped counter cannot hide behind it. Every
    // headline number in this file is the SOCKET's, never the module's.
    expect(openFgaTokenCounters()['token_mint']).toBe(idp.calls.length);
  }, 60_000);

  it('honours the per-subject retry bound exactly — the storm was in mints, not checks', async () => {
    // The part that was never broken, first, because a reader will otherwise
    // assume it was. Two checks per subject, no loop, every subject denied.
    const results = await stormConcurrent();

    expect(results.every((grants) => grants.length === 0)).toBe(true);
    expect(fga.calls).toHaveLength(SUBJECTS * 2);
    expect(entitlementGrantCounters()['reminted']).toBe(SUBJECTS);
    expect(entitlementGrantCounters()['error']).toBe(SUBJECTS);
  }, 60_000);

  it('CONCURRENT: one re-mint serves the whole fleet — was 26, now 2', async () => {
    // RE-MEASURED AFTER THE MOVE TO gRPC, and the headline is unchanged: 2.
    // Three consecutive runs gave exactly 2 where the HTTP measurement gave 2
    // with more spread, because one multiplexed connection makes the retry wave
    // tighter rather than wider.
    await stormConcurrent();

    // The headline. A band, not a point: the lower bound catches a fake that
    // stopped being called at all, the upper one catches the storm coming back.
    expect(idp.calls.length).toBeGreaterThanOrEqual(2);
    expect(idp.calls.length).toBeLessThanOrEqual(CONCURRENT_MINT_CEILING);
  }, 60_000);

  it('CONCURRENT: no refresh throws away a token it cannot show was its own', async () => {
    await stormConcurrent();
    const c = openFgaTokenCounters();

    // THE PROPERTY THE FIX ADDS, and it is the one to watch rather than the
    // mint count: a caller may only discard the token it was itself refused
    // with. `token_refresh_blind` is the pre-fix behaviour — clear the cache on
    // trust — and it goes to zero the moment grants.ts names the bearer it
    // sent. Reverting that threading turns this line red, not the count above.
    expect(c['token_refresh_blind']).toBeUndefined();

    // Every retrying subject asked, and the answers account for all of them.
    expect(c['token_refresh_requested']).toBe(SUBJECTS);
    expect(
      (c['token_refresh_discarded'] ?? 0) +
        (c['token_refresh_superseded'] ?? 0) +
        (c['token_refresh_empty'] ?? 0) +
        (c['token_refresh_blind'] ?? 0),
    ).toBe(SUBJECTS);

    // WHICH PROTECTED OUTCOME THEY GOT MOVED WITH THE TRANSPORT, and the
    // measurement is worth writing down rather than smoothing over. Over
    // HTTP/1.1 the fifty 401s came back on many sockets and therefore
    // staggered, so most subjects reached the refresh path after a NEWER token
    // was already cached and were counted `superseded` (measured: more than
    // half). Over gRPC all fifty streams are multiplexed on ONE h2 connection,
    // so the refusals arrive in one batch: the first subject discards the token
    // it presented and the other forty-nine find the cache already EMPTY.
    // Measured, and identical across three runs: discarded 1, empty 49,
    // superseded 0.
    //
    // BOTH ARE THE PROTECTED OUTCOME — neither throws away a token it cannot
    // show was its own — so the assertion is on the property rather than on
    // whichever of the two the interleaving produces. The one that must never
    // appear is `blind`, asserted above.
    expect((c['token_refresh_discarded'] ?? 0) + (c['token_refresh_empty'] ?? 0)).toBe(SUBJECTS);
    // At most a handful discarded, which is the same claim the mint ceiling
    // makes from the other side: a discard is what buys a forced mint.
    expect(c['token_refresh_discarded'] ?? 0).toBeLessThanOrEqual(CONCURRENT_MINT_CEILING);

    // One cold mint, and every forced mint bought by a discard of the caller's
    // own token. Single flight is intact: all fifty arrived in one tick.
    expect(c['token_mint_cold']).toBe(1);
    expect(c['token_mint_forced']).toBe(c['token_refresh_discarded']);
    expect(c['token_inflight_peak']).toBe(SUBJECTS);
  }, 60_000);

  it('SEQUENTIAL: still one mint per subject — the KNOWN OPEN shape', async () => {
    // NOT FIXED, and not fixable by naming the presented token. Each subject
    // reads the previous subject's fresh token out of the cache (cache_hit 49),
    // is refused with it, and so genuinely IS holding the cached one — the
    // guard has nothing to catch. Fully deterministic: no concurrency for an
    // interleaving to vary, so this is pinned exactly.
    //
    // THIS IS THE SHAPE ORDINARY TRAFFIC HAS, and it is the worse one. With
    // ENTITLEMENT_GRANT_ERROR_TTL_MS at 5 s each active subject re-asks every
    // five seconds, so a persistent 401 sustains roughly (active subjects) / 5
    // successful password grants per second against an Authentik shared with
    // the user plane. Closing it needs a damper the module declines by name:
    // (b) a short negative memory after a re-mint that was also refused, or
    // (c) a token-bucket bound on forced mints. Its own unit, its own round.
    await stormSequential();
    const c = openFgaTokenCounters();

    expect(idp.calls.length).toBe(SUBJECTS + 1);
    expect(c['token_mint_cold']).toBe(1);
    expect(c['token_mint_forced']).toBe(SUBJECTS);
    expect(c['token_refresh_discarded']).toBe(SUBJECTS);
    expect(c['token_refresh_superseded']).toBeUndefined();
    expect(c['token_cache_hit']).toBe(SUBJECTS - 1);
    expect(c['token_inflight_peak']).toBe(1);
  }, 60_000);

  it('prints neither a token nor the service password, storm or no storm', async () => {
    // A hundred failures produce a hundred log lines, which is the condition
    // under which a leak is least likely to be noticed and most likely to be
    // shipped to an aggregator. The module's hygiene rule is asserted at the
    // volume that tests it.
    //
    // THE VECTOR CHANGED WITH THE TRANSPORT, and the assertion had to follow it
    // rather than be carried over. Under axios the danger was logging the error
    // OBJECT, whose serialised request config carried the bearer we sent. A
    // ConnectError carries no request config — but it does carry `metadata`,
    // the response headers and trailers, and Node's inspector prints a Headers
    // object's contents. So the leak is now the far side's data rather than
    // ours, and the fake attaches a secret-shaped trailer to every refusal so
    // that `console.error(err)` in place of `console.error(err.message)` turns
    // this red. The three original assertions stay: a mutation that started
    // logging the whole error, or the auth headers, still has to get past them.
    await stormConcurrent();

    expect(printed.length).toBeGreaterThan(0);
    // JSON.stringify alone would MISS this: a Headers object serialises to
    // `{}`, so the leak it is guarding would be invisible to it. The log is
    // therefore also rendered the way a console renders it.
    const text =
      JSON.stringify(printed) +
      printed.map((line) => line.map((arg) => inspect(arg)).join(' ')).join('\n');
    expect(text).not.toContain(PASSWORD);
    // Any of them, not just the first: the IdP mints a distinct token per grant
    // and a leak of the twenty-sixth is a leak.
    expect(text).not.toMatch(/token-\d+/);
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain(SERVER_METADATA_SECRET);
  }, 60_000);
});
