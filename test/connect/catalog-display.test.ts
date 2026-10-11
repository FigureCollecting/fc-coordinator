// ADDR-1: the image-list CHOKEPOINT (catalog.proto DISPLAY RESTRICTIONS). GetProductImages evaluates
// every row for the caller's viewer context (owner: every CatalogService call) before a page is cut:
//   (a) a withheld image is absent, its product absent when nothing is left, the restriction never named;
//   (b) a withheld primary is replaced by the first image shown, on whatever page it falls;
//   (c) withheld rows are dropped BEFORE the page is cut: the coordinator reads further spine pages
//       to fill one, and resumes mid-page from its own token, within a bounded number of spine reads;
//   (d) a denial is logged with its rules at info; an evaluation that withholds nothing at debug;
//   (e) the coordinator fails closed: no restriction set, no image (UNAVAILABLE); unknown sources
//       count as every source.
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
import type { DisplayRestriction } from '../../src/display/restrictions.js';
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
  options: Omit<FakeSpineReadOptions, 'keys'> & { restrictions?: DisplayRestrictionSource; mediaBaseUrl?: string | null } = {},
): Promise<Harness> {
  const kp = generateTestSigningKey(KID);
  process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
  process.env['ENTITLEMENT_SIGNING_KID'] = KID;
  const fga = await startFakeOpenFga(() => true);
  process.env['OPENFGA_GRPC_URL'] = fga.baseUrl;
  process.env['OPENFGA_STORE_ID'] = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
  process.env['OPENFGA_API_TOKEN'] = 'test-preshared-key-never-logged';
  const { restrictions, mediaBaseUrl, ...spineOptions } = options;
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
        { productId: H1, images: [row('a', { primary: true }), row('b', { sources: 'hlj' }), row('c', { sources: ['amiami', 7] })] },
        { productId: H2, images: [row('d', { primary: true, sources: ['amiami'] })] },
      ]),
    });
    expect(shown(await harness.catalog.getProductImages({ headIds: [H1, H2] }))).toEqual([{ head: H2, images: ['d*:gallery'] }]);
    expect(denials(harness.lines).map((l) => l['sources_known'])).toEqual([false, false, false]);
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
