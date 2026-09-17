/**
 * Entitlement GRANT resolution tests (D6 U6): the OpenFGA Check that decides
 * whether the coordinator mints an assertion at all. Ported from fc-backend
 * tests/services/entitlements/grants.test.ts (jest -> vitest, ESM specifiers),
 * plus the coordinator's own FAIL-CLOSED cases at the end — OpenFGA is
 * unreachable from fc-app-01 until D4 lands, so "unconfigured" and
 * "unreachable" are the states this service actually ships in.
 *
 * THE RULE UNDER TEST IS THE B1 FAIL-OPEN LESSON: any Check that does not come
 * back as an explicit `allowed: true` is a DENY. A 500, a refused connection, a
 * timeout, a body of the wrong shape, an unconfigured client — all of them end
 * in an empty grant list, no header, and a normal redacted read. There is no
 * error path that reaches the user, because a gate that fails loudly is a gate
 * that can be knocked over.
 *
 * Driven against a REAL in-process OpenFGA — now one that serves
 * openfga.v1.OpenFGAService/Check over gRPC on cleartext h2c, the shape the
 * real service presents on :8081 — rather than against a mocked client, so the
 * request SHAPE (method, message fields, bearer metadata) is pinned too. That
 * shape is the part that silently returns `allowed:false` forever if it is
 * wrong, and moving transports gave it three new ways to be wrong: a method
 * path built from a descriptor, protobuf field numbers instead of JSON keys,
 * and a credential carried as metadata.
 *
 * WHAT MOVED OUT OF THIS FILE. The JSON-body cases — no `allowed` key, a truthy
 * string, a non-object body, unparseable JSON — cannot happen on a typed wire
 * and are not simply deleted: their successor cases, which ask the same
 * question of gRPC, are in test/entitlements/wire-surprise.test.ts.
 */
import { Code } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { INVENTORY_LEVELS } from '@figurecollecting/ingest-contract/entitlement';
import {
  grantsForSubject,
  entitlementHeaderFor,
  entitlementGrantCounters,
  resetEntitlementGrantsForTest,
} from '../../src/entitlements/grants.js';
import { resetEntitlementSigningForTest } from '../../src/entitlements/assertion.js';
import { generateTestSigningKey, verifyEntitlementHeader } from '../helpers/entitlementVerifier.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const OTHER_SUB = '11111111-2222-3333-4444-555555555555';
const STORE_ID = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const TOKEN = 'test-preshared-key-never-logged';

const ENV_KEYS = [
  'OPENFGA_GRPC_URL',
  'OPENFGA_STORE_ID',
  'OPENFGA_API_TOKEN',
  'OPENFGA_MODEL_ID',
  'OPENFGA_APP_OBJECT',
  'OPENFGA_TIMEOUT_MS',
  'ENTITLEMENT_GRANT_CACHE_TTL_MS',
  'ENTITLEMENT_GRANT_ERROR_TTL_MS',
  'ENTITLEMENT_SIGNING_KEY_PEM',
  'ENTITLEMENT_SIGNING_KID',
  'ENTITLEMENT_GRANT_CACHE_MAX',
] as const;

let saved: Record<string, string | undefined> = {};
let stub: FakeOpenFga | null = null;
let warnSpy: MockInstance<typeof console.warn>;
let errorSpy: MockInstance<typeof console.error>;
let logSpy: MockInstance<typeof console.log>;

const allLoggedText = (): string =>
  [...warnSpy.mock.calls, ...errorSpy.mock.calls, ...logSpy.mock.calls]
    .map((args) => args.map(String).join(' '))
    .join('\n');

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  if (stub) {
    await stub.close();
    stub = null;
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
});

const configure = (baseUrl: string, extra: Record<string, string> = {}): void => {
  process.env['OPENFGA_GRPC_URL'] = baseUrl;
  process.env['OPENFGA_STORE_ID'] = STORE_ID;
  process.env['OPENFGA_API_TOKEN'] = TOKEN;
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
};

