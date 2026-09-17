/**
 * OPENFGA DOES NOT SPEAK CANONICAL gRPC STATUSES, AND THE RE-MINT PATH DEPENDED
 * ON IT DOING SO.
 *
 * THE DEFECT THIS FILE EXISTS FOR. gRPC defines status codes 0–16. OpenFGA
 * writes its OWN numbers into the `grpc-status` trailer — 1010 when the bearer
 * is missing, 1004 on invalid claims, 1500 unauthenticated, 1600 forbidden, and
 * the 2xxx `ErrorCode` family for everything else (openfga/api
 * errors_ignore.proto, sha256
 * fb356436851b49898c57420f7efac8145c078871c9cfa11f10188c3615dfff9d at commit
 * 7a79d2abab5b9ccc962ae995a1aab70c0a1cf19d). Connect-ES rejects a status
 * outside the canonical range as `Code.Internal` with the message
 * "invalid grpc-status: 1010", so a client that keys its re-mint on
 * `code === Code.Unauthenticated` NEVER re-mints against the real service.
 *
 * WHAT THAT COST. Under REST a rotated or expired token produced a 401, which
 * bought exactly one forced re-mint and then a successful Check. Over gRPC,
 * before this file, the identical rotation produced an error-deny with
 * `grpc_code: internal` and `reminted: 0` — every read from that subject
 * redacted until the grant cache expired, and no line in the log saying the
 * credential was the problem. That is a REGRESSION against the transport it
 * replaced, not a new limitation.
 *
 * HOW IT GOT PAST A FULL GREEN SUITE, which is the part worth keeping. The fake
 * served through `connectNodeAdapter`, whose reply type is `code?: Code` — it
 * could not express a non-canonical status even in principle. Client and fake
 * were built from the same assumption, so they agreed, and agreement between
 * two things built from one assumption is not evidence. The fake used here
 * (test/helpers/fakeOpenFgaStatus.ts) writes the trailer by hand for exactly
 * that reason, and the numbers below were then confirmed against the real
 * binary in the OIDC authn mode this estate runs.
 *
 * THE RULE THE FIX FOLLOWS. OpenFGA's HTTP transcoding maps every AuthErrorCode
 * below `forbidden` to 401 and `forbidden` itself to 403. The old client
 * retried 401 and never retried 403. So the carried-over rule is the RANGE, not
 * a list of the three codes anyone happened to observe: 1000–1599 is the 401
 * class and buys one re-mint; 1600 is the 403 class and buys none; everything
 * else fails closed with the OpenFGA number recorded. Enumerating only the
 * codes someone had seen is how the next unlisted one becomes a silent outage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Code } from '@connectrpc/connect';
import {
  entitlementGrantCounters,
  grantsForSubject,
  resetEntitlementGrantsForTest,
  setEntitlementAuditSink,
  type EntitlementAuditEvent,
} from '../../src/entitlements/index.js';
import { resetOpenFgaTokenForTest } from '../../src/entitlements/openfgaToken.js';
import { startFakeOpenFgaStatus, type FakeOpenFgaStatus } from '../helpers/fakeOpenFgaStatus.js';
import { startFakeTokenEndpoint, type FakeTokenEndpoint } from '../helpers/fakeTokenEndpoint.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const T0 = 1_780_000_000_000;
const PASSWORD = 'app-password-never-print-me';

let fga: FakeOpenFgaStatus;
let idp: FakeTokenEndpoint;
let events: EntitlementAuditEvent[];
let printed: unknown[][];

/** The OIDC path, which is the only one that can re-mint. */
const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OPENFGA_GRPC_URL: fga.baseUrl,
    OPENFGA_STORE_ID: STORE,
    OPENFGA_OIDC_TOKEN_ENDPOINT: idp.url,
    OPENFGA_OIDC_CLIENT_ID: 'openfga',
    OPENFGA_OIDC_USERNAME: 'svc-openfga-fc-coordinator',
    OPENFGA_OIDC_PASSWORD: PASSWORD,
    ...over,
  }) as NodeJS.ProcessEnv;

