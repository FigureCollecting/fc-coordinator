/**
 * THE SLICE-1 ENTITLEMENT ACCEPTANCE, end to end and in one process.
 *
 * Plan §C: "an ENTITLED Compare through the coordinator reveals `stockOnHand`,
 * and the unentitled one hides it with `coverage.redacted: ["inventory_levels"]`.
 * Asserting only the hiding half would pass against a service that is simply
 * broken." Both halves are here, and neither is asserted against a flag this
 * file set: the fake spine VERIFIES the minted assertion with a faithful port
 * of the spine's own verifier before it decides what to serve.
 *
 * NOTHING IS STUBBED BETWEEN THE TWO ENDS. A real Connect client speaks to a
 * real Fastify server running the real plugin; the handler runs the real ported
 * entitlement module, which asks a real OpenFGA-shaped HTTP endpoint and signs
 * with a real Ed25519 key; the outbound hop is the real Connect client over
 * real HTTP/1.1. The only fakes are the two REMOTE SERVICES, and both behave
 * the way their contracts say.
 *
 * NO PRODUCTION ANYTHING. Every server binds 127.0.0.1 on an ephemeral port and
 * every key is generated per-run.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { CompareResponseSchema } from '@figurecollecting/ingest-contract/read';
import {
  ENTITLEMENTS_HEADER,
  INVENTORY_LEVELS,
} from '@figurecollecting/ingest-contract/entitlement';
import { CompareService } from '@figurecollecting/fc-api-contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import {
  resetEntitlementGrantsForTest,
  resetEntitlementSigningForTest,
} from '../../src/entitlements/index.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';
import {
  startFakeSpineRead,
  ENTITLED_RESULT_JSON,
  REDACTED_RESULT_JSON,
  type FakeSpineRead,
} from '../helpers/fakeSpineRead.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';

const KID = 'ent-test-2026-09';
const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const NOW_ISO = '2026-09-14T12:00:00.000Z';
const GTIN = '04573102591234';

const ENV_KEYS = [
  'OPENFGA_API_URL',
  'OPENFGA_STORE_ID',
  'OPENFGA_API_TOKEN',
  'ENTITLEMENT_SIGNING_KEY_PEM',
  'ENTITLEMENT_SIGNING_KID',
] as const;

/** /healthz needs a db; nothing in this file touches one. */
const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

interface Harness {
  client: Client<typeof CompareService>;
  spine: FakeSpineRead;
  fga: FakeOpenFga | null;
  app: FastifyInstance;
  baseUrl: string;
}

let harness: Harness | null = null;
let saved: Record<string, string | undefined> = {};
let telemetry: Telemetry;

// A REAL tracer provider: the traceparent assertions are about real span ids,
// and with no provider registered @opentelemetry/api hands out non-recording
// spans whose context is all zeroes and which the W3C propagator declines to
// inject. It is also what the service itself does at boot.
beforeAll(() => {
  telemetry = startTelemetry({ env: {}, serviceName: 'fc-coordinator-test' });
});

afterAll(async () => {
  await telemetry.shutdown();
});

interface HarnessOptions {
  /** OpenFGA's answer, or `null` to leave OpenFGA UNCONFIGURED (the D4 state). */
  allow: boolean | null;
  /** Identity the resolver hands the handler. `null` = no authenticated caller. */
  subject?: string | null;
  /** Override what the fake spine replies with. */
  respond?: Parameters<typeof startFakeSpineRead>[0]['respond'];
  fail?: Parameters<typeof startFakeSpineRead>[0]['fail'];
  /** Point the coordinator at no spine at all. */
  noSpine?: boolean;
  /** Withhold the signing key, leaving the mint disabled. */
  noSigningKey?: boolean;
}