describe('grantsForSubject — the Check', () => {
  it('returns the inventory_levels grant when OpenFGA allows', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([INVENTORY_LEVELS]);
    expect(entitlementGrantCounters()['allow']).toBe(1);
  });

  it('sends the Check OpenFGA expects: the Check RPC, the app-level tuple, and a bearer', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);

    await grantsForSubject(SUB);

    expect(stub.calls).toHaveLength(1);
    const call = stub.calls[0];
    // The server DISPATCHED this, which it can only do from a correctly framed
    // POST /openfga.v1.OpenFGAService/Check on an HTTP/2 stream.
    expect(call?.method).toBe('Check');
    expect(call?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call?.storeId).toBe(STORE_ID);
    // The subject is `user:<authentik uuid>`; the relation and object are the
    // app-level pair from the B1 model — never a per-object feature join.
    expect({ user: call?.user, relation: call?.relation, object: call?.object }).toEqual({
      user: `user:${SUB}`,
      relation: INVENTORY_LEVELS,
      object: 'app:figurecollecting',
    });
    // proto3 gives a scalar string no presence, so "not pinned" is the empty
    // string on the wire rather than an absent key. OpenFGA reads both as
    // "evaluate against the latest model", which is the same decision the JSON
    // body made by omitting it.
    expect(call?.modelId).toBe('');
  });

  it('pins the authorization model when one is configured', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl, { OPENFGA_MODEL_ID: '01KXA5NRMNY7C8MZETNYXQT1CJ' });

    await grantsForSubject(SUB);
    expect(stub.calls[0]?.modelId).toBe(
      '01KXA5NRMNY7C8MZETNYXQT1CJ',
    );
  });

  it('honours an overridden app object', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl, { OPENFGA_APP_OBJECT: 'app:staging' });

    await grantsForSubject(SUB);
    expect(stub.calls[0]?.object).toBe('app:staging');
  });

  it('sends no Authorization header when no preshared key is configured', async () => {
    // A supported deployment: OpenFGA running without auth. Sending an empty
    // bearer instead of none would be rejected by a server that DOES require
    // one, turning a config gap into a puzzling 401 rather than a plain one.
    stub = await startFakeOpenFga(() => true);
    process.env['OPENFGA_GRPC_URL'] = stub.baseUrl;
    process.env['OPENFGA_STORE_ID'] = STORE_ID;

    await expect(grantsForSubject(SUB)).resolves.toEqual([INVENTORY_LEVELS]);
    expect(stub.calls[0]?.authorization).toBeUndefined();
  });

  it('tolerates a trailing slash on the endpoint url', async () => {
    // The old client built its path by hand and had to strip this; the gRPC
    // transport builds it from the descriptor. The case stays because the
    // MISTAKE stays available to an operator writing the manifest, and a
    // doubled slash would be a 404 at the far end dressed up as Unimplemented.
    stub = await startFakeOpenFga(() => true);
    configure(`${stub.baseUrl}/`);

    await expect(grantsForSubject(SUB)).resolves.toEqual([INVENTORY_LEVELS]);
    expect(stub.calls).toHaveLength(1);
  });

  it('returns no grants when OpenFGA denies', async () => {
    stub = await startFakeOpenFga(() => false);
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters()['deny']).toBe(1);
  });
});

