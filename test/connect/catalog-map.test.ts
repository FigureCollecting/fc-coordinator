/**
 * The CatalogService MAPPERS, as pure functions: spine JSON in, coordinator.v1
 * messages out. test/connect/catalog.test.ts drives the same code end to end;
 * this file pins the edges a fake spine has no reason to produce — odd facet
 * kinds, junk identifiers, a malformed image row — and the allowlist ITSELF.
 */
import { describe, expect, it } from 'vitest';
import { ProductCardSchema } from '@figurecollecting/fc-api-contract';
import {
  CARD_TEXT_ALLOWLIST,
  CONTENT_LEVELS,
  MAX_CATALOG_REFS,
  readImagesPayload,
  readProductsPayload,
  resolveMediaBaseUrl,
  toProductCard,
} from '../../src/connect/catalog.js';
import { CANNED_HEAD_ID, cannedProductRecord } from '../helpers/fakeSpineRead.js';

const MEDIA = 'https://images.figurecollecting.test/d';
const SHA = 'c'.repeat(64);

/** Any key that could name an image, a URL, or a store's original. */
const IMAGE_OR_ORIGINAL = /image|img|url|uri|href|src|photo|picture|thumb|original|media/i;

const facet = (over: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'text',
  value: 'v',
  asOf: '2026-09-01 10:00:00+00',
  ...over,
});

const record = (attrs: Record<string, unknown>, display: Record<string, unknown> = {}): Record<string, unknown> => ({
  productId: CANNED_HEAD_ID,
  requestedAs: [],
  display,
  identifiers: [],
  attrs,
});

describe('the allowlist itself', () => {
  it('names no key that could carry an image URL or an original', () => {
    for (const [field, spec] of Object.entries(CARD_TEXT_ALLOWLIST)) {
      for (const key of [spec.display, spec.claim]) {
        if (key !== null) expect(`${field}:${key}`).not.toMatch(IMAGE_OR_ORIGINAL);
      }
    }
  });

  it('covers exactly the CardText fields a ProductCard has, no more and no fewer', () => {
    const cardTextFields = ProductCardSchema.fields
      .filter((f) => f.message?.typeName === 'coordinator.v1.CardText')
      .map((f) => f.localName)
      .sort();
    expect(Object.keys(CARD_TEXT_ALLOWLIST).sort()).toEqual(cardTextFields);
  });

  it('pins the batch bound the contract states as a number', () => {
    expect(MAX_CATALOG_REFS).toBe(200);
  });
});