async function start(options: HarnessOptions): Promise<Harness> {
  const kp = generateTestSigningKey(KID);
  if (!options.noSigningKey) {
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
  }

  let fga: FakeOpenFga | null = null;
  if (options.allow !== null) {
    fga = await startFakeOpenFga(() => options.allow as boolean);
    process.env['OPENFGA_API_URL'] = fga.baseUrl;
    process.env['OPENFGA_STORE_ID'] = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
    process.env['OPENFGA_API_TOKEN'] = 'test-preshared-key-never-logged';
  }

  const spine = await startFakeSpineRead({
    keys: kp.keys,
    ...(options.respond ? { respond: options.respond } : {}),
    ...(options.fail ? { fail: options.fail } : {}),
  });

  const subject = options.subject === undefined ? SUB : options.subject;
  const app = buildApp({
    db: stubDb,
    logLevel: 'silent',
    compare: {
      spineRead: options.noSpine ? null : new SpineReadClient(spine.baseUrl),
      // The seam the OIDC + DPoP branch plugs into: this handler never reads a
      // token, it asks for an identity. A fake here is exactly what the real
      // resolver will be, minus the verification.
      resolveIdentity: () => (subject === null ? null : { sub: subject }),
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const client = createClient(
    CompareService,
    createConnectTransport({ baseUrl, httpVersion: '1.1' }),
  );
  return { client, spine, fga, app, baseUrl };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  // The ported module writes its one-shot boot and fail-closed lines to
  // console, by design — it may not import this app's logger and stay
  // portable. Silenced here so the suite's output is its own; the CONTENT of
  // those lines is asserted in test/entitlements/grants.test.ts.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  if (harness) {
    await harness.app.close();
    await harness.spine.close();
    if (harness.fga) await harness.fga.close();
    harness = null;
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  vi.restoreAllMocks();
});

const codeOf = async (p: Promise<unknown>): Promise<Code | 'OK'> => {
  try {
    await p;
    return 'OK';
  } catch (err) {
    return err instanceof ConnectError ? err.code : 'OK';
  }
};

// ===========================================================================
// (a) and (b) — BOTH HALVES. The one the plan says must not be asserted alone
// is the hiding half, so the revealing half comes first.
// ===========================================================================
describe('the entitlement acceptance — both halves', () => {
  it('ENTITLED: reveals the level key and reports nothing redacted', async () => {
    harness = await start({ allow: true });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    // The level key itself, not a proxy for it.
    const result = JSON.parse(res.resultJson) as {
      heads: { perStore: { offers: { stockOnHand?: string }[] }[] }[];
    };
    expect(result.heads[0]?.perStore[0]?.offers[0]?.stockOnHand).toBe('7');
    expect(res.coverage?.redacted).toEqual([]);

    // And it was entitled for the right reason: the spine VERIFIED an assertion.
    expect(harness.spine.calls[0]?.entitlementOutcome).toBe('granted');
  });

  it('UNENTITLED: hides the level key and names inventory_levels in coverage.redacted', async () => {
    harness = await start({ allow: false });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    const result = JSON.parse(res.resultJson) as {
      heads: { perStore: { offers: { stockOnHand?: string; availability?: string }[] }[] }[];
    };
    expect(result.heads[0]?.perStore[0]?.offers[0]?.stockOnHand).toBeUndefined();
    // Availability survives: the gate is on MAGNITUDE, not on orderability.
    expect(result.heads[0]?.perStore[0]?.offers[0]?.availability).toBe('in_stock');
    expect(res.coverage?.redacted).toEqual([INVENTORY_LEVELS]);

    // A denial is a SUCCESSFUL response, never an error.
    expect(harness.spine.calls[0]?.entitlementOutcome).toBe('absent');
  });

  it('the two halves differ ONLY in the entitlement, nothing else in the setup', async () => {
    // Guards against the acceptance passing because the two cases were wired
    // differently rather than authorised differently.
    harness = await start({ allow: true });
    const entitled = await harness.client.compare({
      seed: { case: 'gtin14', value: GTIN },
      nowIso: NOW_ISO,
    });
    await harness.app.close();
    await harness.spine.close();
    if (harness.fga) await harness.fga.close();
    harness = null;
    resetEntitlementGrantsForTest();
    resetEntitlementSigningForTest();
    for (const k of ENV_KEYS) delete process.env[k];

    harness = await start({ allow: false });
    const denied = await harness.client.compare({
      seed: { case: 'gtin14', value: GTIN },
      nowIso: NOW_ISO,
    });

    expect(entitled.resultJson).toBe(ENTITLED_RESULT_JSON);
    expect(denied.resultJson).toBe(REDACTED_RESULT_JSON);
    expect(entitled.coverage?.semanticsRev).toBe(denied.coverage?.semanticsRev);
  });
});

// ===========================================================================
// (c) and (d) — THE LIFT IS A COPY, NOT A COMPUTATION.
// ===========================================================================
describe('the coverage lift is verbatim', () => {
  it('(c) the lifted redacted list equals the one inside result_json, same members, same order', async () => {
    harness = await start({
      allow: false,
      respond: () =>
        create(CompareResponseSchema, {
          // Two entries in a deliberately non-alphabetical order: a lift that
          // sorted, deduplicated or filtered would be caught here and nowhere else.
          resultJson:
            '{"heads":[],"related":[],"coverage":{"redacted":["inventory_levels","a_future_facet","inventory_levels"],"semanticsRev":"0123456789abcdef"}}',
        }),
    });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    const inside = (JSON.parse(res.resultJson) as { coverage: { redacted: string[] } }).coverage
      .redacted;
    expect(res.coverage?.redacted).toEqual(inside);
    expect(res.coverage?.redacted).toEqual([
      'inventory_levels',
      'a_future_facet',
      'inventory_levels',
    ]);
  });

  it('(d) semantics_rev passes through unchanged', async () => {
    harness = await start({
      allow: false,
      respond: () =>
        create(CompareResponseSchema, {
          resultJson: '{"heads":[],"related":[],"coverage":{"semanticsRev":"fedcba9876543210"}}',
        }),
    });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
    expect(res.coverage?.semanticsRev).toBe('fedcba9876543210');
  });

  it('an absent redacted key lifts to an empty list — "you saw everything", not "unknown"', async () => {
    // The spine stamps `redacted` ONLY when something was removed, and a proto3
    // repeated field has no presence. The 1:1 mapping is spine-absent ->
    // wire-empty, and it must never become a claim that something WAS withheld.
    harness = await start({
      allow: true,
      respond: () =>
        create(CompareResponseSchema, {
          resultJson: '{"heads":[],"related":[],"coverage":{"semanticsRev":"a1b2c3d4e5f60789"}}',
        }),
    });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
    expect(res.coverage?.redacted).toEqual([]);
  });

  it('result_json crosses BYTE FOR BYTE — never parsed and reserialised', async () => {
    // Whitespace, key order and a long numeric STRING that JSON.parse ->
    // JSON.stringify would keep but a Struct-shaped rewrite would fold to
    // float64. The doctrine is "the wire carries the raw token"; this is the
    // assertion that the coordinator honours it.
    const odd =
      '{ "heads" : [ ] ,\n  "related":[],\n  "coverage" : { "semanticsRev" : "a1b2c3d4e5f60789" } ,\n  "note":"9007199254740993" }';
    harness = await start({
      allow: true,
      respond: () => create(CompareResponseSchema, { resultJson: odd }),
    });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
    expect(res.resultJson).toBe(odd);
  });
});

// ===========================================================================
// (e) — TRACEPARENT ACROSS BOTH HOPS (§A.5 rule 3).
// ===========================================================================
describe('traceparent threads both Connect hops', () => {
  const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
  const INBOUND = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

  it('extracts the inbound traceparent and injects it on the outbound SpineRead hop', async () => {
    harness = await start({ allow: true });

    await harness.client.compare(
      { seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO },
      { headers: { traceparent: INBOUND } },
    );

    const outbound = harness.spine.calls[0]?.headers.get('traceparent');
    expect(outbound).toBeDefined();
    // SAME trace, so the two services' logs join on it...
    expect(outbound).toContain(TRACE_ID);
    // ...and a DIFFERENT span id, because the coordinator is its own span in
    // the trace rather than a transparent relay. Equality here would mean the
    // header was copied, not propagated.
    expect(outbound).not.toBe(INBOUND);
    expect(outbound?.split('-')[2]).not.toBe('00f067aa0ba902b7');
  });

  it('still sends a traceparent when the client sent none, so the hop is never untraced', async () => {
    harness = await start({ allow: true });

    await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    const outbound = harness.spine.calls[0]?.headers.get('traceparent');
    expect(outbound).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    // Not the all-zero id: fc-shared reads that as "no span" and drops the tag.
    expect(outbound).not.toContain('00000000000000000000000000000000');
  });
});

// ===========================================================================
// THE ASSERTION IS SERVER-SIDE ONLY.
// ===========================================================================
describe('the entitlement assertion never leaves the mesh', () => {
  it('goes to the spine as request metadata and never back to the client', async () => {
    harness = await start({ allow: true });

    const res = await harness.client.compare({
      seed: { case: 'gtin14', value: GTIN },
      nowIso: NOW_ISO,
    });

    const sent = harness.spine.calls[0]?.headers.get(ENTITLEMENTS_HEADER);
    expect(sent).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    // Not in the body, not in coverage, not anywhere the client can read.
    expect(JSON.stringify(res)).not.toContain(sent as string);
    expect(res.resultJson).not.toContain('eyJ');
  });

  it('never carries the caller subject in the request message', async () => {
    // A client that could name its own subject would be a trusted mint.
    harness = await start({ allow: true });

    await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    expect(JSON.stringify(harness.spine.calls[0]?.request)).not.toContain(SUB);
  });
});

// ===========================================================================
// FAIL CLOSED — the state prod is in until D4 lands.
// ===========================================================================
describe('fail closed', () => {
  it('OpenFGA unconfigured: a successful, redacted Compare that says so', async () => {
    harness = await start({ allow: null });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });

    expect(res.coverage?.redacted).toEqual([INVENTORY_LEVELS]);
    expect(harness.spine.calls[0]?.entitlementOutcome).toBe('absent');
    expect(JSON.parse(res.resultJson).heads[0].perStore[0].offers[0].stockOnHand).toBeUndefined();
  });

  it('no signing key: redacted, never an error', async () => {
    harness = await start({ allow: true, noSigningKey: true });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
    expect(res.coverage?.redacted).toEqual([INVENTORY_LEVELS]);
  });

  it('no authenticated caller: redacted, and OpenFGA is never asked', async () => {
    harness = await start({ allow: true, subject: null });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
    expect(res.coverage?.redacted).toEqual([INVENTORY_LEVELS]);
    expect(harness.fga?.calls).toHaveLength(0);
  });

  it('a caller identity that is not an Authentik uuid: redacted, and OpenFGA is never asked', async () => {
    harness = await start({ allow: true, subject: '68c1f0a9b2d4e5f6a7b8c9d0' });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
    expect(res.coverage?.redacted).toEqual([INVENTORY_LEVELS]);
    expect(harness.fga?.calls).toHaveLength(0);
  });
});