describe('grantsForSubject — every failure is a DENY (the B1 fail-open lesson)', () => {
  it('denies on an internal error from OpenFGA', async () => {
    stub = await startFakeOpenFga(() => true);
    stub.reply({ code: Code.Internal });
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters()['error']).toBe(1);
  });

  it('denies on an unauthenticated — a bad preshared key must not open the gate', async () => {
    stub = await startFakeOpenFga(() => true);
    stub.reply({ code: Code.Unauthenticated });
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters()['error']).toBe(1);
  });

  it('denies when the connection is refused', async () => {
    // A port nothing listens on: start a stub, take its URL, then close it.
    const dead = await startFakeOpenFga(() => true);
    const deadUrl = dead.baseUrl;
    await dead.close();
    configure(deadUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters()['error']).toBe(1);
  });

  it('denies when the Check outruns its timeout', async () => {
    stub = await startFakeOpenFga(() => true);
    stub.reply({ delayMs: 60_000 }); // accepts the stream, answers never
    configure(stub.baseUrl, { OPENFGA_TIMEOUT_MS: '120' });

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters()['error']).toBe(1);
  });

  it('denies — as a DENY, not an error — when `allowed` is absent from the response', async () => {
    // A SEMANTIC THE TRANSPORT CHANGED, recorded rather than glossed over. Over
    // JSON, `{"resolution":""}` had no `allowed` key and was an ERROR: a body
    // that is not a Check response is a fault. proto3 has no presence on a
    // scalar bool, so an absent `allowed` and an explicit `false` are THE SAME
    // BYTES, and the answer below is indistinguishable from a deny by
    // construction — there is no reading of the wire that could separate them.
    //
    // The distinction is therefore lost, and it is lost in the safe direction:
    // what was an error-deny is now a plain deny. Both withhold the grant. The
    // cost is operational rather than security — a malformed OpenFGA response
    // of this one shape no longer stands out as a fault — and the shapes that
    // CAN still be told apart are covered in wire-surprise.test.ts.
    stub = await startFakeOpenFga(() => true);
    stub.reply({ allowed: false });
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters()['deny']).toBe(1);
    expect(entitlementGrantCounters()['error']).toBeUndefined();
  });

  it.each([
    ['empty', ''],
    ['blank', '  '],
  ])('denies a %s subject without calling OpenFGA', async (_l, sub) => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);

    await expect(grantsForSubject(sub)).resolves.toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('grantsForSubject — the subject must be an Authentik uuid', () => {
  // OpenFGA stores a subject VERBATIM and never resolves it, and fc-infra's
  // grant script refuses to WRITE a tuple for anything but a uuid. A module
  // that checks a differently-shaped subject therefore asks a question no
  // tuple can ever answer, and the symptom is numbers silently missing.
  it.each([
    ['a Mongo ObjectId', '68c1f0a9b2d4e5f6a7b8c9d0'],
    ['an email', 'ross@example.com'],
    ['a username', 'ross'],
    ['a uuid with a stray prefix', 'user:7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33'],
    ['a uuid missing a group', '7f3a1c62-9d44-4e51-8b0a'],
    ['a numeric pk', '42'],
  ])('refuses %s without calling OpenFGA', async (_label, subject) => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);

    await expect(grantsForSubject(subject)).resolves.toEqual([]);
    expect(stub.calls).toHaveLength(0);
    expect(entitlementGrantCounters()['bad_subject']).toBeGreaterThanOrEqual(1);
  });

  it('refuses a non-string subject rather than throwing', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);

    await expect(grantsForSubject(undefined as unknown as string)).resolves.toEqual([]);
    await expect(grantsForSubject(null as unknown as string)).resolves.toEqual([]);
    await expect(grantsForSubject(12345 as unknown as string)).resolves.toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });

  it('accepts an uppercase uuid — OpenFGA is case-sensitive, so it is passed through verbatim', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);
    const upper = SUB.toUpperCase();

    await expect(grantsForSubject(upper)).resolves.toEqual([INVENTORY_LEVELS]);
    expect(stub.calls[0]?.user).toBe(`user:${upper}`);
  });
});

describe('grantsForSubject — unconfigured', () => {
  it('denies with ONE warning and no network call when OpenFGA is not configured', async () => {
    // Two DISTINCT subjects, so neither is answered from the other's cache
    // entry: the point is that the warning is one-shot for the PROCESS, not
    // one per user, which is the difference between a line an operator reads
    // and a line an operator filters out.
    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    await expect(grantsForSubject(OTHER_SUB)).resolves.toEqual([]);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(entitlementGrantCounters()['unconfigured']).toBe(2);
  });

  it('denies when the store id is missing even though the URL is set', async () => {
    stub = await startFakeOpenFga(() => true);
    process.env['OPENFGA_GRPC_URL'] = stub.baseUrl;

    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(stub.calls).toHaveLength(0);
  });
});

