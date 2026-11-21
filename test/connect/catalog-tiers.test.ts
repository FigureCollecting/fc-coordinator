/**
 * IR-COORD: the tiers of an image row and of its mask (contract 0.8.0 ImageTier), as the pure
 * mapper reads them from the spine's JSON. test/connect/catalog-display.test.ts section (i) drives
 * the same code through GetProductImages (the golden `tiers` vectors, every scope, paging, the
 * setting); this file pins what a fake spine has no reason to produce: each way ONE tier can be
 * bad, the order, the cap and the numbers.
 *
 * The rule under test: a tier is kept on the derivative's own terms (a lowercase sha-256 served at
 * exactly <base>/<sha>), as WebP, with a long edge from 1 to 4,096 px that is not past its parent's
 * when the parent's size is known. A tier that fails is dropped ALONE: the image, its mask and
 * every other tier stay.
 */
import { describe, expect, it } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import { GetProductImagesResponseSchema, ProductImagesSchema, type ImageTier } from '@figurecollecting/fc-api-contract';
import { MAX_IMAGE_TIERS, MAX_TIER_LONG_EDGE_PX, readImageRows, resolveImageTiers } from '../../src/connect/catalog.js';
import { CANNED_HEAD_ID } from '../helpers/fakeSpineRead.js';

const MEDIA = 'https://images.figurecollecting.test/d';
const SHA = 'c'.repeat(64);
const MASK = 'd'.repeat(64);
/** The content address of a test tier: one byte value repeated, so a tier is recognisable by its edge. */
const tierSha = (edge: number, kind: 'photo' | 'mask' = 'photo'): string =>
  `${kind === 'photo' ? 'a' : 'b'}${(edge % 0xfff).toString(16).padStart(3, '0')}`.repeat(16);

type SpineTier = Record<string, unknown>;
/** One tier as the spine sends it: raw tokens, the content address in hex and the URL to fetch it from. */
const tier = (edge: number, over: SpineTier = {}, kind: 'photo' | 'mask' = 'photo'): SpineTier => ({
  sha256: tierSha(edge, kind),
  longEdgePx: String(edge),
  width: String(Math.round((edge * 600) / 850)),
  height: String(edge),
  contentType: 'image/webp',
  bytes: String(edge * 20),
  url: `${MEDIA}/${tierSha(edge, kind)}`,
  ...over,
});
const maskTier = (edge: number, over: SpineTier = {}): SpineTier => tier(edge, over, 'mask');

const GROUNDING = {
  bottomMarginFrac: '0.05',
  contactBand: { centerXFrac: '0.5', widthFrac: '0.4' },
  topMarginFrac: '0.06',
  opaqueBox: { top: '0.06', bottom: '0.95', left: '0.05', right: '0.95' },
};
const spineMask = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  maskSha256: MASK,
  contentType: 'image/png',
  pipelineVersion: 'mask-v2',
  generatedAt: '2026-10-11 00:00:00+00',
  url: `${MEDIA}/${MASK}`,
  grounding: GROUNDING,
  ...over,
});
/** A 600 x 850 derivative: its long edge is 850, so 850 is the native rung. */
const image = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  role: 'gallery',
  primary: true,
  derivativeSha256: SHA,
  contentType: 'image/webp',
  width: '600',
  height: '850',
  url: `${MEDIA}/${SHA}`,
  ...over,
});
const read = (img: unknown, sendTiers?: boolean) => {
  const json = JSON.stringify({ products: [{ productId: CANNED_HEAD_ID, images: [img] }], coverage: {} });
  const rows = sendTiers === undefined ? readImageRows(json, MEDIA) : readImageRows(json, MEDIA, sendTiers);
  return rows![0]!;
};
const edges = (tiers: readonly ImageTier[] | undefined): number[] => (tiers ?? []).map((t) => t.longEdgePx);
const plain = (t: ImageTier) => ({ longEdgePx: t.longEdgePx, sha256: Buffer.from(t.sha256).toString('hex'), width: t.width, height: t.height, bytes: t.bytes });

