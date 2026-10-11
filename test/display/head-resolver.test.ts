// ADDR-1: a product restriction on a merged id covers the survivor (catalog.proto DISPLAY RESTRICTIONS).
// The coordinator asks the spine which head each product subject names today, through GetProducts.
import { describe, expect, it, vi } from 'vitest';
import { MAX_CATALOG_REFS, MAX_RESOLVE_PAGES, spineHeadResolver, type SpineCatalog } from '../../src/connect/catalog.js';

const HEAD = '11111111-1111-4111-8111-111111111111';
const MERGED = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-11T12:00:00.000Z');

const record = (head: string, requested: string[]) => ({
  productId: head,
  requestedAs: requested.map((productId) => ({ productId })),
  attributes: {},
});

const spineOf = (getProducts: SpineCatalog['getProducts']): SpineCatalog => ({
  getProducts,
  getProductImages: vi.fn(),
  searchProducts: vi.fn(),
});

describe('spineHeadResolver', () => {
  it('maps every product id to the head the spine resolves it to, with no entitlement assertion', async () => {
    const getProducts = vi.fn(async () => ({
      productsJson: JSON.stringify({ products: [record(HEAD, [HEAD, MERGED])], unresolved: [{ productId: '33333333-3333-4333-8333-333333333333' }] }),
      nextPageToken: '',
    }));
    const heads = await spineHeadResolver(spineOf(getProducts), () => NOW)([HEAD, MERGED, '33333333-3333-4333-8333-333333333333']);
    expect([...heads]).toEqual([[HEAD, HEAD], [MERGED, HEAD]]);
    expect(getProducts).toHaveBeenCalledWith(
      [{ productId: HEAD }, { productId: MERGED }, { productId: '33333333-3333-4333-8333-333333333333' }],
      NOW.toISOString(),
      null,
      { pageSize: MAX_CATALOG_REFS, pageToken: '' },
    );
  });

  it('asks in batches of the most refs a call may carry and follows every page', async () => {
    const ids = Array.from({ length: MAX_CATALOG_REFS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const getProducts = vi.fn(async (refs: readonly { productId?: string }[], _now: string, _a: string | null, page: { pageToken?: string }) => {
      const first = refs[0]!.productId!;
      if (refs.length > 1 && page.pageToken === '') {
        return { productsJson: JSON.stringify({ products: [record(first, [first])] }), nextPageToken: 'p2' };
      }
      const last = refs[refs.length - 1]!.productId!;
      return { productsJson: JSON.stringify({ products: [record(HEAD, [last])] }), nextPageToken: '' };
    });
    const heads = await spineHeadResolver(spineOf(getProducts as never), () => NOW)(ids);
    expect(getProducts.mock.calls.map((c) => [c[0].length, c[3].pageToken])).toEqual([[MAX_CATALOG_REFS, ''], [MAX_CATALOG_REFS, 'p2'], [1, '']]);
    expect(heads.get(ids[0]!)).toBe(ids[0]);
    expect(heads.get(ids[MAX_CATALOG_REFS - 1]!)).toBe(HEAD);
    expect(heads.get(ids[MAX_CATALOG_REFS]!)).toBe(HEAD);
  });

  it('rejects without a spine, and on a payload it cannot read', async () => {
    await expect(spineHeadResolver(null)([HEAD])).rejects.toThrow(/spine/);
    const bad = spineOf(vi.fn(async () => ({ productsJson: '{"products":"x"}', nextPageToken: '' })));
    await expect(spineHeadResolver(bad)([HEAD])).rejects.toThrow(/could not be read/);
  });

  it('refuses to follow the spine past MAX_RESOLVE_PAGES pages of one batch, having read exactly that many', async () => {
    const getProducts = vi.fn(async () => ({ productsJson: JSON.stringify({ products: [] }), nextPageToken: 'again' }));
    await expect(spineHeadResolver(spineOf(getProducts))([HEAD])).rejects.toThrow(/pages/);
    expect(getProducts).toHaveBeenCalledTimes(MAX_RESOLVE_PAGES);
  });

  it('reads a spine that ends on the last page it may read', async () => {
    let read = 0;
    const getProducts = vi.fn(async () => {
      read += 1;
      const last = read === MAX_RESOLVE_PAGES;
      return { productsJson: JSON.stringify({ products: last ? [record(HEAD, [MERGED])] : [] }), nextPageToken: last ? '' : `p${read}` };
    });
    const heads = await spineHeadResolver(spineOf(getProducts), () => NOW)([MERGED]);
    expect(getProducts).toHaveBeenCalledTimes(MAX_RESOLVE_PAGES);
    expect(heads.get(MERGED)).toBe(HEAD);
  });
});
