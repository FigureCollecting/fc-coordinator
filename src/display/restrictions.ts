// ============================================================================
// DISPLAY RESTRICTIONS — the one place a restriction is decided (fc-api-contract
// 0.4.0 catalog.proto DISPLAY RESTRICTIONS; Ross, 2026-09-26; orchestrator
// ruling 2026-10-09; golden/display-vectors.json has the cases).
//
// Every image and its mask are shown to every viewer by default. A restriction
// (rule, level image|product|source, subject, scope) only WITHHOLDS: each one
// that applies to the image and whose scope covers the viewer context withholds
// what its scope names, so what a viewer is denied is the union, whatever the
// level. Restrictions are data (src/display/source.ts reads them), never code.
//
// FAIL CLOSED, three ways:
//   * an unrecognised scope (recognised ONLY as a key of DISPLAY_SCOPES, a Map,
//     so "constructor" and "__proto__" are not keys) withholds the image from
//     every context;
//   * an unrecognised level applies when its subject matches the image's id, any
//     id that resolves to its head, or any of its sources;
//   * an image whose sources the spine did not send (`sources: null`) is treated
//     as captured from EVERY source: a source restriction, or an unrecognised
//     level, applies to it. The coordinator cannot prove the image is not from
//     the restricted store, so it does not show it where the scope says not to.
//
// Subjects match ids without regard to ASCII case: A-Z matches a-z and no other
// character is case-folded (the Kelvin sign is not a k).
// ============================================================================

export type ViewerContext = 'owner' | 'share_link' | 'anonymous';
export const VIEWER_CONTEXTS: readonly ViewerContext[] = Object.freeze(['owner', 'share_link', 'anonymous'] as const);

export const DISPLAY_LEVELS = Object.freeze(['image', 'product', 'source'] as const);
type Level = (typeof DISPLAY_LEVELS)[number];

export interface ScopeRule {
  readonly withholds: 'image' | 'mask';
  readonly from: readonly ViewerContext[];
}

export const DISPLAY_SCOPES: ReadonlyMap<string, ScopeRule> = new Map<string, ScopeRule>([
  ['no_display', { withholds: 'image', from: ['owner', 'share_link', 'anonymous'] }],
  ['owner_views_only', { withholds: 'image', from: ['share_link', 'anonymous'] }],
  ['no_share', { withholds: 'image', from: ['share_link', 'anonymous'] }],
  ['no_mask', { withholds: 'mask', from: ['owner', 'share_link', 'anonymous'] }],
]);

export interface DisplayRestriction {
  readonly rule: string;
  readonly level: string;
  readonly subject: string;
  readonly scope: string;
}

export interface ImageFacts {
  /** The image's own id: on this surface, its derivative's content address. */
  readonly imageId: string;
  /** Every id that resolves to the image's head, the head first. */
  readonly productIds: readonly string[];
  /** Every source the image was captured from; null = not known (fails closed). */
  readonly sources: readonly string[] | null;
  readonly hasMask: boolean;
  readonly hasOwnAlpha: boolean;
}

export interface Denial {
  readonly rule: string;
  readonly scope: string;
}

export type GroundingFrom = 'mask' | 'own_alpha' | 'unset';

export interface DisplayDecision {
  /** The caller is sent the image. */
  readonly image: boolean;
  /** The caller is sent its mask (false when it has none or the image is withheld). */
  readonly mask: boolean;
  /** What bottom_margin_frac and contact_band are measured on for this caller. */
  readonly groundingFrom: GroundingFrom;
  /** thumbhash and dominant_color are computed with the mask applied. */
  readonly appearanceMasked: boolean;
  /** The rules that withheld something the image has, sorted by rule id; empty = log at debug only. */
  readonly denials: readonly Denial[];
}

