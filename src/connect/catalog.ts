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
// SEARCH IS A PASS-THROUGH OF THE SAME KIND (WK-17). SearchProducts sends the
// query to read.v1 SpineRead.SearchProducts AS TYPED (the spine normalizes it
// and binds its keyset token to its own form), forwards one page for one page,
// and maps each hit through the same allowlist as GetProducts. Only what the
// contract states as a number is checked here first: an empty query, and one
// over 256 code points in the NFKC-normalized, White_Space-trimmed form (a raw
// query too long ever to come within 256 is refused before it is normalized).
// The page size is capped at 50 on the way out, and a spine page over 50 is
// refused rather than truncated. A spine refusal of a STALE token (ErrorInfo
// TOKEN_EXPIRED_OR_REBASED in figurecollecting.com) reaches the client as
// INVALID_ARGUMENT carrying that same (domain, reason) pair, rebuilt here;
// nothing else of the spine's error does.
//
// IMAGES ARE OFF until a public media base is configured (MEDIA_PUBLIC_BASE_URL,
// unset by default — no derivative exists yet). Off means GetProductImages
// answers an empty page without asking the spine. On means a row is returned
// ONLY when its URL is exactly <base>/<derivative sha-256>.
//
// GetProductImages IS THE IMAGE-LIST CHOKEPOINT (ADDR-1, catalog.proto DISPLAY
// RESTRICTIONS) and the one exception to page pass-through. Every row is
// decided for the caller's viewer context (owner: every CatalogService call)
// by src/display/restrictions.ts against the restriction set of the moment
// (src/display/source.ts; unreadable = UNAVAILABLE, never an unevaluated
// image). A withheld row, like a row not under the media base, is dropped
// BEFORE the page is cut: the coordinator reads on into the spine's next pages
// to fill one (at most MAX_SPINE_IMAGE_READS spine reads per call) and, when it
// stops part-way through a spine page or owes a product its primary, hands the
// client its OWN token ("c1." + base64url JSON {s: the spine token of the page
// it stopped in, k: rows of that page already read, p: products owed a
// primary}). With nothing to carry, the spine's token goes back unchanged. The
// spine's image tokens are base64url and never contain a ".", so the two
// cannot be confused. A withheld primary is replaced by the first image of its
// product shown to the caller, on whatever page it falls; a restriction is
// never named, and every denial is logged with its rules.
// ============================================================================
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import { decideDisplay, PrimaryPromoter, type DisplayDecision, type ViewerContext } from '../display/restrictions.js';
import { NO_DISPLAY_RESTRICTIONS, type DisplayRestrictionSet, type DisplayRestrictionSource, type HeadResolver } from '../display/source.js';
import { create } from '@bufbuild/protobuf';
import { BinaryReader, BinaryWriter, WireType } from '@bufbuild/protobuf/wire';
import {
  CardTextSchema,
  CatalogService,
  GetProductImagesResponseSchema,
  GetProductsResponseSchema,
  ProductCardSchema,
  ProductImageSchema,
  ProductImagesSchema,
  ProductRefSchema,
  SearchProductsResponseSchema,
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
  type SearchProductsRequest,
  type SearchProductsResponse,
} from '@figurecollecting/fc-api-contract';
import { entitlementHeaderFor as defaultEntitlementHeaderFor } from '../entitlements/index.js';
import type { SpinePage, SpineProductRef } from '../spine/spineReadClient.js';
import { kCallerSubject } from './identity.js';

/** Refs (or head ids) one call may carry. More is INVALID_ARGUMENT, never truncated. */
export const MAX_CATALOG_REFS = 200;

/** Hits one SearchProducts page may carry: a larger page_size is served at 50 (catalog.proto, read.proto 0.9.0). */
export const MAX_SEARCH_PAGE = 50;

/** A query's bound in code points, counted in the NFKC-normalized, trimmed form (read.proto 0.9.0). */
export const MAX_SEARCH_QUERY_CHARS = 256;

/**
 * The longest raw query, in UTF-16 units after the White_Space trim, that is
 * normalized at all: 256 x 18 x 2 = 9,216. NFKC never drops a code point,
 * never turns one that is not White_Space into only White_Space, and composes
 * at most 4 into one (U+1F82 is the longest canonical decomposition), so a raw
 * query over 9,216 units, at least 4,609 code points, normalizes to at least
 * 1,153: never within 256. Refusing it unread bounds what NFKC is
 * given, which is quadratic in a run of combining marks it must reorder; 18 is
 * NFKC's largest expansion (U+FDFA), so its output is at most 165,888 points.
 */
