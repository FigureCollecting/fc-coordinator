// ============================================================================
// coordinator.v1.CatalogService — product display cards for the client
// (plan WK-07, contract coordinator/v1/catalog.proto).
//
// UNLIKE CompareService, THIS IS NOT A PASS-THROUGH. Compare hands the spine's
// result back byte for byte; a catalog answer is instead MAPPED onto a small
// typed ProductCard through an explicit allowlist. The reason is where the
// answer goes: a card is cached on the phone and replayed offline, bytes already
// on a phone cannot be revoked, and the spine's display record carries EVERY
// winning claim for the product — including keys that name a store's original
// image (imageUrl, images.url, ...) and keys nobody has registered at all. A
// card therefore carries exactly the fields in CARD_TEXT_ALLOWLIST and the
// GTIN-14s, and nothing else can reach it: there is no generic attribute bag to
// leak through.
//
// WHAT IT SHARES WITH COMPARE: the edge authenticates upstream of here; the
// entitlement assertion is minted SERVER-SIDE for the caller on every spine
// call and travels as metadata; a denial is not an error; the spine's error
// MESSAGE is never relayed.
//
// PAGING IS PASSED THROUGH one page to one page (catalog.proto): the spine's
// token is opaque and already bound to the ref list, and its first page alone
// carries `unresolved`. The coordinator neither follows nor rewrites tokens, so
// a client page is a spine page and the two can never disagree about position.
//
// IMAGES ARE OFF until a public media base is configured (MEDIA_PUBLIC_BASE_URL,
// unset by default — no derivative exists yet). Off means GetProductImages
// answers an empty page without asking the spine. On means a row is returned
// ONLY when its URL is exactly <base>/<derivative sha-256>.
// ============================================================================
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  CardTextSchema,
  CatalogService,
  GetProductImagesResponseSchema,
  GetProductsResponseSchema,
  ProductCardSchema,
  ProductImageSchema,
  ProductImagesSchema,
  ProductRefSchema,
  canonicalInstant,
  type CardText,
  type GetProductImagesRequest,
  type GetProductImagesResponse,
  type GetProductsRequest,
  type GetProductsResponse,
  type ProductCard,
  type ProductImage,
  type ProductImages,
  type ProductRef,
} from '@figurecollecting/fc-api-contract';
import { entitlementHeaderFor as defaultEntitlementHeaderFor } from '../entitlements/index.js';
import type { SpinePage, SpineProductRef } from '../spine/spineReadClient.js';
import { kCallerSubject } from './identity.js';

/** Refs (or head ids) one call may carry. More is INVALID_ARGUMENT, never truncated. */
export const MAX_CATALOG_REFS = 200;

/**
 * THE ALLOWLIST: every CardText field of a ProductCard, and the ONE place each
 * may come from. Nothing outside this table can reach a card.
 *
 *   display  a key of the spine's `display` projection — the spine has already
 *            layered its materialized columns over the winning claim there, so
 *            it is the authority for the value when it names one.
 *   claim    the attr_key of the winning claim that supplies (or dates) the
 *            value. A display value is dated by its claim ONLY when the claim
 *            supplied that exact value; otherwise as_of is empty, because the
 *            value came from a materialized column with no claim time.
 *
 * `contentLevel` is the key the MFC ruleset emits (fields.contentLevel); the
 * claim lifter keeps unmapped scraped keys verbatim, so that is the attr_key.
 * It is not the only adult-content key in the estate: see ADULT_FLAG_CLAIM.
 * test/connect/catalog-map.test.ts pins that this table names no key that could
 * carry an image, a URL or an original, and that it covers exactly the card's
 * CardText fields.
 */
