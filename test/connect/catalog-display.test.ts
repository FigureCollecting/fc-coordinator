// ADDR-1: the image-list CHOKEPOINT (catalog.proto DISPLAY RESTRICTIONS). GetProductImages evaluates
// every row for the caller's viewer context (owner: every CatalogService call) before a page is cut:
//   (a) a withheld image is absent, its product absent when nothing is left, the restriction never named;
//   (b) a withheld primary is replaced by the first image shown, on whatever page it falls;
//   (c) withheld rows are dropped BEFORE the page is cut: the coordinator reads further spine pages
//       to fill one, and resumes mid-page from its own token, within a bounded number of spine reads;
//   (d) a denial is logged with its rules at info; an evaluation that withholds nothing at debug;
//   (e) the coordinator fails closed: no restriction set, no image (UNAVAILABLE); unknown sources
//       count as every source;
//   (f) the contract's golden lists (golden/display-vectors.json) read through THIS chokepoint, in
//       each list's viewer context, at page sizes 0 (the default), 1 and 2;
//   (g) the spine's mask, grounding and appearance reach the caller as the decision says: a mask only
//       when it is not withheld and is served at exactly <base>/<mask id>, the grounding and the
//       appearance computed without it otherwise;
//   (h) MASK-G: a store's revocation (test/fixtures/mask-store-golden.json) through THIS chokepoint.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import { GetProductImagesResponseSchema as WireImagesResponseSchema } from '@figurecollecting/ingest-contract/read';
import { CatalogService } from '@figurecollecting/fc-api-contract';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { MAX_SPINE_IMAGE_READS } from '../../src/connect/catalog.js';
import type { DisplayRestriction, ViewerContext } from '../../src/display/restrictions.js';
import type { DisplayRestrictionSource } from '../../src/display/source.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import { resetEntitlementGrantsForTest, resetEntitlementSigningForTest } from '../../src/entitlements/index.js';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { generateTestSigningKey } from '../helpers/entitlementVerifier.js';
import { startFakeSpineRead, type FakeSpineRead, type FakeSpineReadOptions } from '../helpers/fakeSpineRead.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';

const KID = 'ent-test';
const SUB = 'user-1';
const NOW = new Date('2026-10-11T12:00:00.000Z');
const MEDIA = 'https://images.figurecollecting.test/d';
const H1 = '11111111-1111-4111-8111-111111111111';
const H2 = '22222222-2222-4222-8222-222222222222';
const MERGED = '99999999-9999-4999-8999-999999999999';
const sha = (c: string): string => c.repeat(64);
const ENV_KEYS = ['OPENFGA_GRPC_URL', 'OPENFGA_STORE_ID', 'OPENFGA_API_TOKEN', 'ENTITLEMENT_SIGNING_KEY_PEM', 'ENTITLEMENT_SIGNING_KID'] as const;
const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

interface Row {
  role: string;
  primary: boolean;
  derivativeSha256: string;
  url?: string;
  sources?: unknown;
  [extra: string]: unknown;
}
const row = (c: string, extra: Partial<Row> = {}): Row => ({ role: 'gallery', primary: false, derivativeSha256: sha(c), url: `${MEDIA}/${sha(c)}`, ...extra });
const page = (products: { productId: string; images: Row[] }[], nextPageToken = '') =>
  create(WireImagesResponseSchema, { imagesJson: JSON.stringify({ products, coverage: {} }), nextPageToken });

const sourceOf = (restrictions: DisplayRestriction[], aliases: Record<string, string[]> = {}): DisplayRestrictionSource & { calls: number } => {
  const s = {
    calls: 0,
    current: async () => {
      s.calls += 1;
      return { restrictions, productIdsFor: (h: string) => [h, ...(aliases[h] ?? [])] };
    },
  };
  return s;
};
const r = (rule: string, level: string, subject: string, scope: string): DisplayRestriction => ({ rule, level, subject, scope });

