/**
 * coordinator.v1.CatalogService, END TO END in one process (WK-07).
 *
 * A real Connect client speaks to a real Fastify server running the real
 * plugin; the handler runs the real ported entitlement module, which asks a
 * real OpenFGA-shaped gRPC endpoint and signs with a real Ed25519 key; the
 * outbound hop is the real SpineReadClient over gRPC on h2c. The only fakes are
 * the two REMOTE services, and the spine fake serves gRPC and nothing else.
 *
 * THE ACCEPTANCE, lettered as plan.json WK-07 letters it:
 *   (a) every Compare and GetProducts call reaches the spine as gRPC over h2c;
 *   (b) an image-URL claim and an unknown key never reach a ProductCard;
 *   (c) 201 refs are INVALID_ARGUMENT before any spine call;
 *   (d) the spine REFUSES a call without a verified assertion, and the entitled
 *       fields are asserted PRESENT, not only that a redaction happened;
 *   (e) GetProductImages returns nothing when the media base is unset;
 *   (f) SearchProducts is a pass-through over read.v1 SpineRead.SearchProducts
 *       (WK-17): field mapping, the 50-hit page cap, the stale-token
 *       translation, the entitlement header, and the gRPC wire.
 *
 * NO PRODUCTION ANYTHING. Every server binds 127.0.0.1 on an ephemeral port and
 * every key is generated per run.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create, toJsonString } from '@bufbuild/protobuf';
import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import {
  GetProductImagesResponseSchema as WireImagesResponseSchema,
  GetProductsResponseSchema as WireProductsResponseSchema,
  SearchProductsResponseSchema as WireSearchResponseSchema,
} from '@figurecollecting/ingest-contract/read';
import { CatalogService, CompareService, ProductCardSchema } from '@figurecollecting/fc-api-contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import {
  resetEntitlementGrantsForTest,
  resetEntitlementSigningForTest,
} from '../../src/entitlements/index.js';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';
import {
  CANNED_HEAD_ID,
  cannedProductRecord,
  startFakeSpineRead,
  type FakeSpineReadOptions,
  type FakeSpineRead,
} from '../helpers/fakeSpineRead.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';

const KID = 'ent-test-2026-09';
const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const GTIN = '04573102591234';
const NOW = new Date('2026-10-07T03:30:00.000Z');
const MEDIA = 'https://images.figurecollecting.test/d';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const GRPC_CONTENT_TYPE = /^application\/grpc(\+proto)?$/;

const ENV_KEYS = [
  'OPENFGA_GRPC_URL',
  'OPENFGA_STORE_ID',
  'OPENFGA_API_TOKEN',
  'ENTITLEMENT_SIGNING_KEY_PEM',
  'ENTITLEMENT_SIGNING_KID',
] as const;

const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

interface Harness {
  catalog: Client<typeof CatalogService>;
  compare: Client<typeof CompareService>;
  spine: FakeSpineRead;
  fga: FakeOpenFga;
  app: FastifyInstance;
}

interface HarnessOptions extends Omit<FakeSpineReadOptions, 'keys'> {
  /** OpenFGA's answer for the caller. */
  allow?: boolean;
  /** Public media base, or null for the default (unset). */
  mediaBaseUrl?: string | null;
  /** Point the coordinator at no spine at all. */
  noSpine?: boolean;
  /** Identity the resolver hands the handler; `null` = no authenticated caller. */
  subject?: string | null;
}

let harness: Harness | null = null;
let saved: Record<string, string | undefined> = {};
let telemetry: Telemetry;

beforeAll(() => {
  telemetry = startTelemetry({ env: {}, serviceName: 'fc-coordinator-test' });
});

afterAll(async () => {
  await telemetry.shutdown();
});