export const CARD_TEXT_ALLOWLIST = {
  title: { display: 'name', claim: 'name' },
  manufacturer: { display: 'manufacturer', claim: 'manufacturer' },
  series: { display: 'originSeries', claim: 'origin_series' },
  character: { display: null, claim: 'character' },
  scale: { display: 'scale', claim: 'scale' },
  releaseYm: { display: 'releaseYm', claim: null },
  contentLevel: { display: null, claim: 'contentLevel' },
} as const satisfies Record<string, { display: string | null; claim: string | null }>;

/**
 * The content-level vocabulary catalog.proto names. Anything else reads as
 * `unknown`, which the contract tells every client to treat as the most
 * restrictive — an unrecognised level must never render as a permissive one.
 * See levelClaimOf for what counts as "anything else", and contentLevelOf for the r18 flag.
 */
export const CONTENT_LEVELS = [
  'general',
  'intermediate',
  'explicit',
  'controversial',
  'nsfw',
  'nsfw+',
  'unknown',
] as const;

/**
 * The attr_key gkloot and solaris record adult content under: their rulesets
 * emit `fields.r18` as a boolean, which the claim lifter keeps under the same
 * key as the text 'true' or 'false'. It is NOT a card field and never shows;
 * it can only make content_level stricter (see contentLevelOf).
 */
export const ADULT_FLAG_CLAIM = 'r18';

/**
 * The levels an adult flag agrees with: each already says 18+, or is `unknown`.
 * Any other level (general, intermediate) contradicted by the flag reads as
 * `unknown`. Listed by what they DO say, so a level added to CONTENT_LEVELS
 * later is overridden by the flag until someone places it here.
 */
const LEVELS_AN_ADULT_FLAG_KEEPS: readonly string[] = [
  'explicit',
  'controversial',
  'nsfw',
  'nsfw+',
  'unknown',
] satisfies readonly (typeof CONTENT_LEVELS)[number][];

const GTIN14 = /^\d{14}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const UINT32_MAX = 4_294_967_295;

/** The narrow slice of SpineReadClient this service needs; see compare.ts for why it is declared here. */
export interface SpineCatalog {
  getProducts(
    refs: readonly SpineProductRef[],
    nowIso: string,
    assertion: string | null,
    page: SpinePage,
  ): Promise<{ productsJson: string; nextPageToken: string }>;
  getProductImages(
    productIds: readonly string[],
    nowIso: string,
    assertion: string | null,
    page: SpinePage,
  ): Promise<{ imagesJson: string; nextPageToken: string }>;
}

export interface CatalogRoutesDeps {
  /** `null` = SPINE_READ_URL unset: every spine-backed call answers UNAVAILABLE. */
  spineRead: SpineCatalog | null;
  /** From resolveMediaBaseUrl. `null` = images off: GetProductImages answers empty. */
  mediaBaseUrl: string | null;
  /** Injectable for tests. Production uses the ported U6 module, as Compare does. */
  entitlementHeaderFor?: (subject: string) => Promise<string | null>;
  /** The read path's clock: the spine's now_iso is stamped here, never by the client. */
  now?: () => Date;
}

/**
 * Read MEDIA_PUBLIC_BASE_URL. Unset or blank -> null (images off, the default).
 * Set, it must be an absolute https URL with no credentials, no `?` or `#` (not
 * even an empty query or fragment), no surrounding whitespace, already in the
 * form a URL parser writes it (so no dot segments), and with no encoded slash
 * or backslash, or the process refuses to start: this string is prefixed onto
 * URLs that every phone caches forever, so a typo is better found at boot than
 * in the field. No refusal repeats the value, which may carry a credential.
 *
 * The spine builds each row's URL from ITS copy of the same value by trimming
 * trailing slashes and nothing else, and this module does exactly the same, so
 * the exact-match filter below compares like with like. Anything the spine
 * would NOT normalise the same way (whitespace) or that a phone would resolve
 * to another path (dot segments) is refused here rather than quietly dropping
 * every image or fetching from somewhere else.
 */
