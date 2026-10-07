/**
 * SpineReadClient tests, ported from fc-backend tests/services/
 * spineReadClient.test.ts and extended with the traceparent interceptor
 * (§A.5 rule 3), then moved onto gRPC by R4d.
 *
 * Driven against an IN-PROCESS SpineRead fake that serves gRPC over cleartext
 * h2c and nothing else (test/helpers/fakeSpineRead.ts) — the shape
 * ingest-server's READ_H2C_PORT (:50062) serves inside the pod, before the
 * Linkerd proxy wraps it in mTLS. That pins the transport from both sides: the
 * fake refuses HTTP/1.1 and refuses the Connect protocol, and the WIRE it
 * records says what actually arrived on the socket.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter, createConnectTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  CompareResponseSchema,
  GetProductImagesResponseSchema,
  GetProductsResponseSchema,
  SpineRead,
} from '@figurecollecting/ingest-contract/read';
import { ENTITLEMENTS_HEADER } from '@figurecollecting/ingest-contract/entitlement';
import {
  SpineReadClient,
  createSpineReadClientFromEnv,
  DEFAULT_COMPARE_TIMEOUT_MS,
} from '../../src/spine/spineReadClient.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';
import { startFakeSpineRead, type FakeSpineRead } from '../helpers/fakeSpineRead.js';

const NOW_ISO = '2026-09-14T12:00:00.000Z';
const HEAD = '5f0c2a9e-4b7d-4e21-9c3a-8d1e6f2b7a40';
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

/** gRPC's content types: binary protobuf, never Connect's application/proto or JSON. */
const GRPC_CONTENT_TYPE = /^application\/grpc(\+proto)?$/;

/**
 * The OLD shape of the hop: Connect over a plain HTTP/1.1 server, which is what
 * ingest-server still serves on :50052. Kept here only to prove the client no
 * longer reaches it.
 */
async function startHttp1ConnectSpine(): Promise<{ baseUrl: string; hits: number[]; close: () => Promise<void> }> {
  const hits: number[] = [];
  const routes = (router: ConnectRouter): void => {
    router.service(SpineRead, {
      compare: async () => {
        hits.push(1);
        return create(CompareResponseSchema, { resultJson: '{"heads":[]}' });
      },
    });
  };
  const server = http.createServer(connectNodeAdapter({ routes }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('SpineReadClient — the wire (R4d: gRPC over h2c, Linkerd supplies mTLS)', () => {
  it('Compare arrives as gRPC on an HTTP/2 stream', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const res = await new SpineReadClient(spine.baseUrl).compare({ gtin14: '04573102591234' }, NOW_ISO);

    expect(res.resultJson).toContain('"heads"');
    expect(spine.wire).toHaveLength(1);
    expect(spine.wire[0]?.path).toBe('/read.v1.SpineRead/Compare');
    expect(spine.wire[0]?.httpVersion).toBe('2.0');
    expect(spine.wire[0]?.contentType).toMatch(GRPC_CONTENT_TYPE);
  });

  it('GetProducts and GetProductImages arrive as gRPC on HTTP/2 streams too', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const client = new SpineReadClient(spine.baseUrl);

    await client.getProducts([{ gtin14: '04573102591234' }], NOW_ISO, null, { pageSize: 0, pageToken: '' });
    await client.getProductImages([HEAD], NOW_ISO, null, { pageSize: 0, pageToken: '' });

    expect(spine.wire.map((w) => w.path)).toEqual([
      '/read.v1.SpineRead/GetProducts',
      '/read.v1.SpineRead/GetProductImages',
    ]);
    for (const w of spine.wire) {
      expect(w.httpVersion).toBe('2.0');
      expect(w.contentType).toMatch(GRPC_CONTENT_TYPE);
    }
  });

  it('cannot reach the retired HTTP/1.1 Connect shape: no silent fallback', async () => {
    const old = await startHttp1ConnectSpine();
    try {
      await expect(
        new SpineReadClient(old.baseUrl, 2_000).compare({ gtin14: '04573102591234' }, NOW_ISO),
      ).rejects.toThrow();
      expect(old.hits).toHaveLength(0);
    } finally {
      await old.close();
    }
  });

  it('the fake is not permissive: a Connect client over HTTP/1.1 is refused by it', async () => {
    // Anti-vacuity for every test above. If the fake answered Connect/h1, the
    // gRPC assertions would prove nothing about which client we built.
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const h1 = createClient(SpineRead, createConnectTransport({ baseUrl: spine.baseUrl, httpVersion: '1.1' }));

    await expect(h1.compare({ seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO })).rejects.toThrow();
    expect(spine.calls).toHaveLength(0);
  });

  it('the fake is not permissive: Connect over HTTP/2 is refused as well', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const h2 = createClient(SpineRead, createConnectTransport({ baseUrl: spine.baseUrl, httpVersion: '2' }));

    await expect(h2.compare({ seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO })).rejects.toThrow();
    expect(spine.calls).toHaveLength(0);
    // It reached the socket as HTTP/2 and was refused for its PROTOCOL.
    expect(spine.wire[0]?.httpVersion).toBe('2.0');
    expect(spine.wire[0]?.contentType).not.toMatch(GRPC_CONTENT_TYPE);
  });
});