describe('grantsForSubject — caching keeps the hot read path off OpenFGA', () => {
  it('serves a repeat check for the same subject from cache', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl, { ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000' });

    await grantsForSubject(SUB, 1_000);
    await grantsForSubject(SUB, 5_000);
    await grantsForSubject(SUB, 30_000);

    expect(stub.calls).toHaveLength(1);
    expect(entitlementGrantCounters()['cache_hit']).toBe(2);
  });

  it('re-checks once the TTL has passed', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl, { ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000' });

    await grantsForSubject(SUB, 1_000);
    await grantsForSubject(SUB, 31_001);

    expect(stub.calls).toHaveLength(2);
  });

  it('caches denies too — a revoked user does not cost a Check per request', async () => {
    stub = await startFakeOpenFga(() => false);
    configure(stub.baseUrl, { ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000' });

    await grantsForSubject(SUB, 1_000);
    await grantsForSubject(SUB, 2_000);

    expect(stub.calls).toHaveLength(1);
  });

  it('keys the cache per subject', async () => {
    stub = await startFakeOpenFga((c) => c.user === `user:${SUB}`);
    configure(stub.baseUrl);

    await expect(grantsForSubject(SUB, 1_000)).resolves.toEqual([INVENTORY_LEVELS]);
    await expect(grantsForSubject(OTHER_SUB, 1_000)).resolves.toEqual([]);
    await expect(grantsForSubject(SUB, 2_000)).resolves.toEqual([INVENTORY_LEVELS]);

    expect(stub.calls).toHaveLength(2);
  });

  it('caches an ERROR deny only briefly, so an OpenFGA blip does not pin a user out for the full TTL', async () => {
    stub = await startFakeOpenFga(() => true);
    // Once, then healthy. A sticky override plus a timer would be a race.
    stub.replyOnce({ code: Code.Internal });
    configure(stub.baseUrl, {
      ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000',
      ENTITLEMENT_GRANT_ERROR_TTL_MS: '5000',
    });

    await expect(grantsForSubject(SUB, 1_000)).resolves.toEqual([]);
    // Inside the short error window: still denied, still no second call.
    await expect(grantsForSubject(SUB, 3_000)).resolves.toEqual([]);
    expect(stub.calls).toHaveLength(1);

    // Past it, long before the success TTL would have expired.
    await expect(grantsForSubject(SUB, 7_000)).resolves.toEqual([INVENTORY_LEVELS]);
    expect(stub.calls).toHaveLength(2);
  });

  it('collapses concurrent checks for one subject into a single upstream call', async () => {
    // NO GATE, and it is not needed: the in-flight map is written
    // SYNCHRONOUSLY, before the first await inside the Check, so the second
    // through fourth callers find it in the same tick whatever the server does.
    // The gate this case used to hold the response open with was insurance
    // against a race that the module's own ordering rules out.
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);

    const results = await Promise.all([
      grantsForSubject(SUB, 1_000),
      grantsForSubject(SUB, 1_000),
      grantsForSubject(SUB, 1_000),
      grantsForSubject(SUB, 1_000),
    ]);

    expect(results.every((r) => r.length === 1)).toBe(true);
    expect(stub.calls).toHaveLength(1);
  });
});

describe('grantsForSubject — the cache is bounded (it used to grow forever)', () => {
  const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('evicts the least recently written subject once the cap is reached', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl, {
      ENTITLEMENT_GRANT_CACHE_MAX: '2',
      ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000',
    });

    await grantsForSubject(uuid(1), 1_000); // upstream 1
    await grantsForSubject(uuid(2), 1_000); // upstream 2
    await grantsForSubject(uuid(3), 1_000); // upstream 3, and uuid(1) is evicted
    expect(stub.calls).toHaveLength(3);

    // Still inside its 30 s lifetime, so a cache that never evicted would
    // answer this without a call. It does not: the entry is gone.
    await grantsForSubject(uuid(1), 2_000);
    expect(stub.calls).toHaveLength(4);

    // The two most recent are still cached.
    await grantsForSubject(uuid(3), 2_000);
    expect(stub.calls).toHaveLength(4);
  });

  it('drops EXPIRED entries before it touches a live one', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl, {
      ENTITLEMENT_GRANT_CACHE_MAX: '2',
      ENTITLEMENT_GRANT_CACHE_TTL_MS: '10000',
    });

    await grantsForSubject(uuid(1), 1_000); // expires at 11 000
    await grantsForSubject(uuid(2), 8_000); // expires at 18 000
    expect(stub.calls).toHaveLength(2);

    // At 12 000 uuid(1) is dead weight. Admitting uuid(3) should reclaim it and
    // leave the live uuid(2) alone — evicting by age alone would take uuid(2)
    // as well, since it is written after uuid(1).
    await grantsForSubject(uuid(3), 12_000);
    expect(stub.calls).toHaveLength(3);

    await grantsForSubject(uuid(2), 13_000);
    expect(stub.calls).toHaveLength(3);
    expect(entitlementGrantCounters()['evicted']).toBeGreaterThanOrEqual(1);
  });

  it('holds many distinct subjects without exceeding the cap', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl, { ENTITLEMENT_GRANT_CACHE_MAX: '8' });

    for (let i = 0; i < 50; i++) await grantsForSubject(uuid(i), 1_000);

    // 50 distinct subjects, 50 Checks, and the map never held more than 8.
    // Observable as: the first subject is long gone, the last is still there.
    expect(stub.calls).toHaveLength(50);
    await grantsForSubject(uuid(49), 1_000);
    expect(stub.calls).toHaveLength(50);
    await grantsForSubject(uuid(0), 1_000);
    expect(stub.calls).toHaveLength(51);
  });
});