export function resolveMediaBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env['MEDIA_PUBLIC_BASE_URL'] ?? '';
  if (raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('MEDIA_PUBLIC_BASE_URL must be an absolute https URL');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || /[?#]/.test(raw)) {
    throw new Error('MEDIA_PUBLIC_BASE_URL must be https, with no credentials, query or fragment');
  }
  // One comparison covers whitespace (the parser strips it, the spine does
  // not), dot segments (the parser resolves them away) and every other
  // non-canonical spelling: what is compared is then what a phone fetches.
  const base = raw.replace(/\/+$/, '');
  if (url.href.replace(/\/+$/, '') !== base) {
    throw new Error(
      'MEDIA_PUBLIC_BASE_URL must be in canonical URL form, exactly as a URL parser writes it ' +
        '(e.g. a lower-case host, no default port, no backslash, no whitespace, no dot segments)',
    );
  }
  // Canonical by the URL standard, yet a CDN that decodes them could resolve
  // the path somewhere else.
  if (/%(?:2f|5c)/i.test(raw)) {
    throw new Error('MEDIA_PUBLIC_BASE_URL must not contain an encoded slash or backslash (%2F, %5C)');
  }
  return base;
}

// ---------------------------------------------------------------------------
// reading the spine's JSON
// ---------------------------------------------------------------------------
type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;

const nonEmpty = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

const parseObject = (json: string): Json | null => {
  try {
    return asObject(JSON.parse(json));
  } catch {
    return null;
  }
};

/** A claim time as a canonical instant, or '' — never the raw token, never a guess. */
const canonicalAsOf = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  try {
    return canonicalInstant(raw);
  } catch {
    return '';
  }
};

/**
 * The display text a winning claim supplies, and when. A term shows its label
 * and never its uuid; a json value is not display text; a kind this build has
 * never heard of shows nothing.
 */
function claimText(facet: unknown): { value: string; asOf: string } | null {
  const f = asObject(facet);
  if (f === null) return null;
  let value: string | null = null;
  if (f['kind'] === 'term') value = nonEmpty(f['label']);
  else if (f['kind'] === 'text' || f['kind'] === 'num' || f['kind'] === 'date') value = nonEmpty(f['value']);
  return value === null ? null : { value, asOf: canonicalAsOf(f['asOf']) };
}

/**
 * True when a display value is the bare uuid of a term the spine could not
 * label: its projection falls back `label ?? value`, so a label-less term
 * reaches a display-backed field as its uuid.
 */
function isUnlabelledTermId(facet: unknown, shown: string): boolean {
  const f = asObject(facet);
  return f !== null && f['kind'] === 'term' && nonEmpty(f['label']) === null && f['value'] === shown;
}

function cardText(
  display: Json,
  attrs: Json,
  spec: { display: string | null; claim: string | null },
): CardText | undefined {
  const facet = spec.claim === null ? undefined : attrs[spec.claim];
  const claim = claimText(facet);
  if (spec.display !== null) {
    const shown = nonEmpty(display[spec.display]);
    if (shown === null || isUnlabelledTermId(facet, shown)) return undefined;
    return create(CardTextSchema, { value: shown, asOf: claim !== null && claim.value === shown ? claim.asOf : '' });
  }
  return claim === null ? undefined : create(CardTextSchema, claim);
}

/**
 * The `contentLevel` claim as a level: absent when there is no such claim;
 * otherwise the value when it is one of CONTENT_LEVELS exactly (no trimming, no
 * case folding), and `unknown` for anything else this build cannot read (a
 * label-less term, a json value, an empty or non-string value, a kind it has
 * never heard of, not an object at all). Dated by the claim when it has a time.
 */
function levelClaimOf(facet: unknown): CardText | undefined {
  if (facet === undefined) return undefined;
  const read = claimText(facet);
  const known = read !== null && (CONTENT_LEVELS as readonly string[]).includes(read.value);
  return create(CardTextSchema, {
    value: known ? read.value : 'unknown',
    asOf: canonicalAsOf(asObject(facet)?.['asOf']),
  });
}

