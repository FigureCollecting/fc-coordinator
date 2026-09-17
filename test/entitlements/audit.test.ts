/**
 * THE CALLER-SIDE AUDIT LINE, and why it is the only place this record can be
 * written.
 *
 * OpenFGA logs no authenticated subject. A Check entry carries the method, the
 * store, a request id, a user agent and the raw request and response — nothing
 * that names WHO asked. The multicluster gateway then collapses both callers
 * into one mesh identity, so the distinction cannot be recovered after the fact
 * anywhere downstream. The decision is per-caller; the record was not. This
 * closes that.
 *
 * THE TENSION, RESOLVED DELIBERATELY. The estate's telemetry rule is that spans
 * carry outcome and grant COUNT only, never `sub`. An audit trail that names
 * the subject and a span-hygiene rule that forbids it are both right, because
 * they are about different sinks: this line goes to the APPLICATION LOG and
 * never onto a span. The subject is a pseudonymous provider uuid, and without
 * it the record answers nothing at all.
 *
 * A CACHE HIT IS A DECISION and says so — including when the cached decision
 * was an error, which is the difference between "these users were revoked" and
 * "the authorization service was sick and we are still replaying that".
 */
import { Code } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  entitlementHeaderFor,
  grantsForSubject,
  resetEntitlementGrantsForTest,
  resetEntitlementSigningForTest,
  resetOpenFgaTokenForTest,
  setEntitlementAuditSink,
  type EntitlementAuditEvent,
} from '../../src/entitlements/index.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';
import { startFakeTokenEndpoint, type FakeTokenEndpoint } from '../helpers/fakeTokenEndpoint.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const MODEL = '01KXBBBBBBBBBBBBBBBBBBBBBB';
const PASSWORD = 'app-password-do-not-log';
const T0 = 1_780_000_000_000;

let fga: FakeOpenFga;
let idp: FakeTokenEndpoint;
let events: EntitlementAuditEvent[];

const env = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OPENFGA_GRPC_URL: fga.baseUrl,
    OPENFGA_STORE_ID: STORE,
    OPENFGA_MODEL_ID: MODEL,
    ...over,
  }) as NodeJS.ProcessEnv;

const oidcEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  env({
    OPENFGA_OIDC_TOKEN_ENDPOINT: idp.url,
    OPENFGA_OIDC_CLIENT_ID: 'openfga',
    OPENFGA_OIDC_USERNAME: 'svc-openfga-fc-coordinator',
    OPENFGA_OIDC_PASSWORD: PASSWORD,
    ...over,
  });

beforeEach(async () => {
  fga = await startFakeOpenFga(() => true);
  idp = await startFakeTokenEndpoint();
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
  await idp.close();
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

// ===========================================================================
// ONE EVENT PER DECISION
// ===========================================================================
describe('an allowed Check', () => {
  it('writes one event naming the caller, the tuple and the model', async () => {
    await grantsForSubject(SUB, T0, env());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: 'entitlement.check',
      subject: SUB,
      relation: 'inventory_levels',
      object: 'app:figurecollecting',
      decision: 'allow',
      source: 'openfga',
      model_id: MODEL,
      // `ok` where the HTTP version recorded 200. Present on the SUCCESS path
      // too, deliberately: the field means "the call was attempted and this is
      // how it ended", so a reader can tell a granted Check apart from one that
      // never left the process.
      grpc_code: 'ok',
    });
    expect(typeof events[0]?.latency_ms).toBe('number');
  });

  it('names the configured app object rather than the default when one is set', async () => {
    await grantsForSubject(SUB, T0, env({ OPENFGA_APP_OBJECT: 'app:staging' }));
    expect(events[0]?.object).toBe('app:staging');
  });

  it('omits model_id when no model is pinned, rather than inventing one', async () => {
    await grantsForSubject(SUB, T0, env({ OPENFGA_MODEL_ID: undefined }));
    expect(events[0]?.model_id).toBeUndefined();
  });
});

