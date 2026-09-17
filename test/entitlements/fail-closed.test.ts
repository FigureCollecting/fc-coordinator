/**
 * FAIL-CLOSED, RE-EARNED RATHER THAN RE-TYPED.
 *
 * Under axios this file was PINNING a property the module got for free: axios's
 * default `validateStatus` rejects every non-2xx, so a mesh partition arriving
 * as a fast 504 from the sidecar already denied without grants.ts doing
 * anything. The D5b review's warning — that fail-closed logic keying on a
 * thrown connection error would sail past a served 504 — was a correction to
 * the review, not to the code.
 *
 * OVER gRPC THERE IS NOTHING TO INHERIT. There is no status class, no
 * `validateStatus`, and no default to lean on: a unary call either resolves
 * with a message or THROWS a ConnectError carrying a Code, and every code —
 * the partition, the refusal, the deadline, the crash — arrives the same way.
 * So the rule is now written out in full in grants.ts, and it is written as a
 * TOTAL one: the only path that returns a grant is the one that received a
 * message with `allowed === true`, and the catch enumerates no codes at all.
 * Enumerating them is how the class nobody thought of becomes the class that
 * fails open, which is exactly what the redirect case was under HTTP.
 *
 * WHAT MAKES THESE PINS RATHER THAN DECORATION. The fake grants every Check it
 * is not told to refuse (`decide: () => true`), so a mutation that treated an
 * error as "ask the server anyway", or that fell back to the cached decision,
 * or that dropped the catch and let the rejection escape, changes the result
 * here — to a grant, or to a thrown read. A body of `{"allowed": true}` was the
 * mutation killer under HTTP; a fake that would otherwise say yes is its gRPC
 * equivalent.
 *
 * THE SECOND HALF IS THE SOURCE. A behavioural suite cannot catch every way the
 * rule could be loosened, and it cannot catch the transport quietly coming back
 * at all, so the file also asserts what grants.ts does NOT contain.
 */
// Inert unless CLOCK_STEP_MS is set — see the helper.
import '../helpers/steppingClock.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Code } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  entitlementGrantCounters,
  entitlementHeaderFor,
  grantsForSubject,
  resetEntitlementGrantsForTest,
  resetEntitlementSigningForTest,
  resetOpenFgaTokenForTest,
  setEntitlementAuditSink,
  type EntitlementAuditEvent,
} from '../../src/entitlements/index.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const KID = 'ent-test-2026-09';
const T0 = 1_780_000_000_000;

let fga: FakeOpenFga;
let events: EntitlementAuditEvent[];

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ OPENFGA_GRPC_URL: fga.baseUrl, OPENFGA_STORE_ID: STORE, ...over }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  // Grants unless told otherwise: every case below has to overcome a yes.
  fga = await startFakeOpenFga(() => true);
  events = [];
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  resetOpenFgaTokenForTest();
  setEntitlementAuditSink((e) => events.push(e));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  setEntitlementAuditSink(null);
  await fga.close();
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

// ===========================================================================
// A NON-OK CODE
// ===========================================================================
describe('a non-OK gRPC code from OpenFGA', () => {
  it.each([
    // The four the C21 acceptance table has to be rewritten around, plus the
    // two that a wrong allowlist or a throttled provider produces.
    ['unauthenticated — a refused credential, nothing re-minted here', Code.Unauthenticated, 'unauthenticated'],
    ['permission_denied — the mesh or the store says no', Code.PermissionDenied, 'permission_denied'],
    ['unavailable — which is what a partition looks like now', Code.Unavailable, 'unavailable'],
    ['deadline_exceeded', Code.DeadlineExceeded, 'deadline_exceeded'],
    ['internal', Code.Internal, 'internal'],
    ['resource_exhausted', Code.ResourceExhausted, 'resource_exhausted'],
  ])('denies on %s', async (_label, code, name) => {
    fga.reply({ code });

    const grants = await grantsForSubject(SUB, T0, env());

    expect(grants).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: name });
    expect(entitlementGrantCounters()['error']).toBe(1);
    expect(entitlementGrantCounters()['allow']).toBeUndefined();
  });

  it('denies on a code no one enumerated, which is the whole point of not enumerating', async () => {
    // `Aborted` appears in no list in grants.ts, in no acceptance table, and in
    // no comment. It still denies, because the rule is "not an explicit yes"
    // rather than "one of these".
    fga.reply({ code: Code.Aborted });

    expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'aborted' });
  });

  it('does not throw the read — a denied caller still gets an answer', async () => {
    // The gRPC client REJECTS where axios rejected, and an uncaught rejection
    // here would turn a redacted read into a 500 at the edge. That is the
    // failure mode the module's header forbids in the strongest terms.
    fga.reply({ code: Code.Internal });

    await expect(grantsForSubject(SUB, T0, env())).resolves.toEqual([]);
  });

  it('sends NO assertion header on an unavailable, so the spine redacts rather than trusting us', async () => {
    const kp = generateTestSigningKey(KID);
    fga.reply({ code: Code.Unavailable });

    const header = await entitlementHeaderFor(
      SUB,
      T0,
      env({ ENTITLEMENT_SIGNING_KEY_PEM: kp.privatePem, ENTITLEMENT_SIGNING_KID: KID }),
    );

    // Not an empty grant list in a signed assertion — no header at all, which
    // is what a denial looks like on the wire.
    expect(header).toBeNull();
  });
});