interface Harness {
  catalog: Client<typeof CatalogService>;
  spine: FakeSpineRead;
  fga: FakeOpenFga;
  app: FastifyInstance;
  lines: Record<string, unknown>[];
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

async function start(
  options: Omit<FakeSpineReadOptions, 'keys'> & { restrictions?: DisplayRestrictionSource; mediaBaseUrl?: string | null; viewerContext?: ViewerContext } = {},
): Promise<Harness> {
  const kp = generateTestSigningKey(KID);
  process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
  process.env['ENTITLEMENT_SIGNING_KID'] = KID;
  const fga = await startFakeOpenFga(() => true);
  process.env['OPENFGA_GRPC_URL'] = fga.baseUrl;
  process.env['OPENFGA_STORE_ID'] = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
  process.env['OPENFGA_API_TOKEN'] = 'test-preshared-key-never-logged';
  const { restrictions, mediaBaseUrl, viewerContext, ...spineOptions } = options;
  const spine = await startFakeSpineRead({ keys: kp.keys, ...spineOptions });
  const spineRead = new SpineReadClient(spine.baseUrl);
  const lines: Record<string, unknown>[] = [];
  const app = buildApp({
    db: stubDb,
    logLevel: 'debug',
    logSink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    compare: {
      spineRead,
      resolveIdentity: () => ({ sub: SUB }),
      catalog: {
        spineRead,
        mediaBaseUrl: mediaBaseUrl === undefined ? MEDIA : mediaBaseUrl,
        now: () => NOW,
        ...(restrictions !== undefined ? { restrictions } : {}),
        ...(viewerContext !== undefined ? { viewerContext } : {}),
      },
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { catalog: createClient(CatalogService, createConnectTransport({ baseUrl, httpVersion: '1.1' })), spine, fga, app, lines };
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
const shown = (res: { products: { headId: string; images: { derivativeId: string; primary: boolean; role: string }[] }[] }) =>
  res.products.map((p) => ({ head: p.headId, images: p.images.map((i) => `${i.derivativeId[0]}${i.primary ? '*' : ''}:${i.role}`) }));
const denials = (lines: Record<string, unknown>[]) => lines.filter((l) => l['msg'] === 'display restriction withheld');

describe('(a) a withheld image is absent and never named', () => {
  it('drops an image a no_display restriction names, keeps the primary, and says nothing of the rule', async () => {
    harness = await start({
      restrictions: sourceOf([r('takedown-7', 'image', sha('b').toUpperCase(), 'no_display')]),
      respondImages: () => page([{ productId: H1, images: [row('a', { primary: true }), row('b'), row('c')] }]),
    });
    const res = await harness.catalog.getProductImages({ headIds: [H1] });
    expect(shown(res)).toEqual([{ head: H1, images: ['a*:gallery', 'c:gallery'] }]);
    expect(JSON.stringify(res)).not.toMatch(/takedown|restrict|withheld/i);
  });

  it('leaves out a product whose every image is withheld, and keeps the others', async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'product', H1, 'no_display')]),
      respondImages: () => page([
        { productId: H1, images: [row('a', { primary: true }), row('b')] },
        { productId: H2, images: [row('c', { primary: true })] },
      ]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1, H2] }))).toEqual([{ head: H2, images: ['c*:gallery'] }]);
  });

  it('keeps two products on one page as two products, each image under its own head', async () => {
    // The mobile asks for 200 heads a call, so a page of several products is the usual case.
    harness = await start({
      restrictions: sourceOf([r('r1', 'image', sha('b'), 'no_display')]),
      respondImages: () => page([
        { productId: H1, images: [row('a', { primary: true }), row('b')] },
        { productId: H2, images: [row('c', { primary: true }), row('d')] },
      ]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1, H2] }))).toEqual([
      { head: H1, images: ['a*:gallery'] },
      { head: H2, images: ['c*:gallery', 'd:gallery'] },
    ]);
  });

  it('evaluates every call as the owner: owner_views_only and no_share withhold nothing here', async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'product', H1, 'owner_views_only'), r('r2', 'source', 'amiami', 'no_share')]),
      respondImages: () => page([{ productId: H1, images: [row('a', { primary: true, sources: ['amiami'] })] }]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1] }))).toEqual([{ head: H1, images: ['a*:gallery'] }]);
    expect(denials(harness.lines)).toEqual([]);
  });

  it('covers the survivor\'s images through a restriction on a merged product id', async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'product', MERGED, 'no_display')], { [H1]: [MERGED] }),
      respondImages: () => page([
        { productId: H1, images: [row('a', { primary: true })] },
        { productId: H2, images: [row('c', { primary: true })] },
      ]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1, H2] }))).toEqual([{ head: H2, images: ['c*:gallery'] }]);
  });

  it('applies a source restriction only to rows from that source when the spine sends sources', async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'source', 'HLJ', 'no_display')]),
      respondImages: () => page([{ productId: H1, images: [row('a', { primary: true, sources: ['amiami'] }), row('b', { sources: ['amiami', 'hlj'] }), row('c', { sources: ['amiami'] })] }]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1] }))).toEqual([{ head: H1, images: ['a*:gallery', 'c:gallery'] }]);
  });

  it('treats a row without sources, or with sources it cannot read, as captured from every source (fail closed)', async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'source', 'hlj', 'no_display')]),
      respondImages: () => page([
        { productId: H1, images: [row('a', { primary: true }), row('b', { sources: 'hlj' }), row('c', { sources: ['amiami', 7] }), row('e', { sources: [] })] },
        { productId: H2, images: [row('d', { primary: true, sources: ['amiami'] })] },
      ]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1, H2] }))).toEqual([{ head: H2, images: ['d*:gallery'] }]);
    expect(denials(harness.lines).map((l) => l['sources_known'])).toEqual([false, false, false, false]);
  });
});