async function start(options: HarnessOptions = {}): Promise<Harness> {
  const kp = generateTestSigningKey(KID);
  process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
  process.env['ENTITLEMENT_SIGNING_KID'] = KID;

  const fga = await startFakeOpenFga(() => options.allow ?? true);
  process.env['OPENFGA_GRPC_URL'] = fga.baseUrl;
  process.env['OPENFGA_STORE_ID'] = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
  process.env['OPENFGA_API_TOKEN'] = 'test-preshared-key-never-logged';

  const { allow: _allow, mediaBaseUrl, noSpine, subject, ...spineOptions } = options;
  const spine = await startFakeSpineRead({ keys: kp.keys, ...spineOptions });
  const spineRead = noSpine === true ? null : new SpineReadClient(spine.baseUrl);

  const app = buildApp({
    db: stubDb,
    logLevel: 'silent',
    compare: {
      spineRead,
      resolveIdentity: () => (subject === null ? null : { sub: subject ?? SUB }),
      catalog: { spineRead, mediaBaseUrl: mediaBaseUrl ?? null, now: () => NOW },
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const transport = createConnectTransport({ baseUrl, httpVersion: '1.1' });
  return {
    catalog: createClient(CatalogService, transport),
    compare: createClient(CompareService, transport),
    spine,
    fga,
    app,
  };
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetEntitlementGrantsForTest();
  resetEntitlementSigningForTest();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  // CLIENT BEFORE SERVER: drop the OpenFGA connection before its fake goes
  // away. Closed the other way round, the fake's GOAWAY can be mid-flight when
  // the reset aborts the session, and connect-node then emits the session's
  // deferred error with no listener left (an uncaught "received GOAWAY without
  // any open streams"). Which order wins was timing luck until the spine hop
  // moved to h2c and shifted it.
  resetEntitlementGrantsForTest();
  if (harness) {
    await harness.app.close();
    await harness.spine.close();
    await harness.fga.close();
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

const gtinRef = (value: string = GTIN) => ({ ref: { case: 'gtin14' as const, value } });
const headRef = (value: string) => ({ ref: { case: 'headId' as const, value } });
const productsJson = (body: Record<string, unknown>): string => JSON.stringify(body);

// ===========================================================================
// (a) THE WIRE — gRPC over h2c for every spine call, Compare included.
// ===========================================================================
describe('(a) every spine call is gRPC over h2c', () => {
  it('Compare and GetProducts both arrive as gRPC on HTTP/2 streams', async () => {
    harness = await start();

    await harness.compare.compare({ seed: { case: 'gtin14', value: GTIN }, nowIso: NOW.toISOString() });
    await harness.catalog.getProducts({ refs: [gtinRef()] });

    expect(harness.spine.wire.map((w) => w.path)).toEqual([
      '/read.v1.SpineRead/Compare',
      '/read.v1.SpineRead/GetProducts',
    ]);
    for (const w of harness.spine.wire) {
      expect(w.httpVersion).toBe('2.0');
      expect(w.contentType).toMatch(GRPC_CONTENT_TYPE);
    }
  });
});

// ===========================================================================
// (b) THE ALLOWLIST — an image URL and an unknown key never reach a card.
// ===========================================================================
describe('(b) GetProducts maps through the display-key allowlist', () => {
  it('produces a card containing neither the image-URL claims nor the unknown key', async () => {
    harness = await start();

    const res = await harness.catalog.getProducts({ refs: [gtinRef()] });
    const wire = JSON.stringify(res.products.map((card) => toJsonString(ProductCardSchema, card)));

    // The fake's record carries all four; the card must carry none of them.
    expect(harness.spine.productCalls).toHaveLength(1);
    expect(wire).not.toContain('images.store.example');
    expect(wire).not.toContain('originals');
    expect(wire).not.toContain('SHOULD-NEVER-SHIP');
    expect(wire).not.toContain('mysteryKey');
    expect(wire).not.toContain('imageUrl');
  });

  it('maps every allowlisted field, and nothing else, onto the card', async () => {
    harness = await start();

    const res = await harness.catalog.getProducts({ refs: [gtinRef()] });

    expect(res.products).toHaveLength(1);
    const card = res.products[0]!;
    expect(card.headId).toBe(CANNED_HEAD_ID);
    expect(card.requestedAs).toEqual([expect.objectContaining({ ref: { case: 'gtin14', value: GTIN } })]);
    expect(card.title).toMatchObject({ value: 'Hatsune Miku Symphony 2025 Ver.' });
    expect(card.manufacturer).toMatchObject({ value: 'Good Smile Company' });
    expect(card.series).toMatchObject({ value: 'Character Vocal Series' });
    expect(card.character).toMatchObject({ value: 'Hatsune Miku' });
    expect(card.scale).toMatchObject({ value: '1/7' });
    expect(card.releaseYm).toMatchObject({ value: '2026-03' });
    expect(card.contentLevel).toMatchObject({ value: 'general' });
    expect(card.gtin14s).toEqual([GTIN]);
    // No derivative exists anywhere yet, and the spine's record carries none.
    expect(card.derivativeIds).toEqual([]);
  });

  it('carries as_of PER FIELD, canonicalised to UTC with six fractional digits', async () => {
    harness = await start();

    const card = (await harness.catalog.getProducts({ refs: [gtinRef()] })).products[0]!;

    expect(card.title?.asOf).toBe('2026-09-01T10:00:00.123456Z');
    expect(card.manufacturer?.asOf).toBe('2026-09-02T11:00:00.000000Z');
    // +09 in PostgreSQL's rendering is a different instant in UTC.
    expect(card.series?.asOf).toBe('2026-09-03T03:30:00.500000Z');
    expect(card.character?.asOf).toBe('2026-09-04T13:00:00.000001Z');
    expect(card.scale?.asOf).toBe('2026-09-05T14:00:00.000000Z');
    expect(card.contentLevel?.asOf).toBe('2026-09-06T15:00:00.000000Z');
    // release_ym comes from a materialized column: no claim, no claim time.
    expect(card.releaseYm?.asOf).toBe('');
  });

  it('gives a value that did NOT come from the winning claim an empty as_of', async () => {
    // The materialized column wins in the spine's display projection; the
    // claim's time would then date a value it never supplied.
    const record = cannedProductRecord([{ gtin14: GTIN }], true);
    (record['display'] as Record<string, unknown>)['name'] = 'Curated English Title';
    harness = await start({
      respondProducts: () =>
        create(WireProductsResponseSchema, {
          productsJson: productsJson({ products: [record], unresolved: [], coverage: {} }),
        }),
    });

    const card = (await harness.catalog.getProducts({ refs: [gtinRef()] })).products[0]!;
    expect(card.title?.value).toBe('Curated English Title');
    expect(card.title?.asOf).toBe('');
  });

  it('gives an R18 statue with no level claim the content level unknown, not none', async () => {
    // gkloot and solaris record adult content as attr_key r18, never contentLevel.
    const record = cannedProductRecord([{ gtin14: GTIN }], true);
    const attrs = record['attrs'] as Record<string, unknown>;
    delete attrs['contentLevel'];
    attrs['r18'] = { kind: 'text', value: 'true', site: 'gkloot', asOf: '2026-09-02 11:00:00+00' };
    harness = await start({
      respondProducts: () =>
        create(WireProductsResponseSchema, {
          productsJson: productsJson({ products: [record], unresolved: [], coverage: {} }),
        }),
    });

    const card = (await harness.catalog.getProducts({ refs: [gtinRef()] })).products[0]!;
    expect(card.title?.value).toBe('Hatsune Miku Symphony 2025 Ver.');
    expect(card.contentLevel).toMatchObject({ value: 'unknown', asOf: '2026-09-02T11:00:00.000000Z' });
    expect(harness.spine.wire).toHaveLength(1);
    expect(harness.spine.wire[0]?.contentType).toMatch(GRPC_CONTENT_TYPE);
    expect(harness.spine.wire[0]?.httpVersion).toBe('2.0');
  });
});

// ===========================================================================
// (c) THE BATCH BOUND — rejected before anything leaves the process.
// ===========================================================================
describe('(c) GetProducts validates the batch before any spine call', () => {
  it('201 refs are INVALID_ARGUMENT, and neither the spine nor OpenFGA is asked', async () => {
    harness = await start();
    const refs = Array.from({ length: 201 }, (_, i) => gtinRef(String(i).padStart(14, '0')));

    expect(await codeOf(harness.catalog.getProducts({ refs }))).toBe(Code.InvalidArgument);
    expect(harness.spine.productCalls).toHaveLength(0);
    expect(harness.spine.wire).toHaveLength(0);
    expect(harness.fga.calls).toHaveLength(0);
  });

  it('200 refs are served, in one spine call carrying all of them', async () => {
    harness = await start();
    const refs = Array.from({ length: 200 }, (_, i) => gtinRef(String(i).padStart(14, '0')));

    expect(await codeOf(harness.catalog.getProducts({ refs }))).toBe('OK');
    expect(harness.spine.productCalls[0]?.request.refs).toHaveLength(200);
  });

  it.each([
    ['no refs at all', []],
    ['a ref with no case set', [{ ref: { case: undefined } }]],
    ['a blank head_id', [headRef('  ')]],
    ['an empty gtin14', [gtinRef('')]],
    ['a source_item with no native_id', [{ ref: { case: 'sourceItem', value: { site: 'mfc', nativeId: '' } } }]],
    ['a source_item with no site', [{ ref: { case: 'sourceItem', value: { site: ' ', nativeId: '1144' } } }]],
  ])('%s is INVALID_ARGUMENT before any spine call', async (_label, refs) => {
    harness = await start();

    expect(await codeOf(harness.catalog.getProducts({ refs: refs as never }))).toBe(Code.InvalidArgument);
    expect(harness.spine.productCalls).toHaveLength(0);
  });

  it('sends every ref to the spine in its read.v1 spelling, a head_id as a product_id', async () => {
    harness = await start();

    await harness.catalog.getProducts({
      refs: [
        headRef(CANNED_HEAD_ID),
        gtinRef(),
        { ref: { case: 'sourceItem', value: { site: 'mfc', nativeId: '1144' } } },
      ],
    });

    expect(harness.spine.productCalls[0]?.request.refs.map((r) => r.ref)).toEqual([
      { case: 'productId', value: CANNED_HEAD_ID },
      { case: 'gtin14', value: GTIN },
      { case: 'sourceItem', value: expect.objectContaining({ site: 'mfc', nativeId: '1144' }) },
    ]);
  });

  it('stamps now_iso from the coordinator clock, and forwards page_size and page_token', async () => {
    harness = await start();

    await harness.catalog.getProducts({ refs: [gtinRef()], pageSize: 25, pageToken: 'tok-2' });

    const req = harness.spine.productCalls[0]?.request;
    expect(req?.nowIso).toBe(NOW.toISOString());
    expect(req?.pageSize).toBe(25);
    expect(req?.pageToken).toBe('tok-2');
  });
});

// ===========================================================================
// (d) ENTITLEMENT — the spine refuses without a verified assertion.
// ===========================================================================
describe('(d) the assertion is minted for every GetProducts call', () => {
  it('ENTITLED: the refusing spine accepts the call and the entitled fields are present', async () => {
    harness = await start({ allow: true, requireAssertion: true });

    const res = await harness.catalog.getProducts({ refs: [gtinRef()] });

    // The call got through a spine that refuses anything unverified...
    expect(harness.spine.productCalls[0]?.entitlementOutcome).toBe('granted');
    expect(harness.spine.productCalls[0]?.entitled).toBe(true);
    // ...and the fields it served are on the card — not merely "nothing errored".
    const card = res.products[0]!;
    expect(card.title?.value).toBe('Hatsune Miku Symphony 2025 Ver.');
    expect(card.manufacturer?.value).toBe('Good Smile Company');
    expect(card.character?.value).toBe('Hatsune Miku');
    expect(card.gtin14s).toEqual([GTIN]);
    // Inventory magnitude is entitlement-gated and is NOT card data (catalog.proto).
    expect(JSON.stringify(toJsonString(ProductCardSchema, card))).not.toContain('stockOnHand');
  });

  it('NO CALLER: nothing is minted and OpenFGA is never asked — a redacted read, not a rejection', async () => {
    // Rejecting is the edge's job, upstream of here. This layer has no opinion
    // about a caller it was not told about, so it spends no Check on one.
    harness = await start({ subject: null });

    const res = await harness.catalog.getProducts({ refs: [gtinRef()] });

    expect(res.products[0]?.title?.value).toBe('Hatsune Miku Symphony 2025 Ver.');
    expect(harness.fga.calls).toHaveLength(0);
    expect(harness.spine.productCalls[0]?.entitlementOutcome).toBe('absent');
  });

  it('UNENTITLED: nothing is minted, the refusing spine says no, and the client sees UNAVAILABLE', async () => {
    // The other half, which proves the refusal above is real: the same fake,
    // the same request, OpenFGA saying no.
    harness = await start({ allow: false, requireAssertion: true });

    expect(await codeOf(harness.catalog.getProducts({ refs: [gtinRef()] }))).toBe(Code.Unavailable);
    expect(harness.spine.productCalls[0]?.entitlementOutcome).toBe('absent');
  });
});

// ===========================================================================
// Paging, unresolved, redirects (plan review: WK-07 / WK-12 and WK-02 / WK-15).
// ===========================================================================
describe('GetProducts passes the spine pages through one to one', () => {
  it('four pages of 50 yield 200 cards, and the first-page-only unresolved list is not repeated', async () => {
    const PAGE = 50;
    const ids = Array.from({ length: 200 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    harness = await start({
      respondProducts: (call) => {
        const offset = call.request.pageToken === '' ? 0 : Number(call.request.pageToken);
        const page = ids.slice(offset, offset + PAGE).map((id) => ({
          ...cannedProductRecord([{ productId: id }], true),
          productId: id,
        }));
        return create(WireProductsResponseSchema, {
          productsJson: productsJson({
            products: page,
            unresolved: offset === 0 ? [{ gtin14: '00000000000000' }] : [],
            coverage: {},
          }),
          nextPageToken: offset + PAGE < ids.length ? String(offset + PAGE) : '',
        });
      },
    });
    const refs = [...ids.map((id) => headRef(id)), gtinRef('00000000000000')].slice(0, 200);

    const cards: string[] = [];
    let unresolved = 0;
    let token = '';
    let pages = 0;
    do {
      const res = await harness.catalog.getProducts({ refs, pageToken: token });
      cards.push(...res.products.map((c) => c.headId));
      unresolved += res.unresolved.length;
      token = res.nextPageToken;
      pages += 1;
    } while (token !== '' && pages < 10);

    expect(pages).toBe(4);
    expect(cards).toHaveLength(200);
    expect(new Set(cards).size).toBe(200);
    expect(unresolved).toBe(1);
    expect(harness.spine.productCalls.map((c) => c.request.pageToken)).toEqual(['', '50', '100', '150']);
  });

  it('maps unresolved refs back into the shape the client sent', async () => {
    harness = await start({
      respondProducts: () =>
        create(WireProductsResponseSchema, {
          productsJson: productsJson({
            products: [],
            unresolved: [
              { productId: CANNED_HEAD_ID },
              { gtin14: GTIN },
              { sourceItem: { site: 'mfc', nativeId: '99999999' } },
            ],
            coverage: {},
          }),
        }),
    });

    const res = await harness.catalog.getProducts({ refs: [gtinRef()] });
    expect(res.products).toEqual([]);
    expect(res.unresolved.map((r) => r.ref)).toEqual([
      { case: 'headId', value: CANNED_HEAD_ID },
      { case: 'gtin14', value: GTIN },
      { case: 'sourceItem', value: expect.objectContaining({ site: 'mfc', nativeId: '99999999' }) },
    ]);
  });

  it('a merged id still renders: the card names the survivor and echoes the merged ref', async () => {
    const LOSER = '11111111-2222-4333-8444-555555555555';
    harness = await start({
      respondProducts: () =>
        create(WireProductsResponseSchema, {
          productsJson: productsJson({
            products: [cannedProductRecord([{ productId: LOSER }], true)],
            unresolved: [],
            coverage: {},
          }),
        }),
    });

    const res = await harness.catalog.getProducts({ refs: [headRef(LOSER)] });
    expect(res.products[0]?.headId).toBe(CANNED_HEAD_ID);
    expect(res.products[0]?.requestedAs.map((r) => r.ref)).toEqual([{ case: 'headId', value: LOSER }]);
  });
});

// ===========================================================================
// Failure behaviour.
// ===========================================================================
describe('GetProducts failure behaviour', () => {
  it('answers UNAVAILABLE when no spine is configured', async () => {
    harness = await start({ noSpine: true });
    expect(await codeOf(harness.catalog.getProducts({ refs: [gtinRef()] }))).toBe(Code.Unavailable);
  });

  it('answers UNAVAILABLE when the spine fails, without relaying its message', async () => {
    harness = await start({
      respondProducts: () => {
        throw new ConnectError('connection refused at 10.42.0.7:5432', Code.Internal);
      },
    });
    const err = await harness.catalog.getProducts({ refs: [gtinRef()] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.Unavailable);
    expect((err as ConnectError).message).not.toContain('10.42.0.7');
  });

  it('relays the spine INVALID_ARGUMENT (a page_token not issued for this batch) as INVALID_ARGUMENT', async () => {
    // Mapping it to UNAVAILABLE would tell the client to retry a request that
    // can never succeed.
    harness = await start({
      respondProducts: () => {
        throw new ConnectError('page_token was issued for a different batch', Code.InvalidArgument);
      },
    });
    const err = await harness.catalog.getProducts({ refs: [gtinRef()], pageToken: 'stale' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.InvalidArgument);
    // The code is relayed; the spine's own words are not.
    expect((err as ConnectError).rawMessage).not.toContain('different batch');
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['not an object', '[]'],
    ['products missing', '{"unresolved":[]}'],
    ['a product with no productId', '{"products":[{"display":{}}],"unresolved":[]}'],
    ['unresolved not a list', '{"products":[],"unresolved":{}}'],
  ])('answers INTERNAL for a products payload that is %s', async (_label, body) => {
    harness = await start({
      respondProducts: () => create(WireProductsResponseSchema, { productsJson: body }),
    });
    expect(await codeOf(harness.catalog.getProducts({ refs: [gtinRef()] }))).toBe(Code.Internal);
  });
});

// ===========================================================================
// (e) GetProductImages — only under the configured media base.
// ===========================================================================
describe('(e) GetProductImages', () => {
  it('returns NOTHING when the media base is unset, and asks neither the spine nor OpenFGA', async () => {
    harness = await start({ mediaBaseUrl: null });

    const res = await harness.catalog.getProductImages({ headIds: [CANNED_HEAD_ID] });

    expect(res.products).toEqual([]);
    expect(res.nextPageToken).toBe('');
    expect(harness.spine.imageCalls).toHaveLength(0);
    expect(harness.spine.wire).toHaveLength(0);
    expect(harness.fga.calls).toHaveLength(0);
  });

  it('returns only the refs under the configured media base', async () => {
    harness = await start({
      mediaBaseUrl: MEDIA,
      respondImages: () =>
        create(WireImagesResponseSchema, {
          imagesJson: JSON.stringify({
            products: [
              {
                productId: CANNED_HEAD_ID,
                images: [
                  {
                    role: 'primary', position: '0', primary: true, derivativeSha256: SHA_A,
                    contentType: 'image/webp', width: '1200', height: '1600',
                    generatedAt: '2026-10-01 00:00:00+00', pipelineVersion: 'v1', url: `${MEDIA}/${SHA_A}`,
                  },
                  // An original's URL, a foreign host and a missing URL: all dropped.
                  { role: 'gallery', position: '1', primary: false, derivativeSha256: SHA_B, url: 'https://images.store.example/originals/1144.jpg' },
                  { role: 'gallery', position: '2', primary: false, derivativeSha256: SHA_B, url: `https://evil.example/d/${SHA_B}` },
                  { role: 'gallery', position: '3', primary: false, derivativeSha256: SHA_B },
                ],
              },
              {
                productId: '11111111-2222-4333-8444-555555555555',
                images: [{ role: 'gallery', primary: false, derivativeSha256: SHA_B, url: 'https://images.store.example/x.jpg' }],
              },
            ],
            coverage: {},
          }),
          nextPageToken: 'img-next',
        }),
    });

    const res = await harness.catalog.getProductImages({ headIds: [CANNED_HEAD_ID], pageSize: 10, pageToken: 'img-1' });

    expect(res.products).toHaveLength(1);
    expect(res.products[0]?.headId).toBe(CANNED_HEAD_ID);
    expect(res.products[0]?.images).toEqual([
      expect.objectContaining({
        derivativeId: SHA_A, role: 'primary', primary: true, contentType: 'image/webp',
        width: 1200, height: 1600, url: `${MEDIA}/${SHA_A}`,
      }),
    ]);
    expect(res.nextPageToken).toBe('img-next');
    const call = harness.spine.imageCalls[0];
    expect(call?.request.productIds).toEqual([CANNED_HEAD_ID]);
    expect(call?.request.nowIso).toBe(NOW.toISOString());
    expect(call?.request.pageSize).toBe(10);
    expect(call?.request.pageToken).toBe('img-1');
    // Minted like every other spine call, and carried as gRPC.
    expect(call?.entitlementOutcome).toBe('granted');
    expect(harness.spine.wire[0]?.contentType).toMatch(GRPC_CONTENT_TYPE);
  });

  it.each([
    ['no head ids', []],
    ['201 head ids', Array.from({ length: 201 }, (_, i) => `id-${i}`)],
    ['a blank head id', [' ']],
  ])('%s is INVALID_ARGUMENT before any spine call', async (_label, headIds) => {
    harness = await start({ mediaBaseUrl: MEDIA });
    expect(await codeOf(harness.catalog.getProductImages({ headIds }))).toBe(Code.InvalidArgument);
    expect(harness.spine.imageCalls).toHaveLength(0);
  });

  it.each([
    ['no head ids', []],
    ['201 head ids', Array.from({ length: 201 }, (_, i) => `id-${i}`)],
    ['a blank head id', [' ']],
  ])('%s is INVALID_ARGUMENT even while images are off, never a quiet empty OK', async (_label, headIds) => {
    // The batch is the client's bug whatever the server's configuration; an OK
    // here would hide it until the day images are switched on.
    harness = await start({ mediaBaseUrl: null });
    expect(await codeOf(harness.catalog.getProductImages({ headIds }))).toBe(Code.InvalidArgument);
    expect(harness.spine.wire).toHaveLength(0);
  });

  it('answers UNAVAILABLE when the base is set but no spine is configured', async () => {
    harness = await start({ mediaBaseUrl: MEDIA, noSpine: true });
    expect(await codeOf(harness.catalog.getProductImages({ headIds: [CANNED_HEAD_ID] }))).toBe(Code.Unavailable);
  });

  it('answers UNAVAILABLE when the spine fails', async () => {
    harness = await start({
      mediaBaseUrl: MEDIA,
      respondImages: () => {
        throw new ConnectError('boom', Code.Unavailable);
      },
    });
    expect(await codeOf(harness.catalog.getProductImages({ headIds: [CANNED_HEAD_ID] }))).toBe(Code.Unavailable);
  });

  it('answers INTERNAL for an images payload it cannot read', async () => {
    harness = await start({
      mediaBaseUrl: MEDIA,
      respondImages: () => create(WireImagesResponseSchema, { imagesJson: '{"products":"nope"}' }),
    });
    expect(await codeOf(harness.catalog.getProductImages({ headIds: [CANNED_HEAD_ID] }))).toBe(Code.Internal);
  });
});

// ===========================================================================
// (f) SearchProducts — a pass-through over read.v1 SpineRead.SearchProducts (WK-17).
// ===========================================================================
const ERROR_INFO = 'google.rpc.ErrorInfo';
const STALE = 'TOKEN_EXPIRED_OR_REBASED';
const DOMAIN = 'figurecollecting.com';

/** google.rpc.ErrorInfo { reason = 1; domain = 2; map<string,string> metadata = 3 }, as the spine writes it. */
const errorInfoBytes = (reason: string, domain: string, metadata: Record<string, string> = {}): Uint8Array => {
  const w = new BinaryWriter();
  // Metadata FIRST, so a reader that cannot skip a field it does not want fails here.
  for (const [k, v] of Object.entries(metadata)) {
    w.tag(3, WireType.LengthDelimited).fork().tag(1, WireType.LengthDelimited).string(k);
    w.tag(2, WireType.LengthDelimited).string(v).join();
  }
  return w.tag(1, WireType.LengthDelimited).string(reason).tag(2, WireType.LengthDelimited).string(domain).finish();
};

/** The ErrorInfo details a client received, decoded field by field. */
const errorInfosOf = (err: ConnectError): { reason: string; domain: string }[] =>
  err.details.flatMap((d) => {
    if (!('type' in d) || d.type !== ERROR_INFO) return [];
    const r = new BinaryReader(d.value);
    const info = { reason: '', domain: '' };
    while (r.pos < r.len) {
      const [field, wt] = r.tag();
      if (field === 1) info.reason = r.string();
      else if (field === 2) info.domain = r.string();
      else r.skip(wt);
    }
    return [info];
  });

const spineRefusal = (details: { type: string; value: Uint8Array }[], code = Code.InvalidArgument): never => {
  const err = new ConnectError('page_token rebased under ranking v2 at 10.42.0.7', code);
  err.details.push(...details);
  throw err;
};

const searchError = async (p: Promise<unknown>): Promise<ConnectError> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConnectError);
  return err as ConnectError;
};

const hit = (id: string): Record<string, unknown> => ({ ...cannedProductRecord([], true), productId: id });
const hitId = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const searchJson = (products: unknown[]): string => JSON.stringify({ products, coverage: {} });

describe('(f) SearchProducts — the wire', () => {
  it('is mounted, no longer UNIMPLEMENTED, and reaches the spine as gRPC on an HTTP/2 stream', async () => {
    harness = await start();

    expect(harness.app.hasRoute({ method: 'POST', url: '/coordinator.v1.CatalogService/SearchProducts' })).toBe(true);
    expect(await codeOf(harness.catalog.searchProducts({ query: 'nendoroid miku' }))).toBe('OK');

    expect(harness.spine.wire.map((w) => w.path)).toEqual(['/read.v1.SpineRead/SearchProducts']);
    expect(harness.spine.wire[0]?.httpVersion).toBe('2.0');
    expect(harness.spine.wire[0]?.contentType).toMatch(GRPC_CONTENT_TYPE);
    expect(harness.spine.searchCalls).toHaveLength(1);
  });
});

describe('(f) SearchProducts — field mapping', () => {
  it('forwards the query AS TYPED, the coordinator clock, page_size and page_token, and no filter', async () => {
    harness = await start();
    const typed = '  ｎｅｎｄｏｒｏｉｄ　ミク ';

    await harness.catalog.searchProducts({ query: typed, pageSize: 20, pageToken: 'search-tok-2' });

    const req = harness.spine.searchCalls[0]?.request;
    // The spine normalizes, binds the token to and matches ITS form; sending ours would make two forms.
    expect(req?.query).toBe(typed);
    expect(req?.nowIso).toBe(NOW.toISOString());
    expect(req?.pageSize).toBe(20);
    expect(req?.pageToken).toBe('search-tok-2');
    // catalog.proto 0.3.0 has no filter fields: ABSENT, never present-but-empty (which the spine refuses).
    expect(req?.manufacturer).toBeUndefined();
    expect(req?.releaseYm).toBeUndefined();
  });

  it('maps every hit through the card allowlist: no image URL, no unknown key, no gated key', async () => {
    harness = await start({
      respondSearch: () =>
        create(WireSearchResponseSchema, { productsJson: searchJson([hit(CANNED_HEAD_ID)]), nextPageToken: 'next-1' }),
    });

    const res = await harness.catalog.searchProducts({ query: 'miku' });

    expect(res.nextPageToken).toBe('next-1');
    expect(res.products).toHaveLength(1);
    const card = res.products[0]!;
    expect(card.headId).toBe(CANNED_HEAD_ID);
    expect(card.title).toMatchObject({ value: 'Hatsune Miku Symphony 2025 Ver.', asOf: '2026-09-01T10:00:00.123456Z' });
    expect(card.manufacturer).toMatchObject({ value: 'Good Smile Company' });
    expect(card.series).toMatchObject({ value: 'Character Vocal Series' });
    expect(card.character).toMatchObject({ value: 'Hatsune Miku' });
    expect(card.scale).toMatchObject({ value: '1/7' });
    expect(card.releaseYm).toMatchObject({ value: '2026-03', asOf: '' });
    expect(card.contentLevel).toMatchObject({ value: 'general' });
    expect(card.gtin14s).toEqual([GTIN]);
    expect(card.derivativeIds).toEqual([]);
    const wire = toJsonString(ProductCardSchema, card);
    for (const leak of ['images.store.example', 'originals', 'SHOULD-NEVER-SHIP', 'mysteryKey', 'imageUrl', 'stockOnHand']) {
      expect(wire).not.toContain(leak);
    }
  });

  it('gives a hit an EMPTY requested_as, even when the spine echoes a ref: this request named none', async () => {
    harness = await start({
      respondSearch: () =>
        create(WireSearchResponseSchema, {
          productsJson: searchJson([cannedProductRecord([{ productId: hitId(9) }, { gtin14: GTIN }], true)]),
        }),
    });

    const res = await harness.catalog.searchProducts({ query: 'miku' });
    expect(res.products[0]?.headId).toBe(CANNED_HEAD_ID);
    expect(res.products[0]?.requestedAs).toEqual([]);
  });

  it('answers no hits as OK with an empty list and no token', async () => {
    harness = await start({
      respondSearch: () => create(WireSearchResponseSchema, { productsJson: searchJson([]) }),
    });

    const res = await harness.catalog.searchProducts({ query: 'no such figure' });
    expect(res.products).toEqual([]);
    expect(res.nextPageToken).toBe('');
  });

  it('passes keyset pages through one to one, in the spine order, following its tokens', async () => {
    const ids = Array.from({ length: 7 }, (_, i) => hitId(i));
    harness = await start({
      respondSearch: (call) => {
        const from = call.request.pageToken === '' ? 0 : Number(call.request.pageToken.slice('after-'.length));
        const page = ids.slice(from, from + 3);
        return create(WireSearchResponseSchema, {
          productsJson: searchJson(page.map(hit)),
          nextPageToken: from + 3 < ids.length ? `after-${from + 3}` : '',
        });
      },
    });

    const seen: string[] = [];
    let token = '';
    let pages = 0;
    do {
      const res = await harness.catalog.searchProducts({ query: 'miku', pageSize: 3, pageToken: token });
      seen.push(...res.products.map((c) => c.headId));
      token = res.nextPageToken;
      pages += 1;
    } while (token !== '' && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(ids);
    expect(harness.spine.searchCalls.map((c) => c.request.pageToken)).toEqual(['', 'after-3', 'after-6']);
    expect(harness.spine.searchCalls.every((c) => c.request.query === 'miku' && c.request.pageSize === 3)).toBe(true);
  });
});

describe('(f) SearchProducts — the page cap of 50', () => {
  it.each([
    [0, 0],
    [1, 1],
    [49, 49],
    [50, 50],
    [51, 50],
    [500, 50],
    [4_294_967_295, 50],
  ])('page_size %i reaches the spine as %i', async (asked, sent) => {
    harness = await start();
    await harness.catalog.searchProducts({ query: 'miku', pageSize: asked });
    expect(harness.spine.searchCalls[0]?.request.pageSize).toBe(sent);
  });

  it('serves a spine page of exactly 50 hits', async () => {
    harness = await start({
      respondSearch: () =>
        create(WireSearchResponseSchema, { productsJson: searchJson(Array.from({ length: 50 }, (_, i) => hit(hitId(i)))) }),
    });
    const res = await harness.catalog.searchProducts({ query: 'miku', pageSize: 50 });
    expect(res.products).toHaveLength(50);
  });

  it('answers INTERNAL for a spine page of 51 hits, never a truncated page that would desync the keyset', async () => {
    harness = await start({
      respondSearch: () =>
        create(WireSearchResponseSchema, { productsJson: searchJson(Array.from({ length: 51 }, (_, i) => hit(hitId(i)))) }),
    });
    expect(await codeOf(harness.catalog.searchProducts({ query: 'miku', pageSize: 50 }))).toBe(Code.Internal);
  });
});

describe('(f) SearchProducts — the query, validated before anything leaves the process', () => {
  it.each([
    ['empty', ''],
    ['ASCII spaces only', '   '],
    ['Unicode White_Space only (ideographic space, NEL, tab, newline)', '　\u0085\t\n'],
  ])('a query that is %s is INVALID_ARGUMENT, and neither the spine nor OpenFGA is asked', async (_label, query) => {
    harness = await start();
    expect(await codeOf(harness.catalog.searchProducts({ query }))).toBe(Code.InvalidArgument);
    expect(harness.spine.wire).toHaveLength(0);
    expect(harness.fga.calls).toHaveLength(0);
  });

  // The bound is 256 code points COUNTED IN THE NFKC-NORMALIZED, TRIMMED FORM (read.proto 0.9.0).
  it.each([
    ['256 ASCII letters', 'a'.repeat(256)],
    ['256 astral code points (512 UTF-16 units)', '\u{20BB7}'.repeat(256)],
    ['512 code points that NFKC composes to 256 (half-width ｶﾞ -> ガ)', 'ｶﾞ'.repeat(256)],
    ['64 ㍿ that NFKC expands to exactly 256', '㍿'.repeat(64)],
    ['256 letters wrapped in Unicode White_Space JS trim misses (NEL)', `\u0085${'a'.repeat(256)}　`],
  ])('accepts %s and sends it as typed', async (_label, query) => {
    harness = await start();
    expect(await codeOf(harness.catalog.searchProducts({ query }))).toBe('OK');
    expect(harness.spine.searchCalls[0]?.request.query).toBe(query);
  });

  it.each([
    ['257 ASCII letters', 'a'.repeat(257)],
    ['257 astral code points', '\u{20BB7}'.repeat(257)],
    ['514 code points that NFKC composes to 257', 'ｶﾞ'.repeat(257)],
    ['65 ㍿ that NFKC expands to 260', '㍿'.repeat(65)],
    ['256 letters and a BOM, which is not White_Space', `${'a'.repeat(256)}﻿`],
  ])('refuses %s as INVALID_ARGUMENT before any spine call', async (_label, query) => {
    harness = await start();
    expect(await codeOf(harness.catalog.searchProducts({ query }))).toBe(Code.InvalidArgument);
    expect(harness.spine.wire).toHaveLength(0);
  });

  // The trim must cost time linear in the query: a regex anchored at both ends
  // backtracks quadratically over an INTERIOR run of White_Space, and the 256
  // bound is only checked after the trim, on the one event loop every service
  // shares. 200 000 spaces took ~11 s that way; a linear trim takes milliseconds.
  it.each([
    ['ASCII spaces', ' '],
    ['ideographic spaces', '\u3000'],
  ])('refuses a query with an interior run of 200 000 %s within 1 s, before any spine call', async (_label, ws) => {
    harness = await start();
    const query = `a${ws.repeat(200_000)}a`;

    const started = performance.now();
    const err = await searchError(harness.catalog.searchProducts({ query }));
    const elapsedMs = performance.now() - started;

    expect(err.code).toBe(Code.InvalidArgument);
    expect(err.rawMessage).toBe('query must not exceed 256 characters');
    expect(elapsedMs).toBeLessThan(1000);
    expect(harness.spine.wire).toHaveLength(0);
  });

  it('accepts 256 letters inside 200 000 White_Space on each side, and sends it as typed', async () => {
    harness = await start();
    const pad = ' \u3000\u0085\t'.repeat(50_000);
    const query = `${pad}${'a'.repeat(128)} ${'b'.repeat(127)}${pad}`;

    const started = performance.now();
    expect(await codeOf(harness.catalog.searchProducts({ query }))).toBe('OK');
    expect(performance.now() - started).toBeLessThan(1000);
    expect(harness.spine.searchCalls[0]?.request.query).toBe(query);
  });
});

describe('(f) SearchProducts — the entitlement assertion travels as it does for GetProducts', () => {
  it('ENTITLED: the refusing spine accepts the call and the hit fields are present', async () => {
    harness = await start({ allow: true, requireAssertion: true });

    const res = await harness.catalog.searchProducts({ query: 'miku' });

    expect(harness.spine.searchCalls[0]?.entitlementOutcome).toBe('granted');
    expect(harness.spine.searchCalls[0]?.entitled).toBe(true);
    expect(harness.spine.searchCalls[0]?.headers.get('fc-entitlements')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(JSON.stringify(harness.spine.searchCalls[0]?.request)).not.toContain('fc-entitlements');
    expect(res.products[0]?.title?.value).toBe('Hatsune Miku Symphony 2025 Ver.');
    expect(res.products[0]?.character?.value).toBe('Hatsune Miku');
    expect(harness.fga.calls).toHaveLength(1);
  });

  it('NO CALLER: nothing is minted and OpenFGA is never asked: the same hits, redacted', async () => {
    harness = await start({ subject: null });

    const res = await harness.catalog.searchProducts({ query: 'miku' });

    expect(res.products[0]?.title?.value).toBe('Hatsune Miku Symphony 2025 Ver.');
    expect(harness.fga.calls).toHaveLength(0);
    expect(harness.spine.searchCalls[0]?.entitlementOutcome).toBe('absent');
    expect(harness.spine.searchCalls[0]?.headers.get('fc-entitlements')).toBeNull();
  });

  it('UNENTITLED: nothing is minted, the refusing spine says no, and the client sees UNAVAILABLE', async () => {
    harness = await start({ allow: false, requireAssertion: true });

    expect(await codeOf(harness.catalog.searchProducts({ query: 'miku' }))).toBe(Code.Unavailable);
    expect(harness.spine.searchCalls[0]?.entitlementOutcome).toBe('absent');
  });

  it('never widens redaction: an unentitled caller is served the redacted page as the spine cut it', async () => {
    harness = await start({ allow: false });

    const res = await harness.catalog.searchProducts({ query: 'miku' });

    expect(harness.spine.searchCalls).toHaveLength(1);
    expect(harness.spine.searchCalls[0]?.entitled).toBe(false);
    // One spine call, no second read to "fill in" what was withheld, and no gated value on the card.
    expect(harness.spine.wire).toHaveLength(1);
    expect(toJsonString(ProductCardSchema, res.products[0]!)).not.toContain('stockOnHand');
  });
});

describe('(f) SearchProducts — the stale-token refusal, in the catalog contract shape', () => {
  it('relays TOKEN_EXPIRED_OR_REBASED @ figurecollecting.com as INVALID_ARGUMENT carrying the same ErrorInfo', async () => {
    harness = await start({
      respondSearch: () =>
        spineRefusal([{ type: ERROR_INFO, value: errorInfoBytes(STALE, DOMAIN, { ranking: 'v2' }) }]),
    });

    const err = await searchError(harness.catalog.searchProducts({ query: 'miku', pageToken: 'old-tok' }));

    expect(err.code).toBe(Code.InvalidArgument);
    expect(errorInfosOf(err)).toEqual([{ reason: STALE, domain: DOMAIN }]);
    // Built fresh: reason and domain only, none of the spine's metadata.
    const detail = err.details.find((d) => 'type' in d && d.type === ERROR_INFO) as { value: Uint8Array };
    expect(detail.value).toEqual(errorInfoBytes(STALE, DOMAIN));
    expect(err.rawMessage).toMatch(/restart the search from page one/);
    expect(err.rawMessage).not.toContain('10.42.0.7');
    expect(err.rawMessage).not.toContain('ranking v2');
  });

  it.each([
    ['no details at all', []],
    ['a lower-case reason', [{ type: ERROR_INFO, value: errorInfoBytes(STALE.toLowerCase(), DOMAIN) }]],
    ['another domain', [{ type: ERROR_INFO, value: errorInfoBytes(STALE, 'spine.figurecollecting.com') }]],
    ['another reason', [{ type: ERROR_INFO, value: errorInfoBytes('QUERY_MISMATCH', DOMAIN) }]],
    ['the stale bytes under another detail type', [{ type: 'google.rpc.BadRequest', value: errorInfoBytes(STALE, DOMAIN) }]],
    ['ErrorInfo bytes that cannot be decoded', [{ type: ERROR_INFO, value: new Uint8Array([0x0a, 0x7f, 0x41]) }]],
  ])('any other INVALID_ARGUMENT (%s) stays INVALID_ARGUMENT, with no ErrorInfo and no spine words', async (_l, details) => {
    harness = await start({ respondSearch: () => spineRefusal(details) });

    const err = await searchError(harness.catalog.searchProducts({ query: 'miku', pageToken: 'other-query-tok' }));

    expect(err.code).toBe(Code.InvalidArgument);
    expect(errorInfosOf(err)).toEqual([]);
    expect(err.details).toEqual([]);
    expect(err.rawMessage).toBe('the spine refused the search request');
    expect(err.rawMessage).not.toContain('10.42.0.7');
  });

  it('a non-stale INVALID_ARGUMENT on page one (no page_token) says nothing about a page_token', async () => {
    harness = await start({
      respondSearch: () => {
        throw new ConnectError('now_iso must be ISO-8601 (10.42.0.7)', Code.InvalidArgument);
      },
    });

    const err = await searchError(harness.catalog.searchProducts({ query: 'miku' }));

    expect(harness.spine.searchCalls[0]?.request.pageToken).toBe('');
    expect(err.code).toBe(Code.InvalidArgument);
    expect(err.details).toEqual([]);
    expect(err.rawMessage).toBe('the spine refused the search request');
  });

  it('a stale ErrorInfo on any code but INVALID_ARGUMENT is UNAVAILABLE, not a restart', async () => {
    harness = await start({
      respondSearch: () => spineRefusal([{ type: ERROR_INFO, value: errorInfoBytes(STALE, DOMAIN) }], Code.Internal),
    });

    const err = await searchError(harness.catalog.searchProducts({ query: 'miku', pageToken: 'tok' }));
    expect(err.code).toBe(Code.Unavailable);
    expect(errorInfosOf(err)).toEqual([]);
  });
});

describe('(f) SearchProducts — failure behaviour', () => {
  it('answers UNAVAILABLE when no spine is configured', async () => {
    harness = await start({ noSpine: true });
    expect(await codeOf(harness.catalog.searchProducts({ query: 'miku' }))).toBe(Code.Unavailable);
  });

  it('answers UNAVAILABLE when the spine fails, without relaying its message', async () => {
    harness = await start({
      respondSearch: () => {
        throw new ConnectError('connection refused at 10.42.0.7:5432', Code.Internal);
      },
    });
    const err = await searchError(harness.catalog.searchProducts({ query: 'miku' }));
    expect(err.code).toBe(Code.Unavailable);
    expect(err.message).not.toContain('10.42.0.7');
  });

  it.each([
    ['not JSON', 'not json at all'],
    ['not an object', '[]'],
    ['products missing', '{"coverage":{}}'],
    ['products not a list', '{"products":{},"coverage":{}}'],
    ['a hit with no productId', '{"products":[{"display":{}}],"coverage":{}}'],
  ])('answers INTERNAL for a search payload that is %s', async (_label, body) => {
    harness = await start({
      respondSearch: () => create(WireSearchResponseSchema, { productsJson: body }),
    });
    const err = await searchError(harness.catalog.searchProducts({ query: 'miku' }));
    expect(err.code).toBe(Code.Internal);
    expect(err.rawMessage).toBe('spine returned a search payload that could not be read');
  });
});
