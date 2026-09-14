/**
 * SpineReadClient tests, ported from fc-backend tests/services/
 * spineReadClient.test.ts and extended with the traceparent interceptor
 * (§A.5 rule 3), which is what slice 1b adds to the ported file.
 *
 * Driven against an IN-PROCESS SpineRead fake: a plain node:http (HTTP/1.1)
 * server + connectNodeAdapter, the same cleartext h1 shape the production
 * spine serves. This ALSO regression-pins the transport choice: if
 * createConnectTransport were ever swapped for createGrpcTransport (which
 * needs h2), every call here would fail — a plain node:http server cannot
 * serve an h2/h2c client, it has no ALPN and no h2c upgrade handling.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { create } from '@bufbuild/protobuf';
import { CompareResponseSchema } from '@figurecollecting/ingest-contract/read';
import { ENTITLEMENTS_HEADER } from '@figurecollecting/ingest-contract/entitlement';
import {
  SpineReadClient,
  createSpineReadClientFromEnv,
  DEFAULT_COMPARE_TIMEOUT_MS,
} from '../../src/spine/spineReadClient.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';

const NOW_ISO = '2026-09-14T12:00:00.000Z';
const NO_KEYS = new Map();

let spine: FakeSpineRead | null = null;
let saved: Record<string, string | undefined> = {};
let telemetry: Telemetry;
const ENV_KEYS = ['SPINE_READ_URL', 'SPINE_READ_TIMEOUT_MS'] as const;

// A REAL tracer provider, because the assertions here are about real span ids.
// Without one, @opentelemetry/api hands out non-recording spans whose context
// is all zeroes, the W3C propagator declines to inject them, and every
// traceparent assertion below would pass or fail for the wrong reason.
beforeAll(() => {
  telemetry = startTelemetry({ env: {}, serviceName: 'fc-coordinator-test' });
});

afterAll(async () => {
  await telemetry.shutdown();
});

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(async () => {
  if (spine) {
    await spine.close();
    spine = null;
  }
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
});

describe('SpineReadClient — the request it makes', () => {
  it('speaks Connect over HTTP/1.1 to a plain node:http server', async () => {
    // The whole assertion is that this call SUCCEEDS. An h2-only transport
    // cannot complete it, so a swap to createGrpcTransport turns this red.
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const client = new SpineReadClient(spine.baseUrl);

    const res = await client.compare({ gtin14: '04573102591234' }, NOW_ISO);
    expect(res.resultJson).toContain('"heads"');
  });

  it.each([
    ['gtin14', { gtin14: '04573102591234' }, { case: 'gtin14', value: '04573102591234' }],
    ['headId', { headId: 'head-9' }, { case: 'headId', value: 'head-9' }],
  ])('sends a %s seed as the matching oneof case', async (_label, seed, expected) => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    await new SpineReadClient(spine.baseUrl).compare(seed as never, NOW_ISO);
    expect(spine.calls[0]?.request.seed).toEqual(expected);
  });

  it('sends now_iso as the caller minted it', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    await new SpineReadClient(spine.baseUrl).compare(
      { gtin14: '04573102591234' },
      '2026-09-14T12:00:00.000+09:00',
    );
    expect(spine.calls[0]?.request.nowIso).toBe('2026-09-14T12:00:00.000+09:00');
  });
});

describe('SpineReadClient — the entitlement header', () => {
  it('attaches the assertion as request METADATA, never as a message field', async () => {
    const kp = generateTestSigningKey('ent-test-2026-09');
    spine = await startFakeSpineRead({ keys: kp.keys });
    const token = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln';

    await new SpineReadClient(spine.baseUrl).compare({ gtin14: '0457310259123' }, NOW_ISO, token);

    expect(spine.calls[0]?.headers.get(ENTITLEMENTS_HEADER)).toBe(token);
    expect(JSON.stringify(spine.calls[0]?.request)).not.toContain(token);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('sends NO header for %s — a lost key must not look like a present one', async (_l, value) => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    await new SpineReadClient(spine.baseUrl).compare(
      { gtin14: '04573102591234' },
      NOW_ISO,
      value as string | null | undefined,
    );
    expect(spine.calls[0]?.headers.get(ENTITLEMENTS_HEADER)).toBeNull();
  });

  it('an absent header is a NORMAL 200, not an error', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const res = await new SpineReadClient(spine.baseUrl).compare(
      { gtin14: '04573102591234' },
      NOW_ISO,
    );
    expect(res.resultJson).toContain('"redacted":["inventory_levels"]');
  });
});

describe('SpineReadClient — traceparent on the outbound hop (§A.5 rule 3)', () => {
  it('injects a traceparent by default, with no wiring at the call site', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    await new SpineReadClient(spine.baseUrl).compare({ gtin14: '04573102591234' }, NOW_ISO);

    expect(spine.calls[0]?.headers.get('traceparent')).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/,
    );
  });

  it('joins the ACTIVE trace, as a CHILD hop rather than a copy of its parent', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const client = new SpineReadClient(spine.baseUrl);
    const span = trace.getTracer('test').startSpan('caller');
    const parent = span.spanContext();

    await context.with(trace.setSpan(context.active(), span), () =>
      client.compare({ gtin14: '04573102591234' }, NOW_ISO),
    );
    span.end();

    const header = spine.calls[0]?.headers.get('traceparent') as string;
    const [, traceId, spanId] = header.split('-');
    // Same trace — this is the whole point of propagation.
    expect(traceId).toBe(parent.traceId);
    // Different span — the outbound RPC is its own unit of work. Equality here
    // would mean the header was copied through rather than propagated, and the
    // spine's span would hang off the caller instead of off this hop.
    expect(spanId).not.toBe(parent.spanId);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('accepts injected interceptors, so a caller can opt out or add its own', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const client = new SpineReadClient(spine.baseUrl, DEFAULT_COMPARE_TIMEOUT_MS, [
      (next) => (req) => {
        req.header.set('x-test-marker', 'present');
        return next(req);
      },
    ]);

    await client.compare({ gtin14: '04573102591234' }, NOW_ISO);
    expect(spine.calls[0]?.headers.get('x-test-marker')).toBe('present');
    // The default list was REPLACED, not appended to.
    expect(spine.calls[0]?.headers.get('traceparent')).toBeNull();
  });
});

describe('createSpineReadClientFromEnv — the degraded-mode seam', () => {
  it('returns null when SPINE_READ_URL is unset, so no transport is ever constructed', () => {
    expect(createSpineReadClientFromEnv({})).toBeNull();
  });

  it('returns null for an empty SPINE_READ_URL', () => {
    expect(createSpineReadClientFromEnv({ SPINE_READ_URL: '' })).toBeNull();
  });

  it('builds a working client from the environment', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const client = createSpineReadClientFromEnv({ SPINE_READ_URL: spine.baseUrl });
    expect(client).not.toBeNull();

    await (client as SpineReadClient).compare({ gtin14: '04573102591234' }, NOW_ISO);
    expect(spine.calls).toHaveLength(1);
    // Built from env, still traced.
    expect(spine.calls[0]?.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-/);
  });

  it('honours SPINE_READ_TIMEOUT_MS and falls back on nonsense', () => {
    expect(createSpineReadClientFromEnv({ SPINE_READ_URL: 'http://x', SPINE_READ_TIMEOUT_MS: '250' }))
      .not.toBeNull();
    expect(
      createSpineReadClientFromEnv({ SPINE_READ_URL: 'http://x', SPINE_READ_TIMEOUT_MS: 'soon' }),
    ).not.toBeNull();
  });

  it('times out rather than hanging when the spine never answers', async () => {
    spine = await startFakeSpineRead({
      keys: NO_KEYS,
      respond: () => new Promise<never>(() => {}),
    });
    const client = new SpineReadClient(spine.baseUrl, 150);

    await expect(client.compare({ gtin14: '04573102591234' }, NOW_ISO)).rejects.toThrow();
  });

  it('pins the default deadline — the spine read RPC has none of its own', () => {
    expect(DEFAULT_COMPARE_TIMEOUT_MS).toBe(10_000);
  });
});

describe('SpineReadClient — the response is passed through', () => {
  it('returns the spine CompareResponse unedited', async () => {
    const odd = '{ "heads" : [] , "coverage" : { "semanticsRev" : "a1b2c3d4e5f60789" } }';
    spine = await startFakeSpineRead({
      keys: NO_KEYS,
      respond: () => create(CompareResponseSchema, { resultJson: odd }),
    });

    const res = await new SpineReadClient(spine.baseUrl).compare(
      { gtin14: '04573102591234' },
      NOW_ISO,
    );
    expect(res.resultJson).toBe(odd);
  });
});