/**
 * The card's content level. Absent means "the source has no level concept"
 * (catalog.proto), which a client treats permissively, so it is absent ONLY
 * when the claims can be read and hold neither a `contentLevel` claim nor an
 * ADULT_FLAG_CLAIM that could be set. Every other case is `unknown`, the
 * contract's most restrictive value, or a level at least as strict:
 *
 *   attrs not an object      unknown, no time: the claims cannot be seen, so
 *                            nothing says there is no level among them.
 *   r18 absent, or reading   the contentLevel claim as levelClaimOf reads it
 *   exactly 'false'          (absent when there is none).
 *   r18 any other claim      the level when it is in LEVELS_AN_ADULT_FLAG_KEEPS;
 *   ('true', unreadable)     otherwise unknown, dated by the r18 claim.
 *
 * r18 'false' leaves the level as it was: whether it should read as `general`
 * is a product call, not made here.
 */
function contentLevelOf(rawAttrs: unknown): CardText | undefined {
  const attrs = asObject(rawAttrs);
  if (attrs === null) return create(CardTextSchema, { value: 'unknown', asOf: '' });
  const level = levelClaimOf(attrs[CARD_TEXT_ALLOWLIST.contentLevel.claim]);
  const flag = attrs[ADULT_FLAG_CLAIM];
  if (flag === undefined || claimText(flag)?.value === 'false') return level;
  if (level !== undefined && LEVELS_AN_ADULT_FLAG_KEEPS.includes(level.value)) return level;
  return create(CardTextSchema, { value: 'unknown', asOf: canonicalAsOf(asObject(flag)?.['asOf']) });
}

/** A read.v1 ref, as the spine echoes it, in coordinator.v1 spelling; null for anything else. */
function coordinatorRef(value: unknown): ProductRef | null {
  const ref = asObject(value);
  if (ref === null) return null;
  const productId = nonEmpty(ref['productId']);
  if (productId !== null) return create(ProductRefSchema, { ref: { case: 'headId', value: productId } });
  const gtin14 = nonEmpty(ref['gtin14']);
  if (gtin14 !== null) return create(ProductRefSchema, { ref: { case: 'gtin14', value: gtin14 } });
  const item = asObject(ref['sourceItem']);
  const site = nonEmpty(item?.['site']);
  const nativeId = nonEmpty(item?.['nativeId']);
  if (site === null || nativeId === null) return null;
  return create(ProductRefSchema, { ref: { case: 'sourceItem', value: { site, nativeId } } });
}

const refList = (value: unknown): ProductRef[] =>
  (Array.isArray(value) ? value : []).map(coordinatorRef).filter((r): r is ProductRef => r !== null);

/**
 * One spine ProductRecord -> one ProductCard, through the allowlist. `null`
 * when the record names no product: a card without a head cannot be keyed,
 * and dropping it silently would make the client's row count lie.
 */
export function toProductCard(record: unknown): ProductCard | null {
  const r = asObject(record);
  const headId = nonEmpty(r?.['productId']);
  if (r === null || headId === null) return null;
  const display = asObject(r['display']) ?? {};
  const attrs = asObject(r['attrs']) ?? {};

  const text = (field: keyof typeof CARD_TEXT_ALLOWLIST): CardText | undefined =>
    cardText(display, attrs, CARD_TEXT_ALLOWLIST[field]);

  const gtin14s: string[] = [];
  for (const id of Array.isArray(r['identifiers']) ? r['identifiers'] : []) {
    const gtin = asObject(id)?.['gtin14'];
    if (typeof gtin === 'string' && GTIN14.test(gtin) && !gtin14s.includes(gtin)) gtin14s.push(gtin);
  }

  return create(ProductCardSchema, {
    headId,
    requestedAs: refList(r['requestedAs']),
    title: text('title'),
    manufacturer: text('manufacturer'),
    series: text('series'),
    character: text('character'),
    scale: text('scale'),
    releaseYm: text('releaseYm'),
    gtin14s,
    contentLevel: contentLevelOf(r['attrs']),
    // The spine's display record carries no derivative; GetProductImages does.
    derivativeIds: [],
  });
}