describe('(b) a withheld primary is replaced by the first image shown', () => {
  it('sends the first gallery image as the primary, its own role kept', async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'image', sha('a'), 'no_display')]),
      respondImages: () => page([{ productId: H1, images: [row('a', { primary: true, role: 'gallery' }), row('b', { role: 'other' }), row('c')] }]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1] }))).toEqual([{ head: H1, images: ['b*:other', 'c:gallery'] }]);
  });

  it('replaces a primary that is not under the media base the same way', async () => {
    harness = await start({
      restrictions: sourceOf([]),
      respondImages: () => page([{ productId: H1, images: [row('a', { primary: true, url: 'https://images.store.example/a.jpg' }), row('b')] }]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1] }))).toEqual([{ head: H1, images: ['b*:gallery'] }]);
  });

  it('promotes nothing in a list the spine sent with no primary', async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'image', sha('a'), 'no_display')]),
      respondImages: () => page([{ productId: H1, images: [row('a'), row('b')] }]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1] }))).toEqual([{ head: H1, images: ['b:gallery'] }]);
  });

  it('carries the debt to the next page: the first image of that product there is the primary', async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'image', sha('a'), 'no_display')]),
      respondImages: () => page([
        { productId: H1, images: [row('a', { primary: true })] },
        { productId: H2, images: [row('c', { primary: true })] },
        { productId: H1, images: [row('b')] },
      ]),
    });
    const first = await harness.catalog.getProductImages({ headIds: [H1, H2], pageSize: 1 });
    expect(shown(first)).toEqual([{ head: H2, images: ['c*:gallery'] }]);
    expect(first.nextPageToken).not.toBe('');
    const second = await harness.catalog.getProductImages({ headIds: [H1, H2], pageSize: 1, pageToken: first.nextPageToken });
    expect(shown(second)).toEqual([{ head: H1, images: ['b*:gallery'] }]);
    expect(second.nextPageToken).toBe('');
    // Resumed from the same spine page, mid-page: the spine was asked for it again, not for a later one.
    expect(harness.spine.imageCalls.map((c) => c.request.pageToken)).toEqual(['', '']);
  });
});

describe('(b2) the debt survives a spine page boundary', () => {
  it('owes the primary across the spine\'s own token: the next spine page\'s first image of that product is the primary', async () => {
    const pages: Record<string, ReturnType<typeof page>> = {
      '': page([{ productId: H1, images: [row('a', { primary: true })] }, { productId: H2, images: [row('c', { primary: true })] }], 's2'),
      s2: page([{ productId: H1, images: [row('b')] }], ''),
    };
    harness = await start({
      restrictions: sourceOf([r('r1', 'image', sha('a'), 'no_display')]),
      respondImages: (call) => pages[call.request.pageToken]!,
    });
    const first = await harness.catalog.getProductImages({ headIds: [H1, H2], pageSize: 1 });
    expect(shown(first)).toEqual([{ head: H2, images: ['c*:gallery'] }]);
    expect(first.nextPageToken).toMatch(/^c1\./);
    const second = await harness.catalog.getProductImages({ headIds: [H1, H2], pageSize: 1, pageToken: first.nextPageToken });
    expect(shown(second)).toEqual([{ head: H1, images: ['b*:gallery'] }]);
    expect(harness.spine.imageCalls.map((c) => c.request.pageToken)).toEqual(['', 's2']);
  });
});