describe('toProductCard — values', () => {
  it('maps the canned record, dropping the image URLs, the unknown key and the gated key', () => {
    const card = toProductCard(cannedProductRecord([{ gtin14: '04573102591234' }], true));
    const json = JSON.stringify(card);
    expect(card?.headId).toBe(CANNED_HEAD_ID);
    expect(json).not.toContain('images.store.example');
    expect(json).not.toContain('SHOULD-NEVER-SHIP');
    expect(json).not.toContain('stockOnHand');
    expect(card?.title?.value).toBe('Hatsune Miku Symphony 2025 Ver.');
  });

  it.each([
    ['a term, through its label', facet({ kind: 'term', value: 'f3d9c0de-0000-4000-8000-000000000001', label: 'Hatsune Miku' }), 'Hatsune Miku'],
    ['a number', facet({ kind: 'num', value: '7' }), '7'],
    ['a date', facet({ kind: 'date', value: '2026-03-01' }), '2026-03-01'],
  ])('reads a claim-only field from %s', (_label, f, expected) => {
    expect(toProductCard(record({ character: f }))?.character?.value).toBe(expected);
  });

  it.each([
    ['a term with no label (never a bare term uuid)', facet({ kind: 'term', value: 'f3d9c0de-0000-4000-8000-000000000001' })],
    ['a json value', facet({ kind: 'json', value: null, json: { a: 1 } })],
    ['a kind nobody has defined', facet({ kind: 'blob', value: 'x' })],
    ['an empty value', facet({ value: '' })],
    ['a non-string value', facet({ value: 7 })],
    ['a facet that is not an object', 'Hatsune Miku'],
  ])('leaves a claim-only field ABSENT for %s', (_label, f) => {
    expect(toProductCard(record({ character: f }))?.character).toBeUndefined();
  });

  it('never shows a bare term uuid that the projection fell back to for a label-less term', () => {
    // The spine's display projection is `label ?? value`, so a term whose label
    // it could not resolve arrives as its uuid on a display-backed field.
    const uuid = '0d6f6e1a-1111-4222-8333-444455556666';
    const card = toProductCard(
      record(
        {
          manufacturer: facet({ kind: 'term', value: uuid }),
          name: facet({ kind: 'term', value: uuid, label: '' }),
          origin_series: facet({ kind: 'term', value: uuid, label: 'Vocaloid' }),
          scale: facet({ kind: 'text', value: uuid }),
        },
        { manufacturer: uuid, name: uuid, originSeries: uuid, scale: uuid },
      ),
    );
    expect(card?.manufacturer).toBeUndefined();
    expect(card?.title).toBeUndefined();
    // Not a bare uuid: the display value names a label that came from elsewhere,
    // or a text claim that simply is that string.
    expect(card?.series).toMatchObject({ value: uuid, asOf: '' });
    expect(card?.scale).toMatchObject({ value: uuid, asOf: '2026-09-01T10:00:00.000000Z' });
  });

  // Each display-backed field is guarded on its own: origin_series and scale
  // are term axes too, and the projection falls back to the uuid for both.
  it.each([
    ['series', 'origin_series', 'originSeries'],
    ['scale', 'scale', 'scale'],
  ] as const)('drops %s when it is the bare uuid of a label-less term', (field, claim, shown) => {
    const uuid = '0d6f6e1a-1111-4222-8333-444455556666';
    const card = toProductCard(record({ [claim]: facet({ kind: 'term', value: uuid }) }, { [shown]: uuid }));
    expect(card?.[field]).toBeUndefined();
  });

  // Only a TERM falls back to its uuid. A number or a date that the display
  // shows verbatim is the value itself, and is kept and dated by its claim.
  it.each([
    ['a number', facet({ kind: 'num', value: '7' }), '7'],
    ['a date', facet({ kind: 'date', value: '2026-03-01' }), '2026-03-01'],
  ])('keeps a display value supplied verbatim by %s claim', (_label, f, shown) => {
    expect(toProductCard(record({ scale: f }, { scale: shown }))?.scale).toMatchObject({
      value: shown,
      asOf: '2026-09-01T10:00:00.000000Z',
    });
  });

  it('keeps a display value that differs from a label-less term (a materialized column)', () => {
    const card = toProductCard(
      record(
        { manufacturer: facet({ kind: 'term', value: '0d6f6e1a-1111-4222-8333-444455556666' }) },
        { manufacturer: 'Good Smile Company' },
      ),
    );
    expect(card?.manufacturer).toMatchObject({ value: 'Good Smile Company', asOf: '' });
  });

  it('leaves a display field absent when the projection has no usable value', () => {
    const card = toProductCard(record({ name: facet({ value: 'n' }) }, { name: 42, manufacturer: '' }));
    expect(card?.title).toBeUndefined();
    expect(card?.manufacturer).toBeUndefined();
  });

  it('reads a missing display or attrs object as no display fields rather than failing the card', () => {
    const card = toProductCard({ productId: CANNED_HEAD_ID, display: 'x', attrs: null });
    expect(card?.headId).toBe(CANNED_HEAD_ID);
    expect(card?.title).toBeUndefined();
    expect(card?.character).toBeUndefined();
  });
});

describe('toProductCard — as_of', () => {
  it('dates a display value with its claim only when the claim supplied that value', () => {
    const card = toProductCard(
      record(
        { name: facet({ value: 'Same', asOf: '2026-09-01 10:00:00.25-05' }), scale: facet({ value: '1/8' }) },
        { name: 'Same', scale: '1/7' },
      ),
    );
    expect(card?.title).toMatchObject({ value: 'Same', asOf: '2026-09-01T15:00:00.250000Z' });
    expect(card?.scale).toMatchObject({ value: '1/7', asOf: '' });
  });

  it.each([
    ['unparseable', 'yesterday'],
    ['impossible', '2026-13-45 99:00:00+00'],
    ['absent', undefined],
  ])('is empty, never raw, when the claim time is %s', (_label, asOf) => {
    const card = toProductCard(record({ character: facet({ value: 'Miku', asOf }) }));
    expect(card?.character).toMatchObject({ value: 'Miku', asOf: '' });
  });
});

