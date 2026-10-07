import { Code, ConnectError } from '@connectrpc/connect';
import { describe, expect, it } from 'vitest';
import type { SpineCatalog } from '../connect/catalog.js';
import type { SpinePage, SpineProductRef } from '../spine/spineReadClient.js';
import { SPINE_BATCH, resolveMfcIds } from './resolve.js';

const head = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

interface Call {
  refs: SpineProductRef[];
  page: SpinePage;
  nowIso: string;
  assertion: string | null;
}

/** A spine that knows every id below `known`, and serves `pageSize` products per page. */
function spine(known: number, pageSize = 50, edit?: (payload: Record<string, unknown>, call: Call) => void): SpineCatalog & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async getProducts(refs, nowIso, assertion, page) {
      const call = { refs: [...refs], page, nowIso, assertion };
      calls.push(call);
      if (refs.length > 200) throw new ConnectError('too many', Code.InvalidArgument);
      const ids = refs.map((r) => ('sourceItem' in r ? r.sourceItem.nativeId : ''));
      const hits = ids.filter((id) => Number(id) < known);
      const start = page.pageToken === '' ? 0 : Number(page.pageToken);
      const slice = hits.slice(start, start + pageSize);
      const payload: Record<string, unknown> = {
        products: slice.map((id) => ({ productId: head(Number(id)), requestedAs: [{ sourceItem: { site: 'mfc', nativeId: id } }] })),
        unresolved: start === 0 ? ids.filter((id) => Number(id) >= known).map((id) => ({ sourceItem: { site: 'mfc', nativeId: id } })) : [],
        coverage: {},
      };
      edit?.(payload, call);
      return { productsJson: JSON.stringify(payload), nextPageToken: start + pageSize < hits.length ? String(start + pageSize) : '' };
    },
    async getProductImages() {
      throw new Error('not used');
    },
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => String(i + 1));

describe('resolveMfcIds', () => {
  it('asks the spine in batches of 200 refs (site mfc), follows every page, and maps each id to its head', async () => {
    expect(SPINE_BATCH).toBe(200);
    const s = spine(10_000);
    const map = await resolveMfcIds(s, ids(450), '2026-10-07T12:00:00.000Z');
    expect(map.size).toBe(450);
    expect(map.get('1')).toBe(head(1));
    expect(map.get('450')).toBe(head(450));
    const batches = s.calls.filter((c) => c.page.pageToken === '');
    expect(batches.map((c) => c.refs.length)).toEqual([200, 200, 50]);
    expect(s.calls).toHaveLength(4 + 4 + 1); // 200 products at 50 a page: four pages each
    expect(s.calls.every((c) => c.page.pageSize === 200 && c.assertion === null && c.nowIso === '2026-10-07T12:00:00.000Z')).toBe(true);
    expect(s.calls[1]!.refs).toEqual(s.calls[0]!.refs);
    expect(s.calls[0]!.refs[0]).toEqual({ sourceItem: { site: 'mfc', nativeId: '1' } });
  });

  it('leaves out the ids the spine does not know', async () => {
    const map = await resolveMfcIds(spine(3), ids(5), 'now');
    expect([...map.keys()]).toEqual(['1', '2']);
  });

  it('asks nothing for no ids', async () => {
    const s = spine(10);
    expect((await resolveMfcIds(s, [], 'now')).size).toBe(0);
    expect(s.calls).toHaveLength(0);
  });

  it('keeps the first product that names an id, and ignores refs it did not send', async () => {
    const s = spine(10, 50, (payload) => {
      const products = payload['products'] as { productId: string; requestedAs: unknown[] }[];
      products.push({ productId: head(99), requestedAs: [{ sourceItem: { site: 'mfc', nativeId: '1' } }, { sourceItem: { site: 'other', nativeId: '2' } }, { gtin14: '1' }, 'junk'] });
    });
    const map = await resolveMfcIds(s, ['1', '2'], 'now');
    expect(map.get('1')).toBe(head(1));
    expect(map.get('2')).toBe(head(2));
  });

  it('answers UNAVAILABLE when the spine is not configured or fails', async () => {
    await expect(resolveMfcIds(null, ['1'], 'now')).rejects.toMatchObject({ code: Code.Unavailable });
    const failing: SpineCatalog = {
      getProducts: async () => {
        throw new ConnectError('connection refused at 10.0.0.1', Code.Unavailable);
      },
      getProductImages: async () => ({ imagesJson: '', nextPageToken: '' }),
    };
    const err = await resolveMfcIds(failing, ['1'], 'now').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.Unavailable);
    expect((err as ConnectError).message).not.toContain('10.0.0.1');
  });

  it('answers INTERNAL for a payload it cannot read or a product id that is not a uuid', async () => {
    const bad = (json: string): SpineCatalog => ({
      getProducts: async () => ({ productsJson: json, nextPageToken: '' }),
      getProductImages: async () => ({ imagesJson: '', nextPageToken: '' }),
    });
    for (const json of ['not json', '[]', '{"products":{}}', '{"products":[null]}', '{"products":[{"productId":"X","requestedAs":[]}]}', '{"products":[{"productId":"5F0C2A9E-4B7D-4E21-9C3A-8D1E6F2B7A40","requestedAs":[]}]}', '{"products":[{"productId":7}]}']) {
      await expect(resolveMfcIds(bad(json), ['1'], 'now')).rejects.toMatchObject({ code: Code.Internal });
    }
  });
});