describe('readImageRows: an image\'s tiers and its mask\'s tiers', () => {
  it('maps each tier of the image: long edge, the sha-256 as 32 raw bytes, pixel size and byte size', () => {
    const r = read(image({ tiers: [tier(256), tier(512), tier(850)] }));
    expect(r.image?.tiers.map(plain)).toEqual([
      { longEdgePx: 256, sha256: tierSha(256), width: 181, height: 256, bytes: 5120 },
      { longEdgePx: 512, sha256: tierSha(512), width: 361, height: 512, bytes: 10240 },
      { longEdgePx: 850, sha256: tierSha(850), width: 600, height: 850, bytes: 17000 },
    ]);
    expect(r.image?.tiers.every((t) => t.sha256.length === 32)).toBe(true);
  });

  it('maps the mask\'s tiers into the mask and nowhere else, never filling one list from the other', () => {
    const r = read(image({ tiers: [tier(256), tier(512), tier(850)], mask: spineMask({ tiers: [maskTier(256), maskTier(512)] }) }));
    expect(r.mask?.mask.tiers.map(plain)).toEqual([
      { longEdgePx: 256, sha256: tierSha(256, 'mask'), width: 181, height: 256, bytes: 5120 },
      { longEdgePx: 512, sha256: tierSha(512, 'mask'), width: 361, height: 512, bytes: 10240 },
    ]);
    expect(r.image?.tiers.map(plain).map((t) => t.sha256)).toEqual([tierSha(256), tierSha(512), tierSha(850)]);
    // The mask is not on the image until the display decision sends it (presentImage).
    expect(r.image?.mask).toBeUndefined();
  });

  it('sends no URL and no media type for a tier: the address travels as raw bytes, never as hex text', () => {
    const r = read(image({ tiers: [tier(256)] }));
    const t = r.image!.tiers[0]!;
    expect(Object.keys(t).filter((k) => k !== '$typeName' && k !== '$unknown').sort()).toEqual(['bytes', 'height', 'longEdgePx', 'sha256', 'width']);
    const wire = Buffer.from(toBinary(GetProductImagesResponseSchema, create(GetProductImagesResponseSchema, { products: [create(ProductImagesSchema, { headId: CANNED_HEAD_ID, images: [r.image!] })] })));
    expect(wire.includes(Buffer.from(tierSha(256), 'hex'))).toBe(true);
    expect(wire.toString('latin1')).not.toContain(tierSha(256));
  });

  it.each([
    ['no tiers key (a spine built before tiers)', {}],
    ['tiers null', { tiers: null }],
    ['tiers that are not a list', { tiers: { 0: tier(256) } }],
    ['tiers as a string', { tiers: 'none' }],
    ['an empty list', { tiers: [] }],
  ])('keeps the image and sends no tier for %s', (_label, over) => {
    const r = read(image({ ...over, mask: spineMask(over) }));
    expect(r.image?.url).toBe(`${MEDIA}/${SHA}`);
    expect(r.image?.tiers).toEqual([]);
    expect(r.mask?.mask.maskId).toBe(MASK);
    expect(r.mask?.mask.tiers).toEqual([]);
  });
});