describe('toProductCard — content_level', () => {
  // Written out, not read from CONTENT_LEVELS: iterating the implementation's
  // own list would delete a level's test case along with the level.
  const CONTRACT_LEVELS = ['general', 'intermediate', 'explicit', 'controversial', 'nsfw', 'nsfw+', 'unknown'];

  it('knows exactly the seven levels catalog.proto names', () => {
    expect([...CONTENT_LEVELS]).toEqual(CONTRACT_LEVELS);
  });

  it.each(CONTRACT_LEVELS.map((l) => [l]))('passes the contract value %s through', (level) => {
    expect(toProductCard(record({ contentLevel: facet({ value: level }) }))?.contentLevel?.value).toBe(level);
  });

  it.each([['R18'], ['General'], ['sfw'], [' general'], ['general '], ['nsfw\n']])(
    'reads an unrecognised level %s as unknown, the most restrictive, keeping its time',
    (level) => {
      const card = toProductCard(record({ contentLevel: facet({ value: level }) }));
      expect(card?.contentLevel).toMatchObject({ value: 'unknown', asOf: '2026-09-01T10:00:00.000000Z' });
    },
  );

  it('is absent when the source has no level concept', () => {
    expect(toProductCard(record({}))?.contentLevel).toBeUndefined();
  });

  // FAIL CLOSED. A level the source HAS but this build cannot read is still a
  // level: absent would tell the client "no level concept", which it treats
  // permissively.
  it.each([
    ['a term with no label', facet({ kind: 'term', value: '0d6f6e1a-1111-4222-8333-444455556666' })],
    ['a json value', facet({ kind: 'json', value: null, json: { level: 'nsfw' } })],
    ['an empty value', facet({ value: '' })],
    ['a kind nobody has defined', facet({ kind: 'blob', value: 'nsfw' })],
    ['a non-string value', facet({ value: 18 })],
  ])('reads a level claim it cannot read (%s) as unknown, keeping its time', (_label, f) => {
    expect(toProductCard(record({ contentLevel: f }))?.contentLevel).toMatchObject({
      value: 'unknown',
      asOf: '2026-09-01T10:00:00.000000Z',
    });
  });

  it.each([
    ['not an object', 'nsfw'],
    ['null', null],
  ])('reads a level claim that is %s as unknown, with no time to give', (_label, f) => {
    expect(toProductCard(record({ contentLevel: f }))?.contentLevel).toMatchObject({ value: 'unknown', asOf: '' });
  });

  // When the claims cannot be read at all, nothing says the record has no
  // level claim, so absent (the permissive reading) is not available.
  it.each([
    ['missing', undefined],
    ['null', null],
    ['a list', [{ key: 'contentLevel', kind: 'text', value: 'nsfw' }]],
    ['a string', 'contentLevel=nsfw'],
  ])('reads the level as unknown when attrs is %s', (_label, attrs) => {
    const raw = { productId: CANNED_HEAD_ID, display: { name: 'X' }, ...(attrs === undefined ? {} : { attrs }) };
    const card = toProductCard(raw);
    expect(card?.title?.value).toBe('X');
    expect(card?.contentLevel).toMatchObject({ value: 'unknown', asOf: '' });
  });
});