describe('grantsForSubject — a bound of zero is not a bound', () => {
  it.each([
    ['0', '0'],
    ['a negative value', '-1'],
    ['nonsense', 'soon'],
  ])(
    'falls back to the default timeout when the configured one is %s',
    async (_label, value) => {
      // A bound of zero is not a smaller bound, it is the absence of one, and
      // the two transports break in OPPOSITE directions on it: axios read
      // `timeout: 0` as "wait forever" and hung the read, while a gRPC deadline
      // of zero has already expired when the call starts and would deny every
      // read instantly. A value that is not a positive number is therefore
      // refused in favour of the documented default, and the assertions below
      // catch either failure — one never settles, the other settles at once.
      stub = await startFakeOpenFga(() => true);
      stub.reply({ delayMs: 60_000 }); // accepts the stream, answers never
      configure(stub.baseUrl, { OPENFGA_TIMEOUT_MS: value });

      // performance.now(), NOT Date.now(): this is an ELAPSED-TIME measurement
      // and Date.now() is not monotonic. On this estate's WSL2 hosts the host
      // clock resyncs backwards by a whole second often enough to be seen —
      // measured at 2 of 10 runs, with the same signature every time
      // ("expected -933 to be greater than 500", a NEGATIVE duration), and it
      // reproduces identically on develop, so it predates this test's last
      // change. performance.now() is monotonic by definition and cannot go
      // backwards, which removes the failure mode entirely without weakening
      // the assertion by an inch.
      const started = performance.now();
      await expect(grantsForSubject(SUB)).resolves.toEqual([]);
      const elapsed = performance.now() - started;

      // THE LOAD-BEARING ASSERTION IS THAT IT SETTLED AT ALL. With the bound
      // honoured as zero the promise never resolves and this case fails on the
      // runner's own timeout below.
      //
      // The window is deliberately WIDE, and the bound below is NOT the
      // configured 2 000 ms. The original reason was axios's socket inactivity
      // timer firing early under event-loop contention (measured at 1 283 ms
      // against this stub with the loop busy, 2 07x ms idle). The gRPC deadline
      // is a timer on the call rather than the socket and lands closer to
      // 2 000, but the wide window is kept: a bound near the configured value
      // goes red on a loaded runner and proves nothing about the code. 500 ms
      // is still far above any instant-resolve path, which is the failure this
      // case exists to catch.
      expect(elapsed).toBeGreaterThan(500);
      expect(elapsed).toBeLessThan(6_000);
    },
    20000,
  );

  it('falls back to the default CACHE BOUND on a zero, with no clock involved', async () => {
    // The same rule as above on a different bound, asserted through BEHAVIOUR
    // rather than elapsed time — a max of 0 honoured literally would evict on
    // every write, so nothing would ever be served from cache.
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl, {
      ENTITLEMENT_GRANT_CACHE_MAX: '0',
      ENTITLEMENT_GRANT_CACHE_TTL_MS: '30000',
    });

    await grantsForSubject(SUB, 1_000);
    await grantsForSubject(SUB, 2_000);

    expect(stub.calls).toHaveLength(1);
    expect(entitlementGrantCounters()['cache_hit']).toBe(1);
  });
});

describe('secret hygiene', () => {
  it('never logs the preshared key, even when the Check fails', async () => {
    stub = await startFakeOpenFga(() => true);
    stub.reply({ code: Code.Internal });
    configure(stub.baseUrl);

    await grantsForSubject(SUB);
    expect(allLoggedText()).not.toContain(TOKEN);
  });
});