// Every way one tier can be bad. In each the bad tier sits BETWEEN two good ones, on the image and
// on the mask, and exactly it is dropped.
const BAD: [string, SpineTier | unknown][] = [
  // a malformed id
  ['an id that is not a sha-256', tier(512, { sha256: 'abc', url: `${MEDIA}/abc` })],
  ['an upper-case id', tier(512, { sha256: tierSha(512).toUpperCase(), url: `${MEDIA}/${tierSha(512).toUpperCase()}` })],
  ['an id of 63 hex digits', tier(512, { sha256: tierSha(512).slice(1), url: `${MEDIA}/${tierSha(512).slice(1)}` })],
  ['an id of 65 hex digits', tier(512, { sha256: `${tierSha(512)}a`, url: `${MEDIA}/${tierSha(512)}a` })],
  ['an id that is not text', tier(512, { sha256: 512 })],
  ['no id', tier(512, { sha256: undefined })],
  ['an id with a traversal prefix, its url agreeing', tier(512, { sha256: `../originals/${tierSha(512)}`, url: `${MEDIA}/../originals/${tierSha(512)}` })],
  ['an id with a query suffix, its url agreeing', tier(512, { sha256: `${tierSha(512)}?raw=1`, url: `${MEDIA}/${tierSha(512)}?raw=1` })],
  // a foreign URL
  ['a url under another host', tier(512, { url: `https://images.store.example/d/${tierSha(512)}` })],
  ['the right host but another path', tier(512, { url: `https://images.figurecollecting.test/originals/${tierSha(512)}` })],
  ['a url that only starts with the base', tier(512, { url: `${MEDIA}/${tierSha(512)}?raw=1` })],
  ['a traversal under the base', tier(512, { url: `${MEDIA}/../originals/${tierSha(512)}` })],
  ['another tier\'s url', tier(512, { url: `${MEDIA}/${tierSha(256)}` })],
  ['the base with a trailing slash doubled', tier(512, { url: `${MEDIA}//${tierSha(512)}` })],
  ['http instead of https', tier(512, { url: `http://images.figurecollecting.test/d/${tierSha(512)}` })],
  ['no url (the spine has no media base)', tier(512, { url: undefined })],
  ['a url that is not text', tier(512, { url: 512 })],
  // the wrong media type
  ['image/png', tier(512, { contentType: 'image/png' })],
  ['image/jpeg', tier(512, { contentType: 'image/jpeg' })],
  ['IMAGE/WEBP in capitals', tier(512, { contentType: 'IMAGE/WEBP' })],
  ['image/webp with a parameter', tier(512, { contentType: 'image/webp; q=1' })],
  ['no media type', tier(512, { contentType: undefined })],
  ['a null media type', tier(512, { contentType: null })],
  // the long edge
  ['a long edge past the parent\'s (851 on 850)', tier(851)],
  ['a long edge past the parent\'s and the cap (5,000)', tier(5000)],
  ['a long edge of 0', tier(512, { longEdgePx: '0' })],
  ['a negative long edge', tier(512, { longEdgePx: '-512' })],
  ['a fractional long edge', tier(512, { longEdgePx: '512.5' })],
  ['a long edge in exponent form', tier(512, { longEdgePx: '5e2' })],
  ['a fractional long edge as a number', tier(512, { longEdgePx: 512.5 })],
  ['a long edge that is not a number', tier(512, { longEdgePx: 'large' })],
  ['no long edge', tier(512, { longEdgePx: undefined })],
  ['a long edge too large to be a pixel count', tier(512, { longEdgePx: '99999999999999999999' })],
  // the pixel size
  ['a width of 0', tier(512, { width: '0' })],
  ['a height of 0', tier(512, { height: '0' })],
  ['no width', tier(512, { width: undefined })],
  ['a height that is not a number', tier(512, { height: 'tall' })],
  ['a width over uint32', tier(512, { width: '4294967296' })],
  // not a tier at all
  ['a tier that is a string', `${MEDIA}/${tierSha(512)}`],
  ['a tier that is null', null],
  ['a tier that is a list', [tier(512)]],
  ['a tier that is a number', 512],
];

describe('readImageRows: a bad tier is dropped alone', () => {
  it.each(BAD)('drops %s from the image\'s tiers, and keeps the image and its other tiers', (_label, bad) => {
    const r = read(image({ tiers: [tier(256), bad, tier(850)] }));
    expect(r.image?.url).toBe(`${MEDIA}/${SHA}`);
    expect(r.image?.tiers.map(plain).map((t) => t.sha256)).toEqual([tierSha(256), tierSha(850)]);
  });

  it.each(BAD)('drops %s from the mask\'s tiers, and keeps the mask, its other tiers and the image\'s', (_label, bad) => {
    // The same bad entry, now in the mask's list (a photo-tier address there is as good as any: the guard is the same).
    const r = read(image({ tiers: [tier(256), tier(850)], mask: spineMask({ tiers: [maskTier(256), bad, maskTier(850)] }) }));
    expect(r.mask?.mask.maskId).toBe(MASK);
    expect(r.mask?.mask.tiers.map(plain).map((t) => t.sha256)).toEqual([tierSha(256, 'mask'), tierSha(850, 'mask')]);
    expect(edges(r.image?.tiers)).toEqual([256, 850]);
  });

  it('drops every bad tier of a list in one read and keeps the good one', () => {
    const r = read(image({ tiers: [...BAD.map(([, bad]) => bad), tier(256)] }));
    expect(edges(r.image?.tiers)).toEqual([256]);
  });

  it('sends an image whose tiers are all bad with no tier, never drops it', () => {
    const r = read(image({ tiers: BAD.map(([, bad]) => bad) }));
    expect(r.image?.derivativeId).toBe(SHA);
    expect(r.image?.tiers).toEqual([]);
  });

  it('does not let a tier save an image the derivative rule refuses, nor a mask it refuses', () => {
    const lost = read(image({ url: `https://images.store.example/${SHA}`, tiers: [tier(256)] }));
    expect(lost.image).toBeNull();
    const maskless = read(image({ tiers: [tier(256)], mask: spineMask({ url: `https://images.store.example/${MASK}`, tiers: [maskTier(256)] }) }));
    expect(maskless.mask).toBeNull();
    expect(edges(maskless.image?.tiers)).toEqual([256]);
  });
});