// ===========================================================================
// THE ERROR CONTRACT (coordinator/v1/compare.proto).
// ===========================================================================
describe('the error contract', () => {
  it('neither seed set -> INVALID_ARGUMENT, before any mesh call', async () => {
    harness = await start({ allow: true });

    await expect(
      codeOf(harness.client.compare({ nowIso: NOW_ISO })),
    ).resolves.toBe(Code.InvalidArgument);
    expect(harness.spine.calls).toHaveLength(0);
  });

  it.each([
    ['an empty seed value', ''],
    ['whitespace', '   '],
  ])('%s -> INVALID_ARGUMENT, before any mesh call', async (_label, value) => {
    harness = await start({ allow: true });

    await expect(
      codeOf(harness.client.compare({ seed: { case: 'gtin14', value }, nowIso: NOW_ISO })),
    ).resolves.toBe(Code.InvalidArgument);
    expect(harness.spine.calls).toHaveLength(0);
  });

  it.each([
    ['empty', ''],
    ['not a timestamp', 'yesterday'],
    ['a date with no time', '2026-09-14'],
    ['an impossible instant', '2026-13-45T99:99:99Z'],
  ])('now_iso %s -> INVALID_ARGUMENT, before any mesh call', async (_label, nowIso) => {
    harness = await start({ allow: true });

    await expect(
      codeOf(harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso })),
    ).resolves.toBe(Code.InvalidArgument);
    expect(harness.spine.calls).toHaveLength(0);
  });

  it('forwards now_iso VERBATIM, offset and all — never restamped, never normalised', async () => {
    // "The coordinator validates the shape and forwards the original
    // characters." A parse-then-reserialise would turn this into ...T03:00:00Z
    // and silently change the clock every verdict is reproducible from.
    const offset = '2026-09-14T12:00:00.000+09:00';
    harness = await start({ allow: true });

    await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: offset });
    expect(harness.spine.calls[0]?.request.nowIso).toBe(offset);
  });

  it('forwards the seed VERBATIM, and the head_id seed as a head_id', async () => {
    harness = await start({ allow: true });

    await harness.client.compare({
      seed: { case: 'headId', value: 'head-77' },
      nowIso: NOW_ISO,
    });
    expect(harness.spine.calls[0]?.request.seed).toEqual({ case: 'headId', value: 'head-77' });
  });

  it('spine unconfigured -> UNAVAILABLE', async () => {
    harness = await start({ allow: true, noSpine: true });

    await expect(
      codeOf(harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO })),
    ).resolves.toBe(Code.Unavailable);
  });

  it('spine transport failure -> UNAVAILABLE, and the message carries no upstream detail', async () => {
    harness = await start({
      allow: true,
      fail: () => {
        throw new ConnectError('spine exploded: dsn=postgres://u:p@h/db', Code.Internal);
      },
    });

    try {
      await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code).toBe(Code.Unavailable);
      expect((err as ConnectError).rawMessage).not.toContain('postgres://');
    }
  });

  it('an unknown seed is OK with an empty heads array, NOT an error', async () => {
    harness = await start({
      allow: true,
      respond: () =>
        create(CompareResponseSchema, {
          resultJson: '{"heads":[],"related":[],"coverage":{"semanticsRev":"a1b2c3d4e5f60789"}}',
        }),
    });

    const res = await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
    expect(JSON.parse(res.resultJson).heads).toEqual([]);
    expect(res.coverage?.redacted).toEqual([]);
  });
});