// ===========================================================================
// THE CALL THAT NEVER LANDED
// ===========================================================================
describe('a request that never reached OpenFGA', () => {
  it('denies on a refused connection, reported as unavailable', async () => {
    // AND THE RECORD SAYS SO IN THE ONLY VOCABULARY IT HAS. Over HTTP this was
    // `reason: transport` with no status, because a refused socket produced no
    // response; gRPC gives a refused connection and a server answering "I am
    // unavailable" the same code, and inventing a distinction the protocol does
    // not carry would be a guess dressed as a fact.
    const grants = await grantsForSubject(SUB, T0, env({ OPENFGA_GRPC_URL: 'http://127.0.0.1:1' }));

    expect(grants).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'unavailable' });
    expect(events[0]?.reason).toBeUndefined();
  });

  it('denies on a timeout rather than hanging the read behind it', async () => {
    // The handler accepts the stream and never answers, which is the only shape
    // that forces the DEADLINE to be what ends the call. An unroutable address
    // would be refused on some hosts and would pass without the deadline ever
    // biting.
    fga.reply({ delayMs: 60_000 });

    const grants = await grantsForSubject(SUB, T0, env({ OPENFGA_TIMEOUT_MS: '100' }));

    expect(grants).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'deadline_exceeded' });
  }, 20_000);
});

// ===========================================================================
// THE ZERO-TIMEOUT TRAP
// ===========================================================================
describe('OPENFGA_TIMEOUT_MS', () => {
  it('refuses zero and falls back to the 2 s default', async () => {
    // THE TRAP CHANGED DIRECTION WITH THE TRANSPORT AND STAYED A TRAP. axios
    // read `timeout: 0` as "wait forever", so a typo hung the read; a gRPC
    // deadline of zero has already expired when the call starts, so the same
    // typo would deny EVERY read instantly instead. Opposite failures, one
    // guard, and the assertion below catches either: a honoured zero returns in
    // milliseconds, and a honoured infinity never returns at all.
    fga.reply({ delayMs: 60_000 });

    // performance.now(), NOT Date.now(): this is an ELAPSED-TIME measurement
    // and Date.now() is not monotonic. The same substitution commit fef12ca
    // made in grants.test.ts, for the same measured reason — a backwards step
    // on this estate's WSL2 hosts subtracts from the elapsed figure, and this
    // assertion sits one second from its boundary. Reproducible on demand:
    // CLOCK_STEP_MS=-2000 turns it red on the Date.now() version.
    const started = performance.now();
    const grants = await grantsForSubject(SUB, T0, env({ OPENFGA_TIMEOUT_MS: '0' }));

    expect(grants).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'deadline_exceeded' });
    expect(performance.now() - started).toBeGreaterThan(1_000);
  }, 20_000);
});

// ===========================================================================
// THE SOURCE ITSELF
// ===========================================================================
describe('the Check call site', () => {
  const source = (): string =>
    fs.readFileSync(path.resolve(import.meta.dirname, '../../src/entitlements/grants.ts'), 'utf8');
  const code = (): string =>
    source()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('has no HTTP client left in it at all', () => {
    // The strongest form of "no fallback": not a disabled path, not a branch
    // behind a flag — nothing to fall back TO. A behavioural test cannot say
    // this, because a dormant HTTP path passes every test that never sets the
    // variable that wakes it.
    expect(code()).not.toMatch(/\baxios\b/);
    expect(code()).not.toMatch(/maxRedirects/);
    expect(code()).not.toMatch(/validateStatus/);
  });

  it('still writes down why validateStatus and maxRedirects mattered', () => {
    // Both rules are RETIRED BY THE TRANSPORT rather than by a decision: gRPC
    // has no status classes and no redirects. Deleting the reasoning with the
    // code would leave the next reader unable to tell a retired guard from a
    // forgotten one — and the mint, which is still HTTP, still needs both.
    expect(source()).toMatch(/validateStatus/);
    expect(source()).toMatch(/redirect/i);
  });

  it('names no gRPC code in the deny path — the rule is total, not a list', () => {
    // One code is named in grants.ts, `Unauthenticated`, and it is named in the
    // RETRY branch rather than the deny branch. Any second name would mean the
    // catch had started to discriminate, which is where a fail-open lives.
    const named = [...code().matchAll(/Code\.(\w+)/g)].map((m) => m[1]);
    expect(named).toEqual(['Unauthenticated']);
  });
});