/** products_json -> cards + unresolved refs, or null when it cannot be read whole. */
export function readProductsPayload(json: string): { products: ProductCard[]; unresolved: ProductRef[] } | null {
  const payload = parseObject(json);
  const products = payload?.['products'];
  const unresolved = payload?.['unresolved'] ?? [];
  if (!Array.isArray(products) || !Array.isArray(unresolved)) return null;
  const cards: ProductCard[] = [];
  for (const record of products) {
    const card = toProductCard(record);
    if (card === null) return null;
    cards.push(card);
  }
  return { products: cards, unresolved: refList(unresolved) };
}

/** A raw pixel-size token as a uint32; 0 when unknown or not a whole number in range. */
const pixels = (raw: unknown): number => {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return n <= UINT32_MAX ? n : 0;
};

/**
 * images_json -> the rows a client may fetch, or null when it cannot be read.
 *
 * A row survives ONLY when its derivative id is a lowercase sha-256 AND the
 * spine served it at exactly `${mediaBaseUrl}/${id}`. Exact, not a prefix: a
 * prefix test admits `<base>/../originals/x` and `<base>/<id>?raw=1`, and an
 * original's URL is precisely the thing that must never reach a phone. A
 * product left with no rows is omitted, as the contract says.
 */
export function readImagesPayload(json: string, mediaBaseUrl: string): ProductImages[] | null {
  const products = parseObject(json)?.['products'];
  if (!Array.isArray(products)) return null;
  const out: ProductImages[] = [];
  for (const entry of products) {
    const product = asObject(entry);
    const headId = nonEmpty(product?.['productId']);
    const rows = product?.['images'];
    if (headId === null || !Array.isArray(rows)) return null;
    const images: ProductImage[] = [];
    for (const row of rows) {
      const img = asObject(row);
      const id = img?.['derivativeSha256'];
      if (img === null || typeof id !== 'string' || !SHA256_HEX.test(id)) continue;
      const url = `${mediaBaseUrl}/${id}`;
      if (img['url'] !== url) continue;
      images.push(
        create(ProductImageSchema, {
          derivativeId: id,
          role: typeof img['role'] === 'string' ? img['role'] : '',
          primary: img['primary'] === true,
          contentType: typeof img['contentType'] === 'string' ? img['contentType'] : '',
          width: pixels(img['width']),
          height: pixels(img['height']),
          url,
        }),
      );
    }
    if (images.length > 0) out.push(create(ProductImagesSchema, { headId, images }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// request validation — all of it before anything leaves the process
// ---------------------------------------------------------------------------
const invalid = (message: string): ConnectError => new ConnectError(message, Code.InvalidArgument);

function boundBatch(size: number, what: string): void {
  if (size === 0) throw invalid(`${what} must not be empty`);
  if (size > MAX_CATALOG_REFS) throw invalid(`at most ${MAX_CATALOG_REFS} ${what} per call`);
}

const blank = (value: string): boolean => value.trim() === '';

/** coordinator.v1 refs -> read.v1 refs, or INVALID_ARGUMENT for any ref that names nothing. */
function spineRefs(refs: readonly ProductRef[]): SpineProductRef[] {
  boundBatch(refs.length, 'refs');
  return refs.map((r) => {
    const ref = r.ref;
    if (ref.case === 'headId' && !blank(ref.value)) return { productId: ref.value };
    if (ref.case === 'gtin14' && !blank(ref.value)) return { gtin14: ref.value };
    if (ref.case === 'sourceItem' && !blank(ref.value.site) && !blank(ref.value.nativeId)) {
      return { sourceItem: { site: ref.value.site, nativeId: ref.value.nativeId } };
    }
    throw invalid('each ref must set exactly one of head_id, gtin14 or source_item (site and native_id), non-blank');
  });
}

function headIds(ids: readonly string[]): string[] {
  boundBatch(ids.length, 'head_ids');
  if (ids.some(blank)) throw invalid('head_ids must not contain a blank id');
  return [...ids];
}

/**
 * A spine failure, as the client may see it. INVALID_ARGUMENT is relayed —
 * everything sent was validated above except the opaque page token, so it means
 * the token was not issued for this batch, and calling that UNAVAILABLE would
 * tell the client to retry a request that can never succeed. Everything else is
 * UNAVAILABLE. Never the upstream message: it routinely carries connection
 * detail.
 */
function relay(err: unknown): ConnectError {
  if (err instanceof ConnectError && err.code === Code.InvalidArgument) {
    return invalid('the spine refused the request: send a page_token only with the batch it was issued for');
  }
  return new ConnectError('spine read is unavailable', Code.Unavailable, undefined, undefined, err);
}

const unreadable = (what: string): ConnectError =>
  new ConnectError(`spine returned a ${what} payload that could not be read`, Code.Internal);

// ---------------------------------------------------------------------------
// the service
// ---------------------------------------------------------------------------
export function createCatalogRoutes(deps: CatalogRoutesDeps): (router: ConnectRouter) => void {
  const mint = deps.entitlementHeaderFor ?? ((subject: string) => defaultEntitlementHeaderFor(subject));
  const now = deps.now ?? (() => new Date());

  const spine = (): SpineCatalog => {
    if (deps.spineRead === null) throw new ConnectError('spine read is not configured', Code.Unavailable);
    return deps.spineRead;
  };
  // null subject -> no Check, no mint, no header: the spine redacts, nothing errors.
  const assertionFor = async (ctx: HandlerContext): Promise<string | null> => {
    const subject = ctx.values.get(kCallerSubject);
    return subject === null ? null : mint(subject);
  };

  const getProducts = async (request: GetProductsRequest, ctx: HandlerContext): Promise<GetProductsResponse> => {
    const refs = spineRefs(request.refs);
    const client = spine();
    const assertion = await assertionFor(ctx);

    let upstream: { productsJson: string; nextPageToken: string };
    try {
      upstream = await client.getProducts(refs, now().toISOString(), assertion, {
        pageSize: request.pageSize,
        pageToken: request.pageToken,
      });
    } catch (err) {
      throw relay(err);
    }

    const read = readProductsPayload(upstream.productsJson);
    if (read === null) throw unreadable('products');
    return create(GetProductsResponseSchema, { ...read, nextPageToken: upstream.nextPageToken });
  };

  const getProductImages = async (
    request: GetProductImagesRequest,
    ctx: HandlerContext,
  ): Promise<GetProductImagesResponse> => {
    const ids = headIds(request.headIds);
    // Images off: nothing to show, so nothing to ask — not even OpenFGA.
    if (deps.mediaBaseUrl === null) return create(GetProductImagesResponseSchema, {});
    const client = spine();
    const assertion = await assertionFor(ctx);

    let upstream: { imagesJson: string; nextPageToken: string };
    try {
      upstream = await client.getProductImages(ids, now().toISOString(), assertion, {
        pageSize: request.pageSize,
        pageToken: request.pageToken,
      });
    } catch (err) {
      throw relay(err);
    }

    const products = readImagesPayload(upstream.imagesJson, deps.mediaBaseUrl);
    if (products === null) throw unreadable('images');
    return create(GetProductImagesResponseSchema, { products, nextPageToken: upstream.nextPageToken });
  };

  const searchProducts = async (): Promise<never> => {
    throw new ConnectError('SearchProducts is not served yet (WK-17)', Code.Unimplemented);
  };

  return (router: ConnectRouter) => {
    router.service(CatalogService, { getProducts, getProductImages, searchProducts });
  };
}