describe('(c) withheld rows are dropped before the page is cut', () => {
  it('reads the next spine page to fill a page, and resumes mid-page from its own token', async () => {
    const pages: Record<string, ReturnType<typeof page>> = {
      '': page([{ productId: H1, images: [row('a', { primary: true }), row('b')] }], 's2'),
      s2: page([{ productId: H1, images: [row('c'), row('d')] }], 's3'),
      s3: page([{ productId: H1, images: [row('e')] }], ''),
    };
    harness = await start({
      restrictions: sourceOf([r('r1', 'image', sha('b'), 'no_display')]),
      respondImages: (call) => pages[call.request.pageToken]!,
    });
    const one = await harness.catalog.getProductImages({ headIds: [H1], pageSize: 2 });
    expect(shown(one)).toEqual([{ head: H1, images: ['a*:gallery', 'c:gallery'] }]);
    expect(one.nextPageToken).toMatch(/^c1\./);
    const two = await harness.catalog.getProductImages({ headIds: [H1], pageSize: 2, pageToken: one.nextPageToken });
    expect(shown(two)).toEqual([{ head: H1, images: ['d:gallery', 'e:gallery'] }]);
    expect(two.nextPageToken).toBe('');
    expect(harness.spine.imageCalls.map((c) => [c.request.pageToken, c.request.pageSize])).toEqual([['', 2], ['s2', 2], ['s2', 2], ['s3', 2]]);
  });

  it('hands the spine\'s own token back unchanged when it owes nothing mid-page', async () => {
    harness = await start({
      restrictions: sourceOf([]),
      respondImages: () => page([{ productId: H1, images: [row('a', { primary: true }), row('b')] }], 'spine-next'),
    });
    const res = await harness.catalog.getProductImages({ headIds: [H1], pageSize: 2, pageToken: 'spine-1' });
    expect(res.nextPageToken).toBe('spine-next');
    expect(harness.spine.imageCalls[0]?.request.pageToken).toBe('spine-1');
  });

  it('asks the spine for the server default page of 50 when the client sends 0, and caps at 200', async () => {
    harness = await start({ restrictions: sourceOf([]), respondImages: () => page([]) });
    await harness.catalog.getProductImages({ headIds: [H1] });
    await harness.catalog.getProductImages({ headIds: [H1], pageSize: 500 });
    expect(harness.spine.imageCalls.map((c) => c.request.pageSize)).toEqual([50, 200]);
  });

  it(`stops after ${MAX_SPINE_IMAGE_READS} spine reads when everything is withheld, with a token to the next`, async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'product', H1, 'no_display')]),
      respondImages: (call) => page([{ productId: H1, images: [row('a')] }], `s${Number(call.request.pageToken.slice(1) || '0') + 1}`),
    });
    const res = await harness.catalog.getProductImages({ headIds: [H1], pageSize: 5 });
    expect(res.products).toEqual([]);
    expect(harness.spine.imageCalls).toHaveLength(MAX_SPINE_IMAGE_READS);
    expect(res.nextPageToken).toBe(`s${MAX_SPINE_IMAGE_READS}`);
  });

  it.each([
    ['not base64url JSON', 'c1.!!!'],
    ['a JSON array', `c1.${Buffer.from('[]').toString('base64url')}`],
    ['a negative offset', `c1.${Buffer.from(JSON.stringify({ s: 'x', k: -1, p: [] })).toString('base64url')}`],
    ['a fractional offset', `c1.${Buffer.from(JSON.stringify({ s: 'x', k: 1.5, p: [] })).toString('base64url')}`],
    ['a non-string spine token', `c1.${Buffer.from(JSON.stringify({ s: 1, k: 0, p: [] })).toString('base64url')}`],
    ['a non-array debt', `c1.${Buffer.from(JSON.stringify({ s: 'x', k: 0, p: 'h' })).toString('base64url')}`],
    ['a debt that is not a list of ids', `c1.${Buffer.from(JSON.stringify({ s: 'x', k: 0, p: [1] })).toString('base64url')}`],
    ['a debt longer than any batch', `c1.${Buffer.from(JSON.stringify({ s: 'x', k: 0, p: Array.from({ length: 201 }, (_, i) => `h${i}`) })).toString('base64url')}`],
  ])('refuses a coordinator token that is %s, before any spine call', async (_label, pageToken) => {
    harness = await start({ restrictions: sourceOf([]), respondImages: () => page([]) });
    expect(await codeOf(harness.catalog.getProductImages({ headIds: [H1], pageToken }))).toBe(Code.InvalidArgument);
    expect(harness.spine.imageCalls).toHaveLength(0);
  });
});