describe('a denied Check', () => {
  it('records decision deny — which is NOT an error', async () => {
    await fga.close();
    fga = await startFakeOpenFga(() => false);

    await grantsForSubject(SUB, T0, env());
    expect(events[0]).toMatchObject({ decision: 'deny', source: 'openfga' });
  });
});

describe('a Check that could not be made', () => {
  it('records decision error WITH the code, so unavailable is not unauthenticated', async () => {
    fga.reply({ code: Code.Unavailable });

    await grantsForSubject(SUB, T0, env());
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'unavailable' });
    // No `reason`: the code IS the reason. `reason` is kept for the causes a
    // gRPC status cannot express — a failed mint, a refused REST variable, an
    // answer that was not a CheckResponse.
    expect(events[0]?.reason).toBeUndefined();
  });

  it('records a connection that was refused as unavailable, in the only vocabulary gRPC has', async () => {
    // WHAT CHANGED WITH THE TRANSPORT, said plainly. Over HTTP a refused socket
    // produced no status and the record said `reason: transport`; a served
    // error produced one and said `http_error`. gRPC gives both the same code,
    // and no part of the protocol separates them, so the record reports
    // `unavailable` and does not guess.
    await grantsForSubject(SUB, T0, env({ OPENFGA_GRPC_URL: 'http://127.0.0.1:1' }));

    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'unavailable' });
  });

  it('records a failed token mint as its OWN reason, not as a 401', async () => {
    // The whole point of not falling through to an unauthenticated Check: the
    // record has to say "we could not get a credential", because "OpenFGA said
    // 401" sends an operator to the wrong system.
    idp.reply({ status: 500, body: { error: 'server_error' } });

    await grantsForSubject(SUB, T0, oidcEnv());
    expect(events[0]).toMatchObject({
      decision: 'error',
      reason: 'token_mint_failed',
      // NO CALL WAS MADE, so `source` must not claim one. This is the single
      // field an operator uses to separate "OpenFGA said no" from "we never
      // asked it", and anyone counting OpenFGA traffic by source=openfga would
      // otherwise over-count by exactly the outage they are diagnosing.
      source: 'none',
      latency_ms: 0,
    });
    // NOTHING WAS DIALLED, so there is no gRPC status to report either.
    expect(events[0]?.grpc_code).toBeUndefined();
    expect(fga.calls).toHaveLength(0);
  });

  it('records an unconfigured client distinctly from a deny, and as an UNASKED question', async () => {
    await grantsForSubject(SUB, T0, {} as NodeJS.ProcessEnv);
    expect(events[0]).toMatchObject({
      decision: 'unconfigured',
      source: 'none',
      latency_ms: 0,
    });
  });

  it('reserves source "openfga" for decisions OpenFGA actually made', async () => {
    // Stated once as a rule rather than only case by case: every event whose
    // source is `openfga` corresponds to a request on the wire, and the
    // request count is the proof.
    // One real Check, then the three paths that never make one.
    await grantsForSubject(SUB, T0, env());
    idp.reply({ status: 500, body: { error: 'server_error' } });
    await grantsForSubject('1f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33', T0, oidcEnv());
    await grantsForSubject('2f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33', T0, {} as NodeJS.ProcessEnv);
    await grantsForSubject('not-a-uuid', T0, env());

    expect(events).toHaveLength(4);
    expect(fga.calls).toHaveLength(1);
    expect(events.filter((e) => e.source === 'openfga')).toHaveLength(fga.calls.length);
    expect(events.filter((e) => e.source === 'none').map((e) => e.decision).sort()).toEqual([
      'bad_subject',
      'error',
      'unconfigured',
    ]);
  });
});