// gkloot and solaris record their adult flag as attr_key `r18` (the lifter
// turns the boolean into the text 'true' or 'false'), never as contentLevel.
describe('toProductCard — content_level from the r18 adult flag', () => {
  const R18_AS_OF = '2026-09-02 11:00:00+00';
  const R18_AS_OF_UTC = '2026-09-02T11:00:00.000000Z';
  const r18 = (over: Record<string, unknown> = {}): Record<string, unknown> =>
    facet({ value: 'true', asOf: R18_AS_OF, ...over });

  it('reads an R18 product with no level claim as unknown, dated by the r18 claim', () => {
    expect(toProductCard(record({ r18: r18() }))?.contentLevel).toMatchObject({
      value: 'unknown',
      asOf: R18_AS_OF_UTC,
    });
  });

  it('leaves the level absent when the r18 claim reads false and there is no level claim', () => {
    // r18=false -> absent is the pre-existing reading, held until Ross rules
    // whether it should mean general.
    expect(toProductCard(record({ r18: r18({ value: 'false' }) }))?.contentLevel).toBeUndefined();
  });

  // FAIL CLOSED on the flag too: only a literal 'false' clears it.
  it.each([
    ['upper case', r18({ value: 'TRUE' })],
    ['padded false', r18({ value: ' false' })],
    ['capitalised false', r18({ value: 'False' })],
    ['a number', r18({ kind: 'num', value: '0' })],
    ['an empty value', r18({ value: '' })],
    ['a json value', r18({ kind: 'json', value: null, json: false })],
    ['a term with no label', r18({ kind: 'term', value: '0d6f6e1a-1111-4222-8333-444455556666' })],
    ['a kind nobody has defined', r18({ kind: 'blob', value: 'false' })],
  ])('reads an r18 claim it cannot read as false (%s) as unknown', (_label, f) => {
    expect(toProductCard(record({ r18: f }))?.contentLevel).toMatchObject({ value: 'unknown', asOf: R18_AS_OF_UTC });
  });

  it.each([
    ['not an object', 'true'],
    ['null', null],
  ])('reads an r18 claim that is %s as unknown, with no time to give', (_label, f) => {
    expect(toProductCard(record({ r18: f }))?.contentLevel).toMatchObject({ value: 'unknown', asOf: '' });
  });

  // A level that says less than adult, contradicted by an adult flag: the
  // stricter statement wins, as the contract's most restrictive value.
  it.each([['general'], ['intermediate']])('overrides a %s level claim with unknown when r18 is true', (level) => {
    expect(toProductCard(record({ contentLevel: facet({ value: level }), r18: r18() }))?.contentLevel).toMatchObject({
      value: 'unknown',
      asOf: R18_AS_OF_UTC,
    });
  });

  // A level that already says adult (or unknown) agrees with the flag and keeps its own time.
  it.each([['explicit'], ['controversial'], ['nsfw'], ['nsfw+'], ['unknown']])(
    'keeps a %s level claim when r18 is true',
    (level) => {
      expect(toProductCard(record({ contentLevel: facet({ value: level }), r18: r18() }))?.contentLevel).toMatchObject({
        value: level,
        asOf: '2026-09-01T10:00:00.000000Z',
      });
    },
  );

  it('keeps a general level claim when r18 reads false', () => {
    expect(
      toProductCard(record({ contentLevel: facet({ value: 'general' }), r18: r18({ value: 'false' }) }))?.contentLevel,
    ).toMatchObject({ value: 'general', asOf: '2026-09-01T10:00:00.000000Z' });
  });
});

describe('toProductCard — identifiers and refs', () => {
  it('keeps only well-formed GTIN-14s, once each, in order', () => {
    const card = toProductCard({
      ...record({}),
      identifiers: [
        { idType: 'jan', gtin14: '04573102591234' },
        { idType: 'source_native', value: '1144', gtin14: null },
        { idType: 'jan', gtin14: '4573102591234' },
        { idType: 'jan', gtin14: '045731025912345' },
        { idType: 'jan', gtin14: 'x04573102591234' },
        { idType: 'jan', gtin14: '04573102591234x' },
        'junk',
        { idType: 'upc', gtin14: '00012345678905' },
        { idType: 'jan', gtin14: '04573102591234' },
      ],
    });
    expect(card?.gtin14s).toEqual(['04573102591234', '00012345678905']);
  });

  it('tolerates identifiers and requestedAs that are not lists', () => {
    const card = toProductCard({ ...record({}), identifiers: {}, requestedAs: 'x' });
    expect(card?.gtin14s).toEqual([]);
    expect(card?.requestedAs).toEqual([]);
  });

  it('maps requestedAs back to coordinator spellings and skips what it cannot read', () => {
    const card = toProductCard({
      ...record({}),
      requestedAs: [
        { productId: 'p-1' },
        { gtin14: '04573102591234' },
        { sourceItem: { site: 'mfc', nativeId: '1144' } },
        { sourceItem: { site: 'mfc' } },
        { sourceItem: 'mfc:1144' },
        { productId: '' },
        { somethingElse: 'x' },
        null,
      ],
    });
    expect(card?.requestedAs.map((r) => r.ref)).toEqual([
      { case: 'headId', value: 'p-1' },
      { case: 'gtin14', value: '04573102591234' },
      { case: 'sourceItem', value: expect.objectContaining({ site: 'mfc', nativeId: '1144' }) },
    ]);
  });

  it.each([
    ['no productId', { display: {} }],
    ['an empty productId', { productId: '' }],
    ['a non-string productId', { productId: 7 }],
    ['not an object', 'product'],
  ])('refuses a record with %s', (_label, value) => {
    expect(toProductCard(value)).toBeNull();
  });
});