/** A-Z to a-z; every other code unit untouched. */
export function foldAsciiCase(text: string): string {
  return text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

const isKnownLevel = (level: string): level is Level => (DISPLAY_LEVELS as readonly string[]).includes(level);

const matchesAny = (subject: string, ids: readonly string[]): boolean => ids.some((id) => foldAsciiCase(id) === subject);

/** Whether the restriction's subject names this image at its level. */
export function restrictionApplies(r: DisplayRestriction, img: ImageFacts): boolean {
  const subject = foldAsciiCase(r.subject);
  const bySource = img.sources === null ? true : matchesAny(subject, img.sources);
  if (!isKnownLevel(r.level)) {
    return foldAsciiCase(img.imageId) === subject || matchesAny(subject, img.productIds) || bySource;
  }
  switch (r.level) {
    case 'image':
      return foldAsciiCase(img.imageId) === subject;
    case 'product':
      return matchesAny(subject, img.productIds);
    case 'source':
      return bySource;
  }
}

/** What the restriction withholds from this context: 'image', 'mask' or nothing. */
function withheldBy(r: DisplayRestriction, context: ViewerContext): 'image' | 'mask' | null {
  const scope = DISPLAY_SCOPES.get(r.scope);
  if (scope === undefined) return 'image';
  return scope.from.includes(context) ? scope.withholds : null;
}

const byRule = (a: Denial, b: Denial): number => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0);
const denialsOf = (rs: readonly DisplayRestriction[]): Denial[] => rs.map((r) => ({ rule: r.rule, scope: r.scope })).sort(byRule);

export function decideDisplay(img: ImageFacts, restrictions: readonly DisplayRestriction[], context: ViewerContext): DisplayDecision {
  const applicable = restrictions.filter((r) => restrictionApplies(r, img));
  const imageRules = applicable.filter((r) => withheldBy(r, context) === 'image');
  if (imageRules.length > 0) {
    return { image: false, mask: false, groundingFrom: 'unset', appearanceMasked: false, denials: denialsOf(imageRules) };
  }
  const maskRules = applicable.filter((r) => withheldBy(r, context) === 'mask');
  const mask = img.hasMask && maskRules.length === 0;
  return {
    image: true,
    mask,
    groundingFrom: mask ? 'mask' : img.hasOwnAlpha ? 'own_alpha' : 'unset',
    appearanceMasked: mask,
    denials: img.hasMask ? denialsOf(maskRules) : [],
  };
}

/**
 * The primary, as a list reads once withheld images are gone. When a product's
 * primary is withheld, the first image of that product shown to the caller is
 * sent as the primary, on whatever page it falls: `pending` carries the
 * products still owed one from page to page. A product the spine sent with no
 * primary is sent with none.
 */
export class PrimaryPromoter {
  private readonly owed: Set<string>;

  constructor(pending: readonly string[]) {
    this.owed = new Set(pending);
  }

  /** The primary flag to send for a shown image, or null for a withheld one. */
  admit(headId: string, primary: boolean, shown: boolean): boolean | null {
    if (!shown) {
      if (primary) this.owed.add(headId);
      return null;
    }
    if (this.owed.delete(headId)) return true;
    return primary;
  }

  pending(): string[] {
    return [...this.owed];
  }
}

export interface ListEntry {
  readonly facts: ImageFacts;
  readonly primary: boolean;
}

/** One product's list for one viewer: withheld images dropped, a withheld primary replaced. */
export function displayList<T extends ListEntry>(
  entries: readonly T[],
  restrictions: readonly DisplayRestriction[],
  context: ViewerContext,
): { entry: T; primary: boolean; decision: DisplayDecision }[] {
  const promoter = new PrimaryPromoter([]);
  const out: { entry: T; primary: boolean; decision: DisplayDecision }[] = [];
  for (const entry of entries) {
    const decision = decideDisplay(entry.facts, restrictions, context);
    const primary = promoter.admit(entry.facts.productIds[0] ?? '', entry.primary, decision.image);
    if (primary !== null) out.push({ entry, primary, decision });
  }
  return out;
}
