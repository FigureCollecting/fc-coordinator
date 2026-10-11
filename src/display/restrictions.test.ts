// ADDR-1: catalog.proto DISPLAY RESTRICTIONS (Ross, 2026-09-26; orchestrator ruling 2026-10-09), run
// against the contract's own golden cases (golden/display-vectors.json): every case through
// decideDisplay, every list through displayList. The evaluator is the one place a restriction is
// decided; GetProductImages and ProductCard.derivative_ids reach it through src/connect/catalog.ts.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_LEVELS,
  DISPLAY_SCOPES,
  VIEWER_CONTEXTS,
  decideDisplay,
  displayList,
  foldAsciiCase,
  PrimaryPromoter,
  restrictionApplies,
  type DisplayRestriction,
  type ImageFacts,
  type ViewerContext,
} from './restrictions.js';

const require = createRequire(import.meta.url);

interface VImage {
  image_id: string;
  product_ids: string[];
  sources: string[];
  has_mask: boolean;
  has_own_alpha: boolean;
}
interface VRestriction {
  rule: string;
  level: string;
  subject: string;
  scope: string;
}
interface VCase {
  name: string;
  image: VImage;
  restrictions: VRestriction[];
  context: ViewerContext;
  expect: {
    image: boolean;
    mask: boolean;
    grounding_from: 'mask' | 'own_alpha' | 'unset';
    appearance_masked: boolean;
    denials: { rule: string; scope: string }[];
  };
}
interface VListImage extends VImage {
  role: string;
  primary: boolean;
}
interface VList {
  name: string;
  images: VListImage[];
  restrictions: VRestriction[];
  context: ViewerContext;
  expect: { images: { image_id: string; role: string; primary: boolean }[] };
}
interface Vectors {
  contexts: string[];
  levels: string[];
  scopes: Record<string, { withholds: string; from: string[] }>;
  cases: VCase[];
  lists: VList[];
}

const v = JSON.parse(
  readFileSync(require.resolve('@figurecollecting/fc-api-contract/golden/display-vectors.json'), 'utf8'),
) as Vectors;

const facts = (i: VImage): ImageFacts => ({
  imageId: i.image_id,
  productIds: i.product_ids,
  sources: i.sources,
  hasMask: i.has_mask,
  hasOwnAlpha: i.has_own_alpha,
});
const restrictions = (rs: VRestriction[]): DisplayRestriction[] => rs.map((r) => ({ ...r }));

describe('golden display vectors: the vocabulary', () => {
  it('names the contract\'s three contexts, three levels and four scopes, exactly', () => {
    expect([...VIEWER_CONTEXTS]).toEqual(v.contexts);
    expect([...DISPLAY_LEVELS]).toEqual(v.levels);
    expect(Object.fromEntries([...DISPLAY_SCOPES].map(([k, s]) => [k, { withholds: s.withholds, from: [...s.from] }]))).toEqual(v.scopes);
  });

  it('carries 51 cases and 9 lists, so a vector file that lost cases cannot pass quietly', () => {
    expect(v.cases).toHaveLength(51);
    expect(v.lists).toHaveLength(9);
  });
});

describe('golden display vectors: every case', () => {
  it.each(v.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const got = decideDisplay(facts(c.image), restrictions(c.restrictions), c.context);
    expect({
      image: got.image,
      mask: got.mask,
      grounding_from: got.groundingFrom,
      appearance_masked: got.appearanceMasked,
      denials: got.denials,
    }).toEqual(c.expect);
  });
});

describe('golden display vectors: every list', () => {
  it.each(v.lists.map((l) => [l.name, l] as const))('%s', (_name, l) => {
    const got = displayList(
      l.images.map((i) => ({ facts: facts(i), primary: i.primary, role: i.role })),
      restrictions(l.restrictions),
      l.context,
    );
    expect(got.map((g) => ({ image_id: g.entry.facts.imageId, role: g.entry.role, primary: g.primary }))).toEqual(l.expect.images);
  });
});

describe('beyond the vectors: what the coordinator cannot know fails closed', () => {
  const img: ImageFacts = { imageId: 'img-a', productIds: ['p-head'], sources: null, hasMask: true, hasOwnAlpha: false };

  it('applies a source restriction to an image whose sources the spine did not send', () => {
    const r = { rule: 'r1', level: 'source', subject: 'hlj', scope: 'no_display' };
    expect(restrictionApplies(r, img)).toBe(true);
    expect(decideDisplay(img, [r], 'owner')).toMatchObject({ image: false, denials: [{ rule: 'r1', scope: 'no_display' }] });
  });

  it('applies an unrecognised level to such an image too, and still not a product or image restriction on other ids', () => {
    expect(restrictionApplies({ rule: 'r1', level: 'Source', subject: 'hlj', scope: 'no_share' }, img)).toBe(true);
    expect(restrictionApplies({ rule: 'r1', level: 'product', subject: 'p-other', scope: 'no_share' }, img)).toBe(false);
    expect(restrictionApplies({ rule: 'r1', level: 'image', subject: 'img-b', scope: 'no_share' }, img)).toBe(false);
  });

  it('withholds nothing from the owner for a source no_share it cannot place: the scope still decides', () => {
    expect(decideDisplay(img, [{ rule: 'r1', level: 'source', subject: 'hlj', scope: 'no_share' }], 'owner')).toMatchObject({ image: true, mask: true, denials: [] });
  });
});

describe('ASCII case folding', () => {
  it('folds A-Z and nothing else', () => {
    expect(foldAsciiCase('ABCxyz-0_ÉK')).toBe('abcxyz-0_ÉK');
  });
});

describe('PrimaryPromoter across pages', () => {
  it('promotes the first shown image of a product whose primary was withheld on an earlier page', () => {
    const first = new PrimaryPromoter([]);
    expect(first.admit('h1', true, false)).toBeNull();
    expect(first.pending()).toEqual(['h1']);
    const second = new PrimaryPromoter(first.pending());
    expect(second.admit('h2', false, true)).toBe(false);
    expect(second.admit('h1', false, true)).toBe(true);
    expect(second.admit('h1', false, true)).toBe(false);
    expect(second.pending()).toEqual([]);
  });

  it('keeps a shown primary and never promotes for a product the spine sent without one', () => {
    const p = new PrimaryPromoter([]);
    expect(p.admit('h1', true, true)).toBe(true);
    expect(p.admit('h1', false, true)).toBe(false);
    expect(p.admit('h2', false, false)).toBeNull();
    expect(p.admit('h2', false, true)).toBe(false);
    expect(p.pending()).toEqual([]);
  });
});