describe('readProductsPayload', () => {
  it('reads products and unresolved, and treats an absent unresolved as none', () => {
    const read = readProductsPayload(JSON.stringify({ products: [record({})] }));
    expect(read?.products).toHaveLength(1);
    expect(read?.unresolved).toEqual([]);
  });

  it('refuses a payload with a product it cannot identify', () => {
    expect(readProductsPayload(JSON.stringify({ products: [record({}), { productId: null }] }))).toBeNull();
  });
});

describe('readImagesPayload', () => {
  const image = (over: Record<string, unknown>): Record<string, unknown> => ({
    role: 'gallery',
    primary: false,
    derivativeSha256: SHA,
    url: `${MEDIA}/${SHA}`,
    ...over,
  });
  const read = (images: unknown, productId: unknown = CANNED_HEAD_ID) =>
    readImagesPayload(JSON.stringify({ products: [{ productId, images }], coverage: {} }), MEDIA);

  it('keeps a derivative served exactly at <base>/<derivative id>', () => {
    expect(read([image({})])?.[0]?.images.map((i) => i.url)).toEqual([`${MEDIA}/${SHA}`]);
  });

  it.each([
    ['an original under another host', image({ url: 'https://images.store.example/originals/1.jpg' })],
    ['the right host but a different path', image({ url: `https://images.figurecollecting.test/originals/${SHA}` })],
    ['a url that only STARTS with the base', image({ url: `${MEDIA}/${SHA}?raw=1` })],
    ['a traversal under the base', image({ url: `${MEDIA}/../originals/${SHA}` })],
    ['no url at all', image({ url: undefined })],
    ['a derivative id that is not a sha-256', image({ derivativeSha256: 'abc', url: `${MEDIA}/abc` })],
    ['an upper-case derivative id', image({ derivativeSha256: SHA.toUpperCase(), url: `${MEDIA}/${SHA.toUpperCase()}` })],
    // The id check is the ONLY guard on the id half of `<base>/<id>`: in each of
    // these the url and the id agree, so the exact-url test admits them all.
    ['an id with a traversal prefix', image({ derivativeSha256: `../originals/${SHA}`, url: `${MEDIA}/../originals/${SHA}` })],
    ['an id with a query suffix', image({ derivativeSha256: `${SHA}?raw=1`, url: `${MEDIA}/${SHA}?raw=1` })],
    ['an id with a path suffix', image({ derivativeSha256: `${SHA}/../../originals/x.jpg`, url: `${MEDIA}/${SHA}/../../originals/x.jpg` })],
    ['an id of 65 hex digits', image({ derivativeSha256: `${SHA}c`, url: `${MEDIA}/${SHA}c` })],
    ['a row that is not an object', 'https://images.figurecollecting.test/d/x'],
  ])('drops %s, and the product with it when nothing is left', (_label, row) => {
    expect(read([row])).toEqual([]);
  });

  it.each([
    ['1200', 1200],
    ['0', 0],
    [null, 0],
    ['12.5', 0],
    ['-3', 0],
    ['4294967295', 4294967295],
    ['4294967296', 0],
    [800, 0],
  ])('reads a pixel size %s as %s', (raw, expected) => {
    expect(read([image({ width: raw, height: raw })])?.[0]?.images[0]).toMatchObject({
      width: expected,
      height: expected,
    });
  });

  it('defaults role and content type to empty, and primary to false unless it is literally true', () => {
    const [first, second] = read([
      image({ role: 7, contentType: null, primary: 'true' }),
      image({ role: 'primary', contentType: 'image/webp', primary: true }),
    ])![0]!.images;
    expect(first).toMatchObject({ role: '', contentType: '', primary: false });
    expect(second).toMatchObject({ role: 'primary', contentType: 'image/webp', primary: true });
  });

  it.each([
    ['not JSON', '{'],
    ['products not a list', '{"products":{}}'],
    ['a product that is not an object', '{"products":["p"]}'],
    ['a product with no productId', `{"products":[{"images":[]}]}`],
    ['a product whose images are not a list', `{"products":[{"productId":"${CANNED_HEAD_ID}","images":{}}]}`],
  ])('refuses a payload that is %s', (_label, body) => {
    expect(readImagesPayload(body, MEDIA)).toBeNull();
  });
});