describe('readImageRows: a tier is never past its parent', () => {
  it('keeps a tier at exactly the parent\'s long edge (the native rung) and drops the one above', () => {
    const r = read(image({ width: '512', height: '300', tiers: [tier(256), tier(512), tier(513), tier(1024)], mask: spineMask({ tiers: [maskTier(512), maskTier(850)] }) }));
    expect(edges(r.image?.tiers)).toEqual([256, 512]);
    // A mask is sized from its derivative, so the derivative's long edge bounds the mask's tiers too.
    expect(edges(r.mask?.mask.tiers)).toEqual([512]);
  });

  it('takes the long edge from the larger side, whichever it is', () => {
    expect(edges(read(image({ width: '1024', height: '700', tiers: [tier(512), tier(1024), tier(2048)] })).image?.tiers)).toEqual([512, 1024]);
    expect(edges(read(image({ width: '700', height: '1024', tiers: [tier(512), tier(1024), tier(2048)] })).image?.tiers)).toEqual([512, 1024]);
  });

  it.each([
    ['both sides unknown', { width: '0', height: '0' }],
    ['no size at all', { width: undefined, height: undefined }],
    ['the width unknown', { width: '0', height: '850' }],
    ['the height unknown', { width: '600', height: null }],
    ['a size the spine did not write as a whole number', { width: '600.5', height: '850' }],
  ])('drops nothing for the parent when its size is unknown (%s), as the contract promises nothing then', (_label, size) => {
    const r = read(image({ ...size, tiers: [tier(256), tier(1024), tier(2048)], mask: spineMask({ tiers: [maskTier(256), maskTier(2048)] }) }));
    expect(edges(r.image?.tiers)).toEqual([256, 1024, 2048]);
    expect(edges(r.mask?.mask.tiers)).toEqual([256, 2048]);
  });

  it(`keeps a tier of exactly ${MAX_TIER_LONG_EDGE_PX} px and drops ${MAX_TIER_LONG_EDGE_PX + 1}, whatever the parent`, () => {
    expect(MAX_TIER_LONG_EDGE_PX).toBe(4096);
    const big = read(image({ width: '6000', height: '8000', tiers: [tier(2048), tier(4096), tier(4097)] }));
    expect(edges(big.image?.tiers)).toEqual([2048, 4096]);
    const unknown = read(image({ width: '0', height: '0', tiers: [tier(4096), tier(4097), tier(8192)] }));
    expect(edges(unknown.image?.tiers)).toEqual([4096]);
  });
});

describe('readImageRows: order and cap', () => {
  it('sends tiers in ascending order of long edge however the spine ordered them', () => {
    const r = read(image({ width: '3000', height: '4000', tiers: [tier(2048), tier(256), tier(1024), tier(512)], mask: spineMask({ tiers: [maskTier(512), maskTier(256)] }) }));
    expect(edges(r.image?.tiers)).toEqual([256, 512, 1024, 2048]);
    expect(edges(r.mask?.mask.tiers)).toEqual([256, 512]);
  });

  it('never sends two tiers of one long edge: the first the spine listed stands', () => {
    const second = tier(512, { sha256: 'e'.repeat(64), url: `${MEDIA}/${'e'.repeat(64)}` });
    const r = read(image({ tiers: [tier(850), tier(512), second, tier(256)] }));
    expect(r.image?.tiers.map(plain).map((t) => [t.longEdgePx, t.sha256])).toEqual([
      [256, tierSha(256)],
      [512, tierSha(512)],
      [850, tierSha(850)],
    ]);
  });

  it('does not let a bad tier take the place of a good one of the same long edge', () => {
    const r = read(image({ tiers: [tier(512, { contentType: 'image/png' }), tier(512)] }));
    expect(r.image?.tiers.map(plain)).toEqual([{ longEdgePx: 512, sha256: tierSha(512), width: 361, height: 512, bytes: 10240 }]);
  });

  it(`sends at most ${MAX_IMAGE_TIERS} tiers of an image and of a mask: the ${MAX_IMAGE_TIERS} smallest`, () => {
    expect(MAX_IMAGE_TIERS).toBe(8);
    const ladder = [4096, 3000, 2048, 1500, 1024, 768, 512, 384, 256, 128];
    const r = read(image({ width: '6000', height: '8000', tiers: ladder.map((e) => tier(e)), mask: spineMask({ tiers: ladder.map((e) => maskTier(e)) }) }));
    expect(edges(r.image?.tiers)).toEqual([128, 256, 384, 512, 768, 1024, 1500, 2048]);
    expect(edges(r.mask?.mask.tiers)).toEqual([128, 256, 384, 512, 768, 1024, 1500, 2048]);
  });

  it(`sends exactly ${MAX_IMAGE_TIERS} when the spine holds exactly that many`, () => {
    const ladder = [128, 256, 384, 512, 768, 1024, 1500, 2048];
    expect(edges(read(image({ width: '6000', height: '8000', tiers: ladder.map((e) => tier(e)) })).image?.tiers)).toEqual(ladder);
  });

  it('counts the cap over good tiers only, so bad ones cannot crowd a good one out', () => {
    const bad = Array.from({ length: 20 }, (_, n) => tier(100 + n, { contentType: 'image/png' }));
    const r = read(image({ tiers: [...bad, tier(256), tier(512)] }));
    expect(edges(r.image?.tiers)).toEqual([256, 512]);
  });
});