describe('(d) every denial is logged with its rules; nothing withheld is debug only', () => {
  it('logs the image, the context and the rules that withheld it, sorted, at info', async () => {
    harness = await start({
      restrictions: sourceOf([r('r2', 'image', sha('a'), 'no_display'), r('r1', 'product', H1, 'no_display'), r('r3', 'source', 'x', 'no_mask')]),
      respondImages: () => page([{ productId: H1, images: [row('a', { primary: true, sources: ['amiami'] }), row('b', { sources: ['amiami'] })] }]),
    });
    await harness.catalog.getProductImages({ headIds: [H1] });
    const logged = denials(harness.lines);
    expect(logged).toEqual([
      expect.objectContaining({ level: 'info', image_id: sha('a'), head_id: H1, context: 'owner', withheld: 'image', sources_known: true, denials: [{ rule: 'r1', scope: 'no_display' }, { rule: 'r2', scope: 'no_display' }] }),
      expect.objectContaining({ level: 'info', image_id: sha('b'), withheld: 'image', denials: [{ rule: 'r1', scope: 'no_display' }] }),
    ]);
  });

  it('logs an evaluation that withheld nothing at debug, without a rule', async () => {
    harness = await start({
      restrictions: sourceOf([r('r1', 'image', sha('z'), 'no_display')]),
      respondImages: () => page([{ productId: H1, images: [row('a', { primary: true })] }]),
    });
    await harness.catalog.getProductImages({ headIds: [H1] });
    expect(denials(harness.lines)).toEqual([]);
    expect(harness.lines.filter((l) => l['msg'] === 'display evaluated')).toEqual([
      expect.objectContaining({ level: 'debug', image_id: sha('a'), context: 'owner', withheld: null, denials: [] }),
    ]);
  });
});

describe('(e) no restriction set, no image', () => {
  it('answers UNAVAILABLE without asking the spine when the restrictions cannot be read', async () => {
    harness = await start({
      restrictions: { current: async () => { throw new Error('db down'); } },
      respondImages: () => page([{ productId: H1, images: [row('a', { primary: true })] }]),
    });
    expect(await codeOf(harness.catalog.getProductImages({ headIds: [H1] }))).toBe(Code.Unavailable);
    expect(harness.spine.imageCalls).toHaveLength(0);
  });

  it('does not read the restrictions while images are off', async () => {
    const restrictions = sourceOf([]);
    harness = await start({ restrictions, mediaBaseUrl: null });
    await harness.catalog.getProductImages({ headIds: [H1] });
    expect(restrictions.calls).toBe(0);
  });
});

interface GoldenImage {
  image_id: string;
  product_ids: string[];
  sources: string[];
  role: string;
  primary: boolean;
}
interface GoldenList {
  name: string;
  images: GoldenImage[];
  restrictions: DisplayRestriction[];
  context: ViewerContext;
  expect: { images: { image_id: string; role: string; primary: boolean }[] };
}
const golden = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve('@figurecollecting/fc-api-contract/golden/display-vectors.json'), 'utf8'),
) as { lists: GoldenList[] };

