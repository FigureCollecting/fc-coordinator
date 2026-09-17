/**
 * FAIL-CLOSED, PINNED RATHER THAN BUILT.
 *
 * The D5b review warned that a mesh partition surfaces as a FAST HTTP 504 from
 * the sidecar, not as a transport error, and that fail-closed logic keying on a
 * thrown connection error would sail straight past it. Read against this
 * codebase that warning turns out to be a correction, not a defect: the Check
 * is `axios.post` with no `validateStatus` override, so axios's default
 * (`status >= 200 && status < 300`) REJECTS on a 504 and the catch returns an
 * error-deny. The property already holds.
 *
 * Which makes the work here pinning, not implementing — and pinning a property
 * you did not write is harder than testing one you did, because the obvious
 * test passes for the wrong reason. A 504 carrying an empty body would produce
 * a deny under a broken implementation too, since a body with no boolean
 * `allowed` is also an error-deny. So every non-2xx case below carries
 * **`{"allowed": true}`** as its body: under the mutation this file exists to
 * catch — `validateStatus: () => true` — the response would be accepted, the
 * body would parse, `allowed` would be `true`, and the test would go red on the
 * grant rather than silently agreeing. That is what makes it a pin.
 *
 * The source assertion at the end is the second half. A behavioural test cannot
 * catch every way the rule could be loosened; a mutation that also changed the
 * fake's body would slip past it. So the code is asserted to contain no
 * `validateStatus` at all.
 */
// Inert unless CLOCK_STEP_MS is set — see the helper.
import '../helpers/steppingClock.js';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import * as path from 'node:path';
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

/** The body every non-2xx case carries. See the header: this is the mutation killer. */
const A_GRANT = { allowed: true };

let fga: FakeOpenFga;
let events: EntitlementAuditEvent[];

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({ OPENFGA_API_URL: fga.baseUrl, OPENFGA_STORE_ID: STORE, ...over }) as NodeJS.ProcessEnv;

/**
 * A server that ACCEPTS the connection and then says nothing, ever.
 *
 * An unroutable address would be simpler and would be the wrong test: on some
 * hosts it is refused immediately, and the timeout assertions below would then
 * pass without the timeout ever being the thing that ended the request. Hanging
 * after a successful connect is the only shape that forces the deadline to be
 * what bites, and it behaves the same on a laptop and on a runner.
 */