describe('readImageRows: a tier\'s numbers', () => {
  it.each([
    ['5120', 5120],
    [5120, 5120],
    ['0', 0],
    [undefined, 0],
    [null, 0],
    ['4294967295', 4294967295],
    ['4294967296', 0],
    ['99999999999999999999', 0],
    ['12.5', 0],
    ['-1', 0],
    [-1, 0],
    [12.5, 0],
    ['many', 0],
  ])('reads a byte size %s as %s (0 = unknown) and keeps the tier', (raw, expected) => {
    const r = read(image({ tiers: [tier(256, { bytes: raw })] }));
    expect(r.image?.tiers.map((t) => [t.longEdgePx, t.bytes])).toEqual([[256, expected]]);
  });

  it('reads whole numbers the spine sends as JSON numbers as it reads its digit tokens', () => {
    const r = read(image({ tiers: [tier(256, { longEdgePx: 256, width: 181, height: 256, bytes: 5120 })] }));
    expect(r.image?.tiers.map(plain)).toEqual([{ longEdgePx: 256, sha256: tierSha(256), width: 181, height: 256, bytes: 5120 }]);
  });
});

describe('the setting that drops tiers', () => {
  it('sends no tier of an image or of its mask when tiers are off, and everything else as before', () => {
    const img = image({ tiers: [tier(256), tier(850)], mask: spineMask({ tiers: [maskTier(256)] }) });
    const off = read(img, false);
    expect(off.image?.tiers).toEqual([]);
    expect(off.mask?.mask.tiers).toEqual([]);
    const on = read(img, true);
    expect(edges(on.image?.tiers)).toEqual([256, 850]);
    expect(edges(on.mask?.mask.tiers)).toEqual([256]);
    // Nothing but the tiers differs.
    on.image!.tiers = [];
    on.mask!.mask.tiers = [];
    expect(off).toEqual(on);
  });

  it('sends tiers by default', () => {
    expect(edges(read(image({ tiers: [tier(256)] })).image?.tiers)).toEqual([256]);
  });

  it.each([
    ['unset', {}],
    ['empty', { MEDIA_IMAGE_TIERS: '' }],
    ['blank', { MEDIA_IMAGE_TIERS: '  ' }],
    ['on', { MEDIA_IMAGE_TIERS: 'on' }],
  ])('MEDIA_IMAGE_TIERS %s sends tiers', (_label, env) => {
    expect(resolveImageTiers(env)).toBe(true);
  });

  it('MEDIA_IMAGE_TIERS=off drops them', () => {
    expect(resolveImageTiers({ MEDIA_IMAGE_TIERS: 'off' })).toBe(false);
  });

  it.each(['OFF', 'false', '0', 'no', 'true', ' off', 'off ', 'disabled'])(
    'refuses to start on MEDIA_IMAGE_TIERS=%j rather than guess which way a rollback switch points',
    (raw) => {
      expect(() => resolveImageTiers({ MEDIA_IMAGE_TIERS: raw })).toThrow(/^MEDIA_IMAGE_TIERS must be on or off$/);
    },
  );
});