describe('(f) the golden lists, through GetProductImages', () => {
  it('reads all 9 of them', () => {
    expect(golden.lists).toHaveLength(9);
  });

  it.each(golden.lists.map((l) => [l.name, l] as const))('%s', async (_name, l) => {
    // The vectors name images and the head; the spine carries content addresses and product ids.
    const shaOf = new Map(l.images.map((i, n) => [i.image_id, sha(String.fromCharCode(0x61 + n))]));
    const nameOf = new Map([...shaOf].map(([name, hex]) => [hex, name]));
    const id = (x: string): string => shaOf.get(x) ?? (x === 'p-head' ? H1 : x);
    const aliases = [...new Set(l.images.flatMap((i) => i.product_ids).filter((p) => p !== 'p-head'))];
    harness = await start({
      viewerContext: l.context,
      restrictions: sourceOf(l.restrictions.map((x) => r(x.rule, x.level, id(x.subject), x.scope)), { [H1]: aliases }),
      respondImages: () => page([{ productId: H1, images: l.images.map((i) => row('a', { derivativeSha256: id(i.image_id), url: `${MEDIA}/${id(i.image_id)}`, role: i.role, primary: i.primary, sources: i.sources })) }]),
    });
    for (const pageSize of [0, 1, 2]) {
      const got: { image_id: string; role: string; primary: boolean }[] = [];
      let pageToken = '';
      for (let calls = 0; calls < 10; calls += 1) {
        const res = await harness.catalog.getProductImages({ headIds: [H1], pageSize, pageToken });
        for (const p of res.products) {
          expect(p.headId).toBe(H1);
          for (const i of p.images) got.push({ image_id: nameOf.get(i.derivativeId) ?? i.derivativeId, role: i.role, primary: i.primary });
        }
        pageToken = res.nextPageToken;
        if (pageToken === '') break;
      }
      expect({ pageSize, images: got }).toEqual({ pageSize, images: l.expect.images });
    }
  });
});

// ---------------------------------------------------------------------------
// (g) and (h): the mask, its grounding and the appearance (contract 0.4.0 ProductImage), and MASK-G.
// ---------------------------------------------------------------------------
const MASKED_TH = Uint8Array.from([0x3c, 0x18, 0x06, 0x06, 0x0a, 0x7f, 0x86, 0x88, 0x76, 0x88, 0xd8, 0xf8, 0xaa]);
const PLAIN_TH = Uint8Array.from([0x2b, 0x08, 0x06, 0x06, 0x0a, 0x7f, 0x86, 0x88, 0x76, 0x88, 0xd8, 0xf8]);
const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
// The spine's raw tokens (fc-aggregation read/products.ts ImageGrounding), the CONTRACT-1 fields included.
const MASK_GROUNDING = {
  bottomMarginFrac: '0.05758426966292135',
  contactBand: { centerXFrac: '0.5383', widthFrac: '0.4267' },
  topMarginFrac: '0.0618',
  opaqueBox: { top: '0.0618', bottom: '0.94241573033707865', left: '0.0517', right: '0.9517' },
};
const OWN_GROUNDING = {
  bottomMarginFrac: '0.03',
  contactBand: { centerXFrac: '0.499', widthFrac: '0.118' },
  topMarginFrac: '0.08',
  opaqueBox: { top: '0.08', bottom: '0.97', left: '0.4', right: '0.6' },
};
const spineMask = (m: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  maskSha256: sha(m),
  contentType: 'image/png',
  pipelineVersion: 'mask-v2',
  generatedAt: '2026-10-11 00:00:00+00',
  url: `${MEDIA}/${sha(m)}`,
  grounding: MASK_GROUNDING,
  thumbhash: b64(MASKED_TH),
  dominantColor: '#3a2b4c',
  ...over,
});
/** A spine row with its plain appearance, its own alpha's grounding when asked, and a mask when given. */
const maskedRow = (c: string, o: { primary?: boolean; sources?: unknown; mask?: Record<string, unknown> | null; ownAlpha?: boolean; extra?: Record<string, unknown> } = {}): Row =>
  row(c, {
    primary: o.primary ?? false,
    ...(o.sources === undefined ? {} : { sources: o.sources }),
    thumbhash: b64(PLAIN_TH),
    dominantColor: '#fafaf8',
    ...(o.ownAlpha === true ? { grounding: OWN_GROUNDING } : {}),
    ...(o.mask === undefined || o.mask === null ? {} : { mask: o.mask }),
    ...o.extra,
  });