// ===========================================================================
// A RESPONSE WHOSE COVERAGE CANNOT BE LIFTED IS NOT A coordinator.v1 RESPONSE.
// ===========================================================================
describe('an unliftable spine response is refused, never quietly emptied', () => {
  // Emitting an empty `redacted` when the lift failed would state "you saw
  // everything the spine holds" on a response nobody verified — the confident
  // zero the contract exists to prevent. INTERNAL is the honest answer.
  it.each([
    ['unparseable JSON', '{not json'],
    ['a JSON array rather than an object', '[]'],
    ['no coverage object at all', '{"heads":[],"related":[]}'],
    ['coverage that is not an object', '{"heads":[],"coverage":"none"}'],
    ['redacted that is not an array', '{"coverage":{"redacted":"inventory_levels","semanticsRev":"a1b2c3d4e5f60789"}}'],
    ['redacted holding a non-string', '{"coverage":{"redacted":[7],"semanticsRev":"a1b2c3d4e5f60789"}}'],
    ['no semanticsRev', '{"coverage":{"redacted":[]}}'],
    ['semanticsRev that is not a string', '{"coverage":{"semanticsRev":42}}'],
  ])('%s -> INTERNAL', async (_label, resultJson) => {
    harness = await start({
      allow: true,
      respond: () => create(CompareResponseSchema, { resultJson }),
    });

    await expect(
      codeOf(harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO })),
    ).resolves.toBe(Code.Internal);
  });

  it('the refusal never echoes the spine payload back to the client', async () => {
    harness = await start({
      allow: true,
      respond: () =>
        create(CompareResponseSchema, { resultJson: '{"secretish":"s3cr3t-do-not-echo"' }),
    });

    try {
      await harness.client.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW_ISO });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ConnectError).rawMessage).not.toContain('s3cr3t-do-not-echo');
    }
  });
});