describe('a subject that is not a provider uuid', () => {
  it('is recorded, but the malformed value itself is NOT', async () => {
    // An identifier that failed the uuid rule can be anything the host handed
    // in — an email, a session id, a username. The decision belongs in the
    // record; the value does not.
    await grantsForSubject('ross@example.com', T0, env());

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ decision: 'bad_subject', source: 'none' });
    expect(JSON.stringify(events)).not.toContain('ross@example.com');
    expect(fga.calls).toHaveLength(0);
  });
});

// ===========================================================================
// A CACHE HIT IS A DECISION
// ===========================================================================
describe('the cache', () => {
  it('writes an event for a HIT too, marked as one', async () => {
    await grantsForSubject(SUB, T0, env());
    await grantsForSubject(SUB, T0 + 1_000, env());

    expect(fga.calls).toHaveLength(1);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ decision: 'allow', source: 'cache', latency_ms: 0 });
  });

  it('replays the ORIGINAL decision, so a cached error still reads as an error', async () => {
    // Without this the second read looks like an ordinary denial, and an
    // operator watching the log sees a revocation that never happened.
    fga.reply({ code: Code.Unavailable });
    await grantsForSubject(SUB, T0, env());
    await grantsForSubject(SUB, T0 + 1_000, env());

    expect(events[1]).toMatchObject({ decision: 'error', source: 'cache', grpc_code: 'unavailable' });
  });

  it('marks a coalesced caller as coalesced, not as a fresh Check', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => grantsForSubject(SUB, T0, env())),
    );

    expect(results.every((r) => r.length === 1)).toBe(true);
    expect(fga.calls).toHaveLength(1);
    expect(events).toHaveLength(5);
    expect(events.filter((e) => e.source === 'openfga')).toHaveLength(1);
    expect(events.filter((e) => e.source === 'coalesced')).toHaveLength(4);
    for (const e of events) expect(e.decision).toBe('allow');
  });
});

// ===========================================================================
// WHAT AN EVENT MUST NEVER CARRY
// ===========================================================================
describe('the event body', () => {
  it('carries no credential, no assertion and no grant payload', async () => {
    const kp = generateTestSigningKey('ent-test-2026-09');
    const header = await entitlementHeaderFor(
      SUB,
      T0,
      oidcEnv({
        ENTITLEMENT_SIGNING_KEY_PEM: kp.privatePem,
        ENTITLEMENT_SIGNING_KID: 'ent-test-2026-09',
      }),
    );
    expect(header).not.toBeNull();

    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(PASSWORD);
    expect(serialised).not.toContain('token-1');
    expect(serialised).not.toContain(header as string);
    expect(serialised).not.toContain('PRIVATE KEY');
  });

  it('holds only the documented keys — an audit record is a contract', async () => {
    await grantsForSubject(SUB, T0, env());
    expect(Object.keys(events[0] as object).sort()).toEqual(
      [
        'decision',
        'event',
        'grpc_code',
        'latency_ms',
        'model_id',
        'object',
        'relation',
        'source',
        'subject',
      ].sort(),
    );
  });
});

// ===========================================================================
// THE SINK ITSELF
// ===========================================================================
describe('the sink seam', () => {
  it('falls back to the console when no host has wired one', async () => {
    // The portable directory may not import this app's logger, so unset must
    // still write SOMEWHERE — a module that silently drops its audit trail when
    // copied into a new host is worse than one that has none.
    setEntitlementAuditSink(null);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});

    await grantsForSubject(SUB, T0, env());

    expect(info).toHaveBeenCalled();
    expect(JSON.stringify(info.mock.calls)).toContain('entitlement.check');
  });

  it('never lets a broken sink break a read', async () => {
    // An audit line is a record, not a gate. A host that throws from its logger
    // must not turn every entitled read into a denial.
    setEntitlementAuditSink(() => {
      throw new Error('log sink exploded');
    });

    await expect(grantsForSubject(SUB, T0, env())).resolves.toEqual(['inventory_levels']);
  });
});