describe('entitlementHeaderFor — the module in one call', () => {
  const KID = 'ent-test-2026-09';

  const withKey = (): ReturnType<typeof generateTestSigningKey> => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    return kp;
  };

  it('checks, then signs: the header verifies and names the subject it was checked for', async () => {
    const kp = withKey();
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);

    const header = await entitlementHeaderFor(SUB);

    const verified = verifyEntitlementHeader(header, kp.keys);
    expect(verified.outcome).toBe('granted');
    expect(verified.sub).toBe(SUB);
    expect([...verified.grants]).toEqual([INVENTORY_LEVELS]);
    // The subject signed is the subject checked — not one resolved twice.
    expect(stub.calls[0]?.user).toBe(`user:${SUB}`);
  });

  it('returns null when the Check denies', async () => {
    withKey();
    stub = await startFakeOpenFga(() => false);
    configure(stub.baseUrl);

    await expect(entitlementHeaderFor(SUB)).resolves.toBeNull();
  });

  it('returns null when the Check errors', async () => {
    withKey();
    stub = await startFakeOpenFga(() => true);
    stub.reply({ code: Code.Internal });
    configure(stub.baseUrl);

    await expect(entitlementHeaderFor(SUB)).resolves.toBeNull();
  });

  it('returns null when there is no signing key, even on an allow', async () => {
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);

    await expect(entitlementHeaderFor(SUB)).resolves.toBeNull();
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('returns null for a %s subject, without calling OpenFGA', async (_l, sub) => {
    withKey();
    stub = await startFakeOpenFga(() => true);
    configure(stub.baseUrl);

    await expect(entitlementHeaderFor(sub)).resolves.toBeNull();
    expect(stub.calls).toHaveLength(0);
  });
});

// ===========================================================================
// THE COORDINATOR'S OWN CASE, added by the port.
//
// Plan §C slice 1: "Ship slice 1 with OpenFGA unconfigured. Every Check then
// denies, every Compare returns redacted, and coverage.redacted says so. That
// is the correct fail-closed state, not a bug." D4 is still open, so this is
// not a hypothetical — it is how the service runs in production on day one.
// The cases above prove each failure in isolation; these prove the WHOLE
// module's answer in the two states prod will actually be in, with a real
// signing key present so nothing can pass for the wrong reason.
// ===========================================================================
describe('FAIL CLOSED — the state this service ships in until D4 lands', () => {
  const KID = 'ent-test-2026-09';

  const withKey = (): ReturnType<typeof generateTestSigningKey> => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    return kp;
  };

  it('mints NO header when OpenFGA is unconfigured, even with a healthy signing key', async () => {
    withKey();
    // No OPENFGA_* at all — exactly the prod deployment described by D4.
    await expect(entitlementHeaderFor(SUB)).resolves.toBeNull();
    await expect(grantsForSubject(SUB)).resolves.toEqual([]);
    expect(entitlementGrantCounters()['unconfigured']).toBeGreaterThanOrEqual(1);
    expect(entitlementGrantCounters()['allow']).toBeUndefined();
  });

  it('mints NO header when OpenFGA is configured but unreachable', async () => {
    withKey();
    const dead = await startFakeOpenFga(() => true);
    const deadUrl = dead.baseUrl;
    await dead.close();
    configure(deadUrl);

    await expect(entitlementHeaderFor(SUB)).resolves.toBeNull();
    expect(entitlementGrantCounters()['error']).toBeGreaterThanOrEqual(1);
    expect(entitlementGrantCounters()['allow']).toBeUndefined();
  });

  it('says so in a warning an operator can act on, naming the consequence', async () => {
    withKey();
    await entitlementHeaderFor(SUB);

    const text = allLoggedText().toLowerCase();
    expect(text).toContain('openfga');
    // Not "check failed" — the symptom an operator will be chasing is missing
    // numbers, and the line has to connect the two.
    expect(text).toContain('redact');
  });

  it('never throws on the unconfigured path, however many callers arrive', async () => {
    withKey();
    const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const results = await Promise.all(
      Array.from({ length: 25 }, (_v, i) => entitlementHeaderFor(uuid(i))),
    );
    expect(results.every((r) => r === null)).toBe(true);
    // One warning for the process, not one per caller.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