export const MAX_RAW_SEARCH_QUERY_UNITS = MAX_SEARCH_QUERY_CHARS * 18 * 2;

/** The (domain, reason) pair read.proto 0.9.0 names for a search token issued before a ranking or encoding change. */
export const STALE_SEARCH_TOKEN = { reason: 'TOKEN_EXPIRED_OR_REBASED', domain: 'figurecollecting.com' } as const;

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
  searchProducts(
    query: string,
    nowIso: string,
    assertion: string | null,
    page: SpinePage,
  ): Promise<{ productsJson: string; nextPageToken: string }>;
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
  /** The display restrictions of the moment. Production: the display_restriction table. */
  restrictions?: DisplayRestrictionSource;
  /** Where a display decision is logged; registerConnect points it at the app's logger. */
  displayLog?: DisplayLog;
  /**
   * The viewer context every row is decided for. Default owner: every CatalogService call is the
   * signed-in user in their own views (catalog.proto). A surface that serves these lists to a share
   * link or to anyone sets its own; the golden lists run through here in each of the three.
   */
  viewerContext?: ViewerContext;
}

/** A denial at info with its rules; an evaluation that withheld nothing at debug. */
export type DisplayLog = (level: 'info' | 'debug', event: DisplayEvent, message: string) => void;

export interface DisplayEvent {
  image_id: string;
  head_id: string;
  context: ViewerContext;
  withheld: 'image' | 'mask' | null;
  sources_known: boolean;
  denials: { rule: string; scope: string }[];
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

/**
 * products_json of a search page -> cards, or null when it cannot be read whole
 * or carries more hits than a page may. Each hit goes through toProductCard, as
 * a GetProducts record does, and names no ref: this request sent none, so a ref
 * the spine echoed would tell the client it asked for something it did not.
 */
export function readSearchPayload(json: string): ProductCard[] | null {
  const products = parseObject(json)?.['products'];
  if (!Array.isArray(products) || products.length > MAX_SEARCH_PAGE) return null;
  const cards: ProductCard[] = [];
  for (const record of products) {
    const card = toProductCard(record);
    if (card === null) return null;
    card.requestedAs = [];
    cards.push(card);
  }
  return cards;
}

/** A raw pixel-size token as a uint32; 0 when unknown or not a whole number in range. */
const pixels = (raw: unknown): number => {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return n <= UINT32_MAX ? n : 0;
};

/** One spine image row, in the spine's order: the derivative a client may fetch, or null when it may not. */
export interface ImageRow {
  headId: string;
  /** null = not a derivative under the media base: never sent, and a primary so lost is replaced. */
  image: ProductImage | null;
  /** The spine marked the row its product's primary. */
  primary: boolean;
  /** The sources the spine says the image was captured from; null = not sent or unreadable. */
  sources: string[] | null;
}

/**
 * images_json -> every row in the spine's order, or null when it cannot be read.
 *
 * A row's image is kept ONLY when its derivative id is a lowercase sha-256 AND
 * the spine served it at exactly `${mediaBaseUrl}/${id}`. Exact, not a prefix: a
 * prefix test admits `<base>/../originals/x` and `<base>/<id>?raw=1`, and an
 * original's URL is precisely the thing that must never reach a phone. Rows
 * whose image is null still count as rows: a page is cut by its position in
 * the spine's page.
 */
export function readImageRows(json: string, mediaBaseUrl: string): ImageRow[] | null {
  const products = parseObject(json)?.['products'];
  if (!Array.isArray(products)) return null;
  const out: ImageRow[] = [];
  for (const entry of products) {
    const product = asObject(entry);
    const headId = nonEmpty(product?.['productId']);
    const rows = product?.['images'];
    if (headId === null || !Array.isArray(rows)) return null;
    for (const row of rows) {
      const img = asObject(row);
      out.push({
        headId,
        image: img === null ? null : toProductImage(img, mediaBaseUrl),
        primary: img?.['primary'] === true,
        sources: img === null ? null : sourcesOf(img['sources']),
      });
    }
  }
  return out;
}

function toProductImage(img: Json, mediaBaseUrl: string): ProductImage | null {
  const id = img['derivativeSha256'];
  if (typeof id !== 'string' || !SHA256_HEX.test(id)) return null;
  const url = `${mediaBaseUrl}/${id}`;
  if (img['url'] !== url) return null;
  return create(ProductImageSchema, {
    derivativeId: id,
    role: typeof img['role'] === 'string' ? img['role'] : '',
    primary: img['primary'] === true,
    contentType: typeof img['contentType'] === 'string' ? img['contentType'] : '',
    width: pixels(img['width']),
    height: pixels(img['height']),
    url,
  });
}

/** A list of strings, or null: anything else is read as "not known", which fails closed. */
const sourcesOf = (raw: unknown): string[] | null =>
  Array.isArray(raw) && raw.every((x): x is string => typeof x === 'string') ? raw : null;

/** The most GetProducts pages one resolution may read for one batch: a spine that never ends is a fault. */
export const MAX_RESOLVE_PAGES = 10;

/**
 * Product ids -> the head each resolves to today, through the spine's ER (GetProducts with head_id
 * refs, merged ids included). For the display restrictions only: no entitlement assertion is
 * minted, since nothing gated is read. An id the spine does not resolve is absent from the map.
 */
export function spineHeadResolver(spineRead: SpineCatalog | null, now: () => Date = () => new Date()): HeadResolver {
  return async (ids) => {
    if (spineRead === null) throw new Error('spine read is not configured');
    const heads = new Map<string, string>();
    for (let i = 0; i < ids.length; i += MAX_CATALOG_REFS) {
      const refs = ids.slice(i, i + MAX_CATALOG_REFS).map((productId) => ({ productId }));
      let pageToken = '';
      for (let pages = 0; ; pages += 1) {
        if (pages === MAX_RESOLVE_PAGES) throw new Error(`spine GetProducts did not end within ${MAX_RESOLVE_PAGES} pages`);
        const res = await spineRead.getProducts(refs, now().toISOString(), null, { pageSize: MAX_CATALOG_REFS, pageToken });
        const read = readProductsPayload(res.productsJson);
        if (read === null) throw new Error('spine GetProducts payload could not be read');
        for (const card of read.products) {
          for (const ref of card.requestedAs) if (ref.ref.case === 'headId') heads.set(ref.ref.value, card.headId);
        }
        pageToken = res.nextPageToken;
        if (pageToken === '') break;
      }
    }
    return heads;
  };
}

// ---------------------------------------------------------------------------
// the image page token (see the header): the spine's own, or the coordinator's
// ---------------------------------------------------------------------------
export const MAX_SPINE_IMAGE_READS = 4;
const DEFAULT_IMAGE_PAGE = 50;
const MAX_IMAGE_PAGE = 200;
const IMAGE_TOKEN_PREFIX = 'c1.';

interface ImageCursor {
  /** The spine token of the page to read ('' = the first). */
  s: string;
  /** Rows of that page already read. */
  k: number;
  /** Products owed a primary. */
  p: string[];
}

const badToken = (): ConnectError => invalid('page_token was not issued for this batch');

function decodeImageToken(token: string): ImageCursor {
  if (!token.startsWith(IMAGE_TOKEN_PREFIX)) return { s: token, k: 0, p: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token.slice(IMAGE_TOKEN_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw badToken();
  }
  const c = asObject(parsed);
  const { s, k, p } = c ?? {};
  if (
    typeof s !== 'string' ||
    typeof k !== 'number' || !Number.isSafeInteger(k) || k < 0 ||
    !Array.isArray(p) || p.length > MAX_CATALOG_REFS || !p.every((h) => typeof h === 'string')
  ) {
    throw badToken();
  }
  return { s, k, p: p as string[] };
}

function encodeImageToken(c: ImageCursor): string {
  if (c.k === 0 && c.p.length === 0) return c.s;
  return IMAGE_TOKEN_PREFIX + Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

const imagePageSize = (requested: number): number =>
  requested === 0 ? DEFAULT_IMAGE_PAGE : Math.min(requested, MAX_IMAGE_PAGE);

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

/** One Unicode White_Space character: String.prototype.trim also strips U+FEFF and keeps U+0085. */
const WHITE_SPACE = /^\p{White_Space}$/u;

/**
 * Leading and trailing White_Space removed by walking in from each end, so the
 * cost is linear in the query. A regex anchored at both ends backtracks
 * quadratically over an interior run, and this runs before the 256 bound on
 * the one event loop every service shares. Every White_Space character is a
 * single UTF-16 unit, so stepping by unit is stepping by character.
 */
function trimWhiteSpace(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && WHITE_SPACE.test(text[start]!)) start += 1;
  while (end > start && WHITE_SPACE.test(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

/**
 * The query, checked in the form read.proto 0.9.0 counts it in (NFKC, then
 * White_Space trimmed) and returned AS TYPED: that form is the spine's to make.
 */
function searchQuery(query: string): string {
  const tooLong = (): ConnectError => invalid(`query must not exceed ${MAX_SEARCH_QUERY_CHARS} characters`);
  if (trimWhiteSpace(query).length > MAX_RAW_SEARCH_QUERY_UNITS) throw tooLong();
  const form = trimWhiteSpace(query.normalize('NFKC'));
  if (form === '') throw invalid('query must not be empty or only whitespace');
  if (longerThan(form, MAX_SEARCH_QUERY_CHARS)) throw tooLong();
  return query;
}

/** Whether the text has more than max code points, counted only until it does: no array of the whole query. */
function longerThan(text: string, max: number): boolean {
  let points = 0;
  for (const _ of text) {
    points += 1;
    if (points > max) return true;
  }
  return false;
}

const ERROR_INFO_TYPE = 'google.rpc.ErrorInfo';

/** google.rpc.ErrorInfo's reason (1) and domain (2), read by hand; null when the bytes do not decode. */
function readErrorInfo(bytes: Uint8Array): { reason: string; domain: string } | null {
  try {
    const reader = new BinaryReader(bytes);
    const info = { reason: '', domain: '' };
    while (reader.pos < reader.len) {
      const [field, wireType] = reader.tag();
      if (field === 1) info.reason = reader.string();
      else if (field === 2) info.domain = reader.string();
      else reader.skip(wireType);
    }
    return info;
  } catch {
    return null;
  }
}

const isStaleSearchToken = (err: ConnectError): boolean =>
  err.details.some((detail) => {
    if (!('type' in detail) || detail.type !== ERROR_INFO_TYPE) return false;
    const info = readErrorInfo(detail.value);
    return info?.reason === STALE_SEARCH_TOKEN.reason && info.domain === STALE_SEARCH_TOKEN.domain;
  });

/**
 * A spine failure on SearchProducts, as the client may see it. The stale-token
 * refusal keeps its (domain, reason) pair, rebuilt from the constant so none of
 * the spine's ErrorInfo metadata rides along; any other INVALID_ARGUMENT stays
 * INVALID_ARGUMENT under a neutral message (it may come on page one, where no
 * token was sent, so it names none); everything else is UNAVAILABLE.
 */
function relaySearch(err: unknown): ConnectError {
  if (err instanceof ConnectError && err.code === Code.InvalidArgument) {
    if (!isStaleSearchToken(err)) {
      return invalid('the spine refused the search request');
    }
    const stale = invalid('the page_token is stale: restart the search from page one');
    stale.details.push({
      type: ERROR_INFO_TYPE,
      value: new BinaryWriter()
        .tag(1, WireType.LengthDelimited)
        .string(STALE_SEARCH_TOKEN.reason)
        .tag(2, WireType.LengthDelimited)
        .string(STALE_SEARCH_TOKEN.domain)
        .finish(),
    });
    return stale;
  }
  return relay(err);
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

  const restrictionSource = deps.restrictions ?? NO_DISPLAY_RESTRICTIONS;
  const displayLog: DisplayLog = deps.displayLog ?? (() => {});
  // Every CatalogService call is the signed-in user in their own views (catalog.proto).
  const context: ViewerContext = deps.viewerContext ?? 'owner';

  const logDecision = (row: ImageRow, image: ProductImage, decision: DisplayDecision): void => {
    const withheld = !decision.image ? 'image' : decision.denials.length > 0 ? 'mask' : null;
    const event: DisplayEvent = {
      image_id: image.derivativeId,
      head_id: row.headId,
      context,
      withheld,
      sources_known: row.sources !== null,
      denials: decision.denials.map((d) => ({ rule: d.rule, scope: d.scope })),
    };
    if (withheld === null) displayLog('debug', event, 'display evaluated');
    else displayLog('info', event, 'display restriction withheld');
  };

  const decide = (row: ImageRow, set: DisplayRestrictionSet): boolean => {
    if (row.image === null) return false;
    const decision = decideDisplay(
      {
        imageId: row.image.derivativeId,
        productIds: set.productIdsFor(row.headId),
        sources: row.sources,
        // Neither is on the spine's row yet, so no mask is sent and none is withheld.
        hasMask: false,
        hasOwnAlpha: false,
      },
      set.restrictions,
      context,
    );
    logDecision(row, row.image, decision);
    return decision.image;
  };

  const getProductImages = async (
    request: GetProductImagesRequest,
    ctx: HandlerContext,
  ): Promise<GetProductImagesResponse> => {
    const ids = headIds(request.headIds);
    // Images off: nothing to show, so nothing to ask — not even OpenFGA.
    if (deps.mediaBaseUrl === null) return create(GetProductImagesResponseSchema, {});
    const mediaBaseUrl = deps.mediaBaseUrl;
    let cursor = decodeImageToken(request.pageToken);
    const client = spine();
    let set: DisplayRestrictionSet;
    try {
      set = await restrictionSource.current();
    } catch {
      // No restriction set, no image: never an unevaluated list.
      throw new ConnectError('display restrictions are unavailable', Code.Unavailable);
    }
    const assertion = await assertionFor(ctx);
    const want = imagePageSize(request.pageSize);
    const promoter = new PrimaryPromoter(cursor.p);
    const products: ProductImages[] = [];
    let count = 0;

    for (let reads = 1; ; reads += 1) {
      let upstream: { imagesJson: string; nextPageToken: string };
      try {
        upstream = await client.getProductImages(ids, now().toISOString(), assertion, {
          pageSize: want,
          pageToken: cursor.s,
        });
      } catch (err) {
        throw relay(err);
      }
      const rows = readImageRows(upstream.imagesJson, mediaBaseUrl);
      if (rows === null) throw unreadable('images');

      for (let j = cursor.k; j < rows.length; j += 1) {
        if (count === want) {
          return create(GetProductImagesResponseSchema, {
            products,
            nextPageToken: encodeImageToken({ s: cursor.s, k: j, p: promoter.pending() }),
          });
        }
        const row = rows[j]!;
        const primary = promoter.admit(row.headId, row.primary, decide(row, set));
        if (primary === null) continue;
        const image = row.image!;
        image.primary = primary;
        const last = products[products.length - 1];
        if (last !== undefined && last.headId === row.headId) last.images.push(image);
        else products.push(create(ProductImagesSchema, { headId: row.headId, images: [image] }));
        count += 1;
      }

      if (upstream.nextPageToken === '') return create(GetProductImagesResponseSchema, { products, nextPageToken: '' });
      cursor = { s: upstream.nextPageToken, k: 0, p: [] };
      if (count === want || reads >= MAX_SPINE_IMAGE_READS) {
        return create(GetProductImagesResponseSchema, {
          products,
          nextPageToken: encodeImageToken({ s: cursor.s, k: 0, p: promoter.pending() }),
        });
      }
    }
  };

  const searchProducts = async (
    request: SearchProductsRequest,
    ctx: HandlerContext,
  ): Promise<SearchProductsResponse> => {
    const query = searchQuery(request.query);
    const client = spine();
    const assertion = await assertionFor(ctx);

    let upstream: { productsJson: string; nextPageToken: string };
    try {
      upstream = await client.searchProducts(query, now().toISOString(), assertion, {
        pageSize: Math.min(request.pageSize, MAX_SEARCH_PAGE),
        pageToken: request.pageToken,
      });
    } catch (err) {
      throw relaySearch(err);
    }

    const products = readSearchPayload(upstream.productsJson);
    if (products === null) throw unreadable('search');
    return create(SearchProductsResponseSchema, { products, nextPageToken: upstream.nextPageToken });
  };

  return (router: ConnectRouter) => {
    router.service(CatalogService, { getProducts, getProductImages, searchProducts });
  };
}