async function startSilentServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer(() => {
    /* accept, read, and never reply */
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

beforeEach(async () => {
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
// NON-2xx
// ===========================================================================
describe('a non-2xx from OpenFGA', () => {
  it.each([
    ['504, which is what a mesh partition actually looks like', 504],
    ['503', 503],
    ['500', 500],
    ['429', 429],
    ['401, with no credential configured so nothing is re-minted', 401],
    ['403', 403],
  ])('denies on a %s that CLAIMS a grant', async (_label, status) => {
    fga.reply({ status, body: A_GRANT });

    const grants = await grantsForSubject(SUB, T0, env());

    expect(grants).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', http_status: status });
    expect(entitlementGrantCounters()['error']).toBe(1);
    expect(entitlementGrantCounters()['allow']).toBeUndefined();
  });

  it('sends NO assertion header on a 504, so the spine redacts rather than trusting us', async () => {
    const kp = generateTestSigningKey(KID);
    fga.reply({ status: 504, body: A_GRANT });

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
// THE TRANSPORT
// ===========================================================================
describe('a request that never reached OpenFGA', () => {
  it('denies on a refused connection, with no status to report', async () => {
    const grants = await grantsForSubject(SUB, T0, env({ OPENFGA_API_URL: 'http://127.0.0.1:1' }));

    expect(grants).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', reason: 'transport' });
    expect(events[0]?.http_status).toBeUndefined();
  });

  it('denies on a timeout rather than hanging the read behind it', async () => {
    const silent = await startSilentServer();
    try {
      const grants = await grantsForSubject(SUB, T0, {
        OPENFGA_API_URL: silent.baseUrl,
        OPENFGA_STORE_ID: STORE,
        OPENFGA_TIMEOUT_MS: '100',
      } as NodeJS.ProcessEnv);

      expect(grants).toEqual([]);
      expect(events[0]).toMatchObject({ decision: 'error', reason: 'transport' });
    } finally {
      await silent.close();
    }
  }, 20_000);
});

// ===========================================================================
// A 200 THAT IS NOT AN ANSWER
// ===========================================================================
describe('a 200 carrying something that is not a Check response', () => {
  it.each([
    ['a bare string', '"nope"'],
    ['a number', '42'],
    ['null', 'null'],
    ['an array', '[{"allowed":true}]'],
  ])('is an ERROR, not a deny, when the body is %s', async (_label, raw) => {
    fga.reply({ status: 200, body: raw });

    expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', reason: 'bad_body', http_status: 200 });
  });

  it('is an ERROR when `allowed` is present but not a boolean', async () => {
    // An operator has to be able to tell a wire surprise from a revocation.
    // "true" the string is a serialisation bug somewhere upstream, and calling
    // it a deny would hide that forever.
    fga.reply({ status: 200, body: { allowed: 'true' } });

    expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', reason: 'bad_body' });
  });

  it('is an ERROR when `allowed` is absent entirely', async () => {
    fga.reply({ status: 200, body: { resolution: '' } });

    expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', reason: 'bad_body' });
  });
});

// ===========================================================================
// THE ZERO-TIMEOUT TRAP
// ===========================================================================
describe('OPENFGA_TIMEOUT_MS', () => {
  it('refuses zero and falls back, because axios reads 0 as "wait forever"', async () => {
    // One typo in a deployment would otherwise turn the Check on a user-facing
    // read into an unbounded hang — the failure mode a timeout exists to
    // prevent, reintroduced by the timeout itself. If zero were honoured this
    // promise would never settle and the test would time out instead of
    // resolving to a deny at the 2 s default.
    const silent = await startSilentServer();
    try {
      // performance.now(), NOT Date.now(): this is an ELAPSED-TIME measurement
      // and Date.now() is not monotonic. The same substitution commit fef12ca
      // made in grants.test.ts, for the same measured reason — a backwards step
      // on this estate's WSL2 hosts subtracts from the elapsed figure, and this
      // assertion sits one second from its boundary. Reproducible on demand:
      // CLOCK_STEP_MS=-2000 turns it red on the Date.now() version.
      const started = performance.now();
      const grants = await grantsForSubject(SUB, T0, {
        OPENFGA_API_URL: silent.baseUrl,
        OPENFGA_STORE_ID: STORE,
        OPENFGA_TIMEOUT_MS: '0',
      } as NodeJS.ProcessEnv);

      expect(grants).toEqual([]);
      expect(events[0]).toMatchObject({ decision: 'error', reason: 'transport' });
      // It ended because the 2 s default bit, not because the socket did
      // something else: anything under a second would mean the deadline was
      // never what stopped it.
      expect(performance.now() - started).toBeGreaterThan(1_000);
    } finally {
      await silent.close();
    }
  }, 20_000);
});

// ===========================================================================
// THE SOURCE ITSELF
// ===========================================================================
describe('the Check call site', () => {
  it('configures no validateStatus — the default rejection IS the fail-closed rule', () => {
    // Behaviour cannot pin this alone: a mutation that loosened the rule AND
    // changed the fixtures would pass every test above. The code is the claim,
    // so the code is what is asserted. Comments are stripped first, because the
    // rule is explained in one and explaining it is not doing it.
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, '../../src/entitlements/grants.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).not.toMatch(/validateStatus/);
    // And the rule is still WRITTEN DOWN, so the next reader knows the absence
    // is load-bearing rather than an oversight waiting to be tidied up.
    expect(source).toMatch(/validateStatus/);
  });
});