interface SentImage {
  derivativeId: string;
  primary: boolean;
  url: string;
  mask?: { maskId: string; contentType: string; url: string } | undefined;
  bottomMarginFrac?: number | undefined;
  contactBand?: { centerXFrac: number; widthFrac: number } | undefined;
  thumbhash: Uint8Array;
  dominantColor: string;
}
const sent = (i: SentImage) => ({
  id: i.derivativeId,
  primary: i.primary,
  url: i.url,
  mask: i.mask === undefined ? undefined : { maskId: i.mask.maskId, contentType: i.mask.contentType, url: i.mask.url },
  bottomMarginFrac: i.bottomMarginFrac,
  contactBand: i.contactBand === undefined ? undefined : { centerXFrac: i.contactBand.centerXFrac, widthFrac: i.contactBand.widthFrac },
  thumbhash: [...i.thumbhash],
  dominantColor: i.dominantColor,
});
const imagesOf = (res: { products: { images: SentImage[] }[] }) => res.products.flatMap((p) => p.images.map(sent));
const DESCRIBED = {
  mask: { bottomMarginFrac: 0.05758426966292135, contactBand: { centerXFrac: 0.5383, widthFrac: 0.4267 } },
  own_alpha: { bottomMarginFrac: 0.03, contactBand: { centerXFrac: 0.499, widthFrac: 0.118 } },
  unset: { bottomMarginFrac: undefined, contactBand: undefined },
} as const;
const LOOK = {
  masked: { thumbhash: [...MASKED_TH], dominantColor: '#3a2b4c' },
  plain: { thumbhash: [...PLAIN_TH], dominantColor: '#fafaf8' },
} as const;
const sentMask = (m: string) => ({ maskId: sha(m), contentType: 'image/png', url: `${MEDIA}/${sha(m)}` });

describe('(g) the mask, its grounding and the appearance are sent as the decision says', () => {
  it('sends the spine\'s mask, the grounding measured on it and the appearance with it applied', async () => {
    harness = await start({
      restrictions: sourceOf([]),
      respondImages: () => page([{ productId: H1, images: [maskedRow('a', { primary: true, sources: ['amiami'], mask: spineMask('1') })] }]),
    });
    expect(imagesOf(await harness.catalog.getProductImages({ headIds: [H1] }))).toEqual([
      { id: sha('a'), primary: true, url: `${MEDIA}/${sha('a')}`, mask: sentMask('1'), ...DESCRIBED.mask, ...LOOK.masked },
    ]);
    expect(denials(harness.lines)).toEqual([]);
  });

  it('describes an image with no mask by its own alpha when it has one, else leaves the grounding unset', async () => {
    harness = await start({
      restrictions: sourceOf([]),
      respondImages: () => page([{ productId: H1, images: [maskedRow('a', { primary: true, ownAlpha: true }), maskedRow('b')] }]),
    });
    expect(imagesOf(await harness.catalog.getProductImages({ headIds: [H1] }))).toEqual([
      { id: sha('a'), primary: true, url: `${MEDIA}/${sha('a')}`, mask: undefined, ...DESCRIBED.own_alpha, ...LOOK.plain },
      { id: sha('b'), primary: false, url: `${MEDIA}/${sha('b')}`, mask: undefined, ...DESCRIBED.unset, ...LOOK.plain },
    ]);
  });

  it.each([
    ['a mask under another host', spineMask('1', { url: `https://images.store.example/d/${sha('1')}` })],
    ['a mask url that only starts with <base>/<id>', spineMask('1', { url: `${MEDIA}/${sha('1')}?raw=1` })],
    ['a mask with no url', spineMask('1', { url: undefined })],
    ['a mask id that is not a sha-256', spineMask('1', { maskSha256: 'abc', url: `${MEDIA}/abc` })],
    ['an upper-case mask id', spineMask('1', { maskSha256: sha('A'), url: `${MEDIA}/${sha('A')}` })],
    ['a mask that is not an object', 'mask' as unknown as Record<string, unknown>],
  ])('sends no mask for %s, describes the image without it and logs nothing withheld', async (_label, mask) => {
    harness = await start({
      restrictions: sourceOf([r('mask-store:hlj', 'source', 'hlj', 'no_mask')]),
      respondImages: () => page([{ productId: H1, images: [maskedRow('a', { primary: true, sources: ['amiami'], mask })] }]),
    });
    expect(imagesOf(await harness.catalog.getProductImages({ headIds: [H1] }))).toEqual([
      { id: sha('a'), primary: true, url: `${MEDIA}/${sha('a')}`, mask: undefined, ...DESCRIBED.unset, ...LOOK.plain },
    ]);
    expect(denials(harness.lines)).toEqual([]);
  });

  it('withholds a revoked store\'s mask in every page of a long list, the clean copies all kept', async () => {
    const images = ['a', 'b', 'c', 'd', 'e'].map((c, n) =>
      maskedRow(c, { primary: n === 0, sources: [n % 2 === 0 ? 'amiami' : 'hlj'], mask: spineMask(String(n)) }));
    harness = await start({
      restrictions: sourceOf([r('mask-store:amiami', 'source', 'amiami', 'no_mask')]),
      respondImages: () => page([{ productId: H1, images }]),
    });
    const got: { id: string; mask: boolean }[] = [];
    let pageToken = '';
    for (let calls = 0; calls < 10; calls += 1) {
      const res = await harness.catalog.getProductImages({ headIds: [H1], pageSize: 2, pageToken });
      got.push(...imagesOf(res).map((i) => ({ id: i.id[0]!, mask: i.mask !== undefined })));
      pageToken = res.nextPageToken;
      if (pageToken === '') break;
    }
    expect(got).toEqual([
      { id: 'a', mask: false },
      { id: 'b', mask: true },
      { id: 'c', mask: false },
      { id: 'd', mask: true },
      { id: 'e', mask: false },
    ]);
  });
});