beforeEach(async () => {
  fga = await startFakeOpenFgaStatus();
  idp = await startFakeTokenEndpoint();
  events = [];
  printed = [];
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  setEntitlementAuditSink((e) => events.push(e));
  for (const level of ['error', 'warn', 'log', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      printed.push(args);
    });
  }
});

afterEach(async () => {
  setEntitlementAuditSink(null);
  await fga.close();
  await idp.close();
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

// ===========================================================================
// THE 401 CLASS — one re-mint, exactly as REST had
// ===========================================================================
describe('an OpenFGA auth status below `forbidden`', () => {
  it.each([
    ['1010 bearer_token_missing', 1010],
    ['1004 invalid_claims', 1004],
    ['1500 unauthenticated', 1500],
    // Not observed in the wild, and that is the point of covering them: the
    // rule is the range, so an unlisted sibling behaves like its family.
    ['1001 auth_failed_invalid_subject', 1001],
    ['1002 auth_failed_invalid_audience', 1002],
    ['1003 auth_failed_invalid_issuer', 1003],
    ['1005 auth_failed_invalid_bearer_token', 1005],
  ])('%s buys exactly one re-mint, and the retry succeeds', async (_label, status) => {
    // The rotation shape: the cached token is refused once, the fresh one is
    // accepted. Under the defect this resolved to [] with reminted undefined.
    fga.script([{ status, message: 'the token is stale' }, { allowed: true }]);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    const grants = await grantsForSubject(SUB, T0, env());

    expect(grants).toEqual(['inventory_levels']);
    expect(entitlementGrantCounters()['reminted']).toBe(1);
    expect(fga.calls).toHaveLength(2);
    // And the SECOND call carried a freshly minted credential, not the one that
    // was just refused.
    expect(fga.calls[1]?.authorization).toBe('Bearer token-2');
  });

  it('bounds the retry at one against a permanently refusing service', async () => {
    fga.script([{ status: 1500 }]);

    const grants = await grantsForSubject(SUB, T0, env());

    expect(grants).toEqual([]);
    // Two calls, never a loop — the same bound the 401 path had.
    expect(fga.calls).toHaveLength(2);
    expect(entitlementGrantCounters()['reminted']).toBe(1);
    expect(entitlementGrantCounters()['error']).toBe(1);
  });

  it('records the OpenFGA number beside the gRPC one', async () => {
    fga.script([{ status: 1010 }]);

    await grantsForSubject(SUB, T0, env());

    // BOTH, because they answer different questions. `grpc_code` is what the
    // transport concluded and is what a mesh or proxy will have logged;
    // `openfga_code` is what the service actually said, and is the only one an
    // operator can look up in errors_ignore.proto.
    expect(events[0]).toMatchObject({
      decision: 'error',
      grpc_code: 'internal',
      openfga_code: 1010,
    });
  });

  it('does not re-mint on the static path — there is nothing to re-mint', async () => {
    fga.script([{ status: 1010 }]);

    const grants = await grantsForSubject(SUB, T0, {
      OPENFGA_GRPC_URL: fga.baseUrl,
      OPENFGA_STORE_ID: STORE,
      OPENFGA_API_TOKEN: 'preshared',
    } as NodeJS.ProcessEnv);

    expect(grants).toEqual([]);
    expect(fga.calls).toHaveLength(1);
  });
});

// ===========================================================================
// THE 403 CLASS AND THE REST — no retry, fail closed
// ===========================================================================
describe('an OpenFGA status that a fresh token cannot fix', () => {
  it.each([
    ['1600 forbidden — the 403 class, which REST never retried', 1600],
    ['2001 authorization_model_not_found', 2001],
    ['2000 validation_error', 2000],
    ['2021 type_not_found', 2021],
  ])('%s denies without retrying', async (_label, status) => {
    fga.script([{ status }]);

    const grants = await grantsForSubject(SUB, T0, env());

    expect(grants).toEqual([]);
    expect(fga.calls).toHaveLength(1);
    expect(entitlementGrantCounters()['reminted']).toBeUndefined();
    expect(events[0]).toMatchObject({ decision: 'error', openfga_code: status });
  });

  it('fails closed on a number in no published range at all', async () => {
    // A future OpenFGA, a proxy inventing a status, a misconfigured middlebox.
    // The rule is that an unrecognised answer is a fault, so it denies and the
    // number is recorded rather than swallowed.
    fga.script([{ status: 4242 }]);

    expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    expect(fga.calls).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'error', openfga_code: 4242 });
  });

  it('never reports a non-canonical status as a grant, whatever the number', async () => {
    // The anti-vacuous half: the fake would otherwise answer allowed:true, so
    // any path that treated an unparsed status as "carry on" would show here.
    for (const status of [1010, 1600, 2001, 4242, 9999]) {
      resetEntitlementGrantsForTest();
      resetOpenFgaTokenForTest();
      fga.script([{ status }]);
      expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    }
  });
});

