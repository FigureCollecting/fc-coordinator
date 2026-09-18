/**
 * A RECOVERY THAT NOBODY CAN SEE IS NOT AN OBSERVABLE.
 *
 * THE DEFECT. The client re-mints its OpenFGA credential once when a Check is
 * refused for authentication, asks again, and on success returns the grant.
 * That recovery is real and it is tested — but until this file, the ONLY trace
 * it left was a process-wide counter, `entitlementGrantCounters()['reminted']`,
 * which nothing in the application reads: the service registers `/healthz` and
 * the `coordinator.v1` Connect surface, and neither exposes it. Measured on
 * merged `develop` 71edd9a by driving the recovery path and printing the audit
 * events, a check that recovered from a rotated credential and a check that
 * never had a problem emitted IDENTICAL lines, differing only in `latency_ms`:
 *
 *   {"event":"entitlement.check", …, "decision":"allow","source":"openfga","grpc_code":"ok"}
 *   {"event":"entitlement.check", …, "decision":"allow","source":"openfga","grpc_code":"ok"}
 *
 * So the one question an operator asks during a credential incident — WHOSE
 * token rotated, and when — was unanswerable from the record, and fc-infra's
 * `acceptance-u6.sh --case c` had to report `B2-remint` as NOT-RUN because
 * there was nothing in-cluster to assert.
 *
 * WHY A FIELD ON THE AUDIT LINE RATHER THAN A COUNTERS ROUTE. A route means a
 * new listener, a new Linkerd `Server`, a new `AuthorizationPolicy` and a new
 * ingress rule in `fc-coordinator-netpol.yaml` — inside the very workload whose
 * egress R7 is narrowing to a single identity-gated hop. Widening ingress to
 * observe a narrowing is the wrong trade. A field is read by the assertion that
 * already exists (`kubectl logs deploy/fc-coordinator | grep entitlement.check`)
 * and is PER SUBJECT, which a monotonic counter can never be.
 *
 * AND IT IS ABSENT, NOT `false`, WHEN THERE WAS NO RE-MINT. This repo already
 * states that rule about itself, in openfga-status.test.ts: "An audit field
 * that appears when there is nothing to report is a field nobody can trust."
 * The audit builder's optional-spread idiom is the same one `model_id`,
 * `grpc_code`, `openfga_code` and `reason` already use.
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
const OTHER = '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7a8b';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const T0 = 1_780_000_000_000;
const PASSWORD = 'app-password-never-print-me';

let fga: FakeOpenFgaStatus;
let idp: FakeTokenEndpoint;
let events: EntitlementAuditEvent[];
let printed: unknown[][];

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
  setEntitlementAuditSink((event) => events.push(event));
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    printed.push(args);
  });
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    printed.push(args);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  setEntitlementAuditSink(null);
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  await fga.close();
  await idp.close();
});

describe('a check that recovered by re-minting says so, on the line an operator already reads', () => {
  it('carries reminted: true and the OpenFGA code that provoked it', async () => {
    fga.script([{ status: 1010 }, { allowed: true }]);

    expect(await grantsForSubject(SUB, T0, env())).toEqual(['inventory_levels']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      decision: 'allow',
      source: 'openfga',
      grpc_code: 'ok',
      reminted: true,
      remint_cause: 1010,
    });
  });

  it.each([
    ['1004 invalid_claims, the v1.20.0 spelling', 1004],
    ['1005 auth_failed_invalid_bearer_token, the v1.5.9 spelling', 1005],
    ['1500 unauthenticated', 1500],
  ])('records %s as the cause, because the number moves between versions', async (_label, code) => {
    fga.script([{ status: code }, { allowed: true }]);

    await grantsForSubject(SUB, T0, env());
    expect(events[0]).toMatchObject({ reminted: true, remint_cause: code });
  });

  it('records a re-mint that did NOT recover, so "refused twice" is not read as "refused once"', async () => {
    fga.script([{ status: 1010 }, { status: 1010 }]);

    expect(await grantsForSubject(SUB, T0, env())).toEqual([]);
    expect(events[0]).toMatchObject({
      decision: 'error',
      reminted: true,
      remint_cause: 1010,
      openfga_code: 1010,
    });
  });

  it('carries reminted with NO cause when the refusal was a canonical code', async () => {
    // A canonical `unauthenticated` (16) buys the same re-mint, and OpenFGA
    // sent no number of its own — so there is no OpenFGA code to report and
    // the field is absent rather than invented. One vocabulary per field: the
    // canonical code lives in `grpc_code` and nowhere else.
    fga.script([{ status: Code.Unauthenticated }, { allowed: true }]);

    expect(await grantsForSubject(SUB, T0, env())).toEqual(['inventory_levels']);
    expect(events[0]?.reminted).toBe(true);
    expect(events[0]?.remint_cause).toBeUndefined();
  });
});

describe('a check that never failed says nothing at all', () => {
  it('omits both keys — absent, not false', async () => {
    fga.script([{ allowed: true }]);

    await grantsForSubject(SUB, T0, env());
    expect(events[0]).toMatchObject({ decision: 'allow', grpc_code: 'ok' });
    expect(events[0]?.reminted).toBeUndefined();
    expect(events[0]?.remint_cause).toBeUndefined();
    expect(Object.keys(events[0] as object)).not.toContain('reminted');
    expect(Object.keys(events[0] as object)).not.toContain('remint_cause');
  });

  it('omits them on a plain deny, which is a revoked user and not a credential', async () => {
    fga.script([{ allowed: false }]);

    await grantsForSubject(SUB, T0, env());
    expect(Object.keys(events[0] as object)).not.toContain('reminted');
  });

  it('omits them on a refusal that buys no re-mint, such as 1600 forbidden', async () => {
    fga.script([{ status: 1600 }]);

    await grantsForSubject(SUB, T0, env());
    expect(events[0]).toMatchObject({ decision: 'error', openfga_code: 1600 });
    expect(Object.keys(events[0] as object)).not.toContain('reminted');
  });
});

describe('the two lines are now DIFFERENT, which is the whole point', () => {
  it('a recovered check and a never-failed check no longer agree field for field', async () => {
    fga.script([{ status: 1010 }, { allowed: true }, { allowed: true }]);

    await grantsForSubject(SUB, T0, env());
    await grantsForSubject(OTHER, T0, env());
    expect(events).toHaveLength(2);

    // Everything but the measured latency, the subject and the new fields.
    const shape = (e: EntitlementAuditEvent): Record<string, unknown> => {
      const { latency_ms: _l, subject: _s, ...rest } = e as unknown as Record<string, unknown> & {
        latency_ms: number;
        subject: string;
      };
      return rest;
    };
    expect(shape(events[0] as EntitlementAuditEvent)).not.toEqual(
      shape(events[1] as EntitlementAuditEvent),
    );
    expect(shape(events[0] as EntitlementAuditEvent)).toMatchObject({ reminted: true });
    expect(shape(events[1] as EntitlementAuditEvent)).not.toHaveProperty('reminted');
  });

  it('a cached REPLAY carries no re-mint, because the replay did not re-mint', async () => {
    // REVERSED AFTER REVIEW, and the argument that reversed it is about what
    // the field MEANS. The cache's rule is "the original decision, replayed",
    // and every other field describes THE ANSWER: `decision`, `grpc_code`,
    // `openfga_code`, `reason`. `reminted` describes what THIS CALL had to do
    // to obtain it, and a cache hit did nothing — so carrying it was the one
    // field on the line that was literally false about the call it described.
    //
    // It was also operationally wrong. A grant is cached for 30 s by default,
    // so `kubectl logs | grep reminted` returned the recovery AND every
    // unprovoked read of the same subject for the next half minute, and the
    // acceptance assertion that greps for it could not tell a real rotation
    // from its own echo.
    fga.script([{ status: 1010 }, { allowed: true }]);

    await grantsForSubject(SUB, T0, env());
    await grantsForSubject(SUB, T0 + 1, env());
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ source: 'cache', decision: 'allow' });
    expect(Object.keys(events[1] as object)).not.toContain('reminted');
    expect(Object.keys(events[1] as object)).not.toContain('remint_cause');
  });

  it('a COALESCED caller carries no re-mint either — it waited, it did not mint', async () => {
    fga.script([{ status: 1010 }, { allowed: true }]);

    const [, second] = await Promise.all([
      grantsForSubject(SUB, T0, env()),
      grantsForSubject(SUB, T0, env()),
    ]);
    expect(second).toEqual(['inventory_levels']);
    const coalesced = events.find((e) => e.source === 'coalesced');
    expect(coalesced).toBeDefined();
    expect(Object.keys(coalesced as object)).not.toContain('reminted');
  });

  it('so grepping the field counts RECOVERIES, not echoes of one', async () => {
    // The property the fc-infra acceptance rests on, stated as a count.
    fga.script([{ status: 1010 }, { allowed: true }]);

    await grantsForSubject(SUB, T0, env());
    await grantsForSubject(SUB, T0 + 1, env());
    await grantsForSubject(SUB, T0 + 2, env());
    expect(events).toHaveLength(3);
    expect(events.filter((e) => 'reminted' in e)).toHaveLength(1);
  });
});

describe('the new fields leak nothing and change no counter', () => {
  it('names no token and no password anywhere in the record or the log', async () => {
    fga.script([{ status: 1010 }, { allowed: true }]);
    idp.reply({ body: { access_token: 'token-super-secret', expires_in: 600 } });

    await grantsForSubject(SUB, T0, env());
    const serialised = `${JSON.stringify(events)}${JSON.stringify(printed)}`;
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain('token-super-secret');
  });

  it('leaves the reminted COUNTER exactly where it was — the field is additional, not a move', async () => {
    fga.script([{ status: 1010 }, { allowed: true }]);

    await grantsForSubject(SUB, T0, env());
    expect(entitlementGrantCounters()['reminted']).toBe(1);
  });

  it('mints exactly twice for one recovery: the cold mint and the forced one', async () => {
    // The mint-storm pin, restated at this boundary: adding a field to the
    // record must not add a request to the identity provider.
    fga.script([{ status: 1010 }, { allowed: true }]);

    await grantsForSubject(SUB, T0, env());
    expect(idp.calls).toHaveLength(2);
  });
});