interface StoreGoldenImage {
  image_id: string;
  primary: boolean;
  sources: string[] | null;
  mask: boolean;
  own_alpha: boolean;
}
interface StoreGoldenList {
  name: string;
  context: ViewerContext;
  images: StoreGoldenImage[];
  restrictions: DisplayRestriction[];
  expect: {
    images: { image_id: string; primary: boolean; mask: boolean; grounding: keyof typeof DESCRIBED; appearance: keyof typeof LOOK }[];
    denials: { image_id: string; withheld: 'image' | 'mask'; rules: string[] }[];
  };
}
const storeGolden = JSON.parse(
  readFileSync(new URL('../fixtures/mask-store-golden.json', import.meta.url), 'utf8'),
) as { lists: StoreGoldenList[] };
/** Image a's mask is 0, b's is 1, and so on: a mask's address is never its image's. */
const maskOf = (imageId: string): string => String.fromCharCode(0x30 + imageId.charCodeAt(0) - 0x61);

describe('(h) MASK-G: a store\'s revocation, through GetProductImages', () => {
  it('reads all 15 lists', () => {
    expect(storeGolden.lists).toHaveLength(15);
  });

  it.each(storeGolden.lists.map((l) => [l.name, l] as const))('%s', async (_name, l) => {
    const subject = (x: string): string => (x === 'p-head' ? H1 : /^[a-f]$/.test(x) ? sha(x) : x);
    harness = await start({
      viewerContext: l.context,
      restrictions: sourceOf(l.restrictions.map((x) => r(x.rule, x.level, subject(x.subject), x.scope))),
      respondImages: () => page([{
        productId: H1,
        images: l.images.map((i) => maskedRow(i.image_id, {
          primary: i.primary,
          ...(i.sources === null ? {} : { sources: i.sources }),
          mask: i.mask ? spineMask(maskOf(i.image_id)) : null,
          ownAlpha: i.own_alpha,
        })),
      }]),
    });
    const want = l.expect.images.map((e) => ({
      id: sha(e.image_id),
      primary: e.primary,
      url: `${MEDIA}/${sha(e.image_id)}`,
      mask: e.mask ? sentMask(maskOf(e.image_id)) : undefined,
      ...DESCRIBED[e.grounding],
      ...LOOK[e.appearance],
    }));
    for (const pageSize of [0, 1, 2]) {
      harness.lines.length = 0;
      const got: ReturnType<typeof sent>[] = [];
      let pageToken = '';
      for (let calls = 0; calls < 10; calls += 1) {
        const res = await harness.catalog.getProductImages({ headIds: [H1], pageSize, pageToken });
        got.push(...imagesOf(res));
        pageToken = res.nextPageToken;
        if (pageToken === '') break;
      }
      expect({ pageSize, images: got }).toEqual({ pageSize, images: want });
      expect({
        pageSize,
        denials: denials(harness.lines).map((d) => ({
          image_id: String(d['image_id'])[0],
          withheld: d['withheld'],
          rules: (d['denials'] as { rule: string }[]).map((x) => x.rule),
          level: d['level'],
          context: d['context'],
          sources_known: d['sources_known'],
        })),
      }).toEqual({
        pageSize,
        denials: l.expect.denials.map((e) => ({
          ...e,
          level: 'info',
          context: l.context,
          sources_known: (l.images.find((i) => i.image_id === e.image_id)!.sources ?? []).length > 0,
        })),
      });
    }
  });
});