describe('resolveMediaBaseUrl', () => {
  it.each([
    ['unset', {}],
    ['empty', { MEDIA_PUBLIC_BASE_URL: '' }],
    ['blank', { MEDIA_PUBLIC_BASE_URL: '   ' }],
  ])('is null (images off) when %s', (_label, env) => {
    expect(resolveMediaBaseUrl(env)).toBeNull();
  });

  it.each([
    ['https://images.figurecollecting.com/d', 'https://images.figurecollecting.com/d'],
    ['https://images.figurecollecting.com/d/', 'https://images.figurecollecting.com/d'],
    ['https://images.figurecollecting.com//', 'https://images.figurecollecting.com'],
    ['https://images.figurecollecting.com', 'https://images.figurecollecting.com'],
  ])('normalises %s the way the spine does, by trimming trailing slashes and nothing else', (raw, expected) => {
    expect(resolveMediaBaseUrl({ MEDIA_PUBLIC_BASE_URL: raw })).toBe(expected);
  });

  it.each([
    ['plain http', 'http://images.figurecollecting.com/d'],
    ['not a URL', 'images.figurecollecting.com/d'],
    ['a query string', 'https://images.figurecollecting.com/d?sig=1'],
    ['a fragment', 'https://images.figurecollecting.com/d#x'],
    ['credentials', 'https://user:pass@images.figurecollecting.com/d'],
    ['a user name alone', 'https://user@images.figurecollecting.com/d'],
    ['a password alone', 'https://:pass@images.figurecollecting.com/d'],
    // URL.search and URL.hash are '' for an EMPTY query or fragment.
    ['an empty query', 'https://images.figurecollecting.com/d?'],
    ['an empty fragment', 'https://images.figurecollecting.com/d#'],
    ['an empty query and fragment after a slash', 'https://images.figurecollecting.com/d/?#'],
    // A dot segment resolves away: the phone would fetch from somewhere else.
    ['a dot-dot segment', 'https://images.figurecollecting.com/d/..'],
    ['an encoded dot-dot segment', 'https://images.figurecollecting.com/d/%2e%2e'],
    ['a dot segment mid-path', 'https://images.figurecollecting.com/./d'],
    // The spine trims trailing slashes only; with whitespace around it the two
    // sides would build different URLs and every image would be dropped.
    ['surrounding whitespace', ' https://images.figurecollecting.com/d '],
    ['a trailing newline', 'https://images.figurecollecting.com/d/\n'],
    ['a spelling the parser rewrites (an upper-case host)', 'https://IMAGES.figurecollecting.com/d'],
    // Canonical by the URL standard, but a CDN that decodes them could resolve
    // the path somewhere else.
    ['an encoded slash', 'https://images.figurecollecting.com/d%2F..'],
    ['an encoded slash in lower case', 'https://images.figurecollecting.com/d%2f'],
    ['an encoded backslash', 'https://images.figurecollecting.com/d%5C'],
    ['an encoded backslash in lower case', 'https://images.figurecollecting.com/d%5c'],
  ])('refuses %s at boot, rather than shipping it to every phone', (_label, raw) => {
    expect(() => resolveMediaBaseUrl({ MEDIA_PUBLIC_BASE_URL: raw })).toThrow(/MEDIA_PUBLIC_BASE_URL/);
  });

  it.each([
    ['an upper-case host', 'https://IMAGES.figurecollecting.com/d'],
    ['the default port', 'https://images.figurecollecting.com:443/d'],
    ['a backslash', 'https://images.figurecollecting.com/d\\x'],
    ['a dot segment', 'https://images.figurecollecting.com/d/..'],
  ])('names canonical URL form, not only whitespace and dot segments, when refusing %s', (_label, raw) => {
    expect(() => resolveMediaBaseUrl({ MEDIA_PUBLIC_BASE_URL: raw })).toThrow(/canonical URL form/);
  });

  // A boot error lands in the pod log: it must never carry the value it refuses.
  it.each([
    ['credentials', 'https://svc:s3cr3t@images.figurecollecting.com/d'],
    ['an unparseable value', 's3cr3t images.figurecollecting.com/d'],
    ['a non-canonical value', 'https://images.figurecollecting.com/s3cr3t/../d'],
    ['an encoded slash', 'https://images.figurecollecting.com/s3cr3t%2Fd'],
  ])('never echoes the refused value for %s', (_label, raw) => {
    let message = '';
    try {
      resolveMediaBaseUrl({ MEDIA_PUBLIC_BASE_URL: raw });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/^MEDIA_PUBLIC_BASE_URL /);
    expect(message).not.toContain('s3cr3t');
  });
});