describe('SpineReadClient — the request it makes', () => {

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

describe('SpineReadClient.getProducts — the request it makes', () => {
  it('sends each ref as the matching read.v1 oneof case, in order', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    await new SpineReadClient(spine.baseUrl).getProducts(
      [{ productId: HEAD }, { gtin14: '04573102591234' }, { sourceItem: { site: 'mfc', nativeId: '1144' } }],
      NOW_ISO,
      null,
      { pageSize: 0, pageToken: '' },
    );

    expect(spine.productCalls[0]?.request.refs.map((r) => r.ref)).toEqual([
      { case: 'productId', value: HEAD },
      { case: 'gtin14', value: '04573102591234' },
      { case: 'sourceItem', value: expect.objectContaining({ site: 'mfc', nativeId: '1144' }) },
    ]);
  });

  it('forwards now_iso, page_size and page_token verbatim', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    await new SpineReadClient(spine.baseUrl).getProducts([{ gtin14: '04573102591234' }], NOW_ISO, null, {
      pageSize: 75,
      pageToken: 'opaque-token-1',
    });

    const req = spine.productCalls[0]?.request;
    expect(req?.nowIso).toBe(NOW_ISO);
    expect(req?.pageSize).toBe(75);
    expect(req?.pageToken).toBe('opaque-token-1');
  });

  it('attaches the assertion as METADATA, and sends no header without one', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const client = new SpineReadClient(spine.baseUrl);
    const token = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln';

    await client.getProducts([{ gtin14: '04573102591234' }], NOW_ISO, token, { pageSize: 0, pageToken: '' });
    await client.getProducts([{ gtin14: '04573102591234' }], NOW_ISO, null, { pageSize: 0, pageToken: '' });

    expect(spine.productCalls[0]?.headers.get(ENTITLEMENTS_HEADER)).toBe(token);
    expect(JSON.stringify(spine.productCalls[0]?.request)).not.toContain(token);
    expect(spine.productCalls[1]?.headers.get(ENTITLEMENTS_HEADER)).toBeNull();
  });

  it('is traced like Compare', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    await new SpineReadClient(spine.baseUrl).getProducts([{ gtin14: '04573102591234' }], NOW_ISO, null, {
      pageSize: 0,
      pageToken: '',
    });
    expect(spine.productCalls[0]?.headers.get('traceparent')).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it('returns products_json and next_page_token unedited', async () => {
    const odd = '{ "products" : [] , "unresolved" : [] , "coverage" : {} }';
    spine = await startFakeSpineRead({
      keys: NO_KEYS,
      respondProducts: () => create(GetProductsResponseSchema, { productsJson: odd, nextPageToken: 'next-1' }),
    });
    const res = await new SpineReadClient(spine.baseUrl).getProducts([{ gtin14: '04573102591234' }], NOW_ISO, null, {
      pageSize: 0,
      pageToken: '',
    });
    expect(res.productsJson).toBe(odd);
    expect(res.nextPageToken).toBe('next-1');
  });

  it('times out rather than hanging', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS, respondProducts: () => new Promise<never>(() => {}) });
    await expect(
      new SpineReadClient(spine.baseUrl, 150).getProducts([{ gtin14: '04573102591234' }], NOW_ISO, null, {
        pageSize: 0,
        pageToken: '',
      }),
    ).rejects.toThrow();
  });
});

describe('SpineReadClient.getProductImages — the request it makes', () => {
  it('forwards product ids, now_iso and paging verbatim, with the assertion as metadata', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    const token = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln';
    await new SpineReadClient(spine.baseUrl).getProductImages([HEAD, 'merged-id'], NOW_ISO, token, {
      pageSize: 20,
      pageToken: 'img-token',
    });

    const call = spine.imageCalls[0];
    expect(call?.request.productIds).toEqual([HEAD, 'merged-id']);
    expect(call?.request.nowIso).toBe(NOW_ISO);
    expect(call?.request.pageSize).toBe(20);
    expect(call?.request.pageToken).toBe('img-token');
    expect(call?.headers.get(ENTITLEMENTS_HEADER)).toBe(token);
  });

  it('sends no header when there is no assertion', async () => {
    spine = await startFakeSpineRead({ keys: NO_KEYS });
    await new SpineReadClient(spine.baseUrl).getProductImages([HEAD], NOW_ISO, '', { pageSize: 0, pageToken: '' });
    expect(spine.imageCalls[0]?.headers.get(ENTITLEMENTS_HEADER)).toBeNull();
  });

  it('returns images_json and next_page_token unedited', async () => {
    const body = '{"products":[],"coverage":{}}';
    spine = await startFakeSpineRead({
      keys: NO_KEYS,
      respondImages: () => create(GetProductImagesResponseSchema, { imagesJson: body, nextPageToken: 'img-2' }),
    });
    const res = await new SpineReadClient(spine.baseUrl).getProductImages([HEAD], NOW_ISO, null, {
      pageSize: 0,
      pageToken: '',
    });
    expect(res.imagesJson).toBe(body);
    expect(res.nextPageToken).toBe('img-2');
  });
});