// ===========================================================================
// CANONICAL CODES ARE UNTOUCHED
// ===========================================================================
describe('a canonical gRPC status', () => {
  it('still re-mints on 16 (unauthenticated) and records no openfga_code', async () => {
    fga.script([{ status: Code.Unauthenticated }, { allowed: true }]);
    idp.reply({ body: { access_token: 'token-2', expires_in: 600 } });

    expect(await grantsForSubject(SUB, T0, env())).toEqual(['inventory_levels']);
    expect(entitlementGrantCounters()['reminted']).toBe(1);
  });

  it('still denies on 7 (permission_denied) without retrying, and names it', async () => {
    fga.script([{ status: Code.PermissionDenied }]);

    expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    expect(fga.calls).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'permission_denied' });
    // No OpenFGA number, because OpenFGA did not send one. An audit field that
    // appears when there is nothing to report is a field nobody can trust.
    expect(events[0]?.openfga_code).toBeUndefined();
  });

  it('serves the happy path from this fake too, so the fixture is not one-sided', async () => {
    fga.script([{ allowed: true }]);

    expect(await grantsForSubject(SUB, T0, env())).toEqual(['inventory_levels']);
    expect(events[0]).toMatchObject({ decision: 'allow', grpc_code: 'ok' });
  });
});

// ===========================================================================
// grpc-message IS ATTACKER-INFLUENCED TEXT
// ===========================================================================
describe('the grpc-message trailer', () => {
  it('never reaches the log, even when the far side echoes the bearer into it', async () => {
    // A status a server controls, carrying a message a server controls. Connect
    // puts `grpc-message` verbatim into ConnectError.message for a CANONICAL
    // code, and this module prints the message — so a service, proxy or
    // middlebox that echoes the Authorization header back lands the bearer in
    // the application log, where it is shipped to an aggregator.
    //
    // It need not be malicious to happen: "unauthenticated: Bearer eyJ…" is a
    // plausible thing for a debug build to say.
    idp.reply({ body: { access_token: 'token-super-secret', expires_in: 600 } });
    fga.script([
      { status: Code.Unauthenticated, message: 'rejected credential Bearer token-super-secret' },
    ]);

    await grantsForSubject(SUB, T0, env());

    const text = JSON.stringify(printed);
    expect(printed.length).toBeGreaterThan(0);
    expect(text).not.toContain('token-super-secret');
    expect(text).not.toContain('Bearer');
  });

  it('is bounded, so a megabyte of trailer cannot become a megabyte of log', async () => {
    fga.script([{ status: Code.Internal, message: 'x'.repeat(50_000) }]);

    await grantsForSubject(SUB, T0, env());

    const longest = Math.max(
      ...printed.map((line) => line.map((a) => String(a)).join(' ').length),
    );
    expect(longest).toBeLessThan(1_000);
  });
});
