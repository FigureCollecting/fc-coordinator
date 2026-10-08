// MFC id -> spine head, through SpineRead.GetProducts by (site "mfc", native id): at most 200
// refs a call (read.proto's request bound), every page followed. The import needs only which
// product each ref names, so it sends no entitlement assertion: the spine redacts what is gated
// and the product ids are not.
import { Code, ConnectError } from '@connectrpc/connect';
import type { SpineCatalog } from '../connect/catalog.js';

export const SPINE_BATCH = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const unreadable = (): ConnectError => new ConnectError('spine returned a products payload that could not be read', Code.Internal);

/** The products of one page, as (productId, the mfc native ids that named it). */
function readPage(json: string): { productId: string; ids: string[] }[] {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    throw unreadable();
  }
  const products = (payload as { products?: unknown } | null)?.products;
  if (!Array.isArray(products)) throw unreadable();
  return products.map((p: unknown) => {
    const record = p as { productId?: unknown; requestedAs?: unknown } | null;
    const productId = record?.productId;
    if (typeof productId !== 'string' || !UUID.test(productId)) throw unreadable();
    const ids: string[] = [];
    for (const ref of Array.isArray(record!.requestedAs) ? record!.requestedAs : []) {
      const item = (ref as { sourceItem?: { site?: unknown; nativeId?: unknown } } | null)?.sourceItem;
      if (item?.site === 'mfc' && typeof item.nativeId === 'string') ids.push(item.nativeId);
    }
    return { productId, ids };
  });
}

/**
 * The head of each id the spine knows. An id it does not know is absent (no_product). Spine
 * unconfigured or failing: UNAVAILABLE, before anything is written.
 */
export async function resolveMfcIds(spine: SpineCatalog | null, ids: readonly string[], nowIso: string): Promise<Map<string, string>> {
  const heads = new Map<string, string>();
  if (ids.length === 0) return heads;
  if (spine === null) throw new ConnectError('spine read is not configured', Code.Unavailable);
  for (let at = 0; at < ids.length; at += SPINE_BATCH) {
    const batch = ids.slice(at, at + SPINE_BATCH);
    const asked = new Set(batch);
    const refs = batch.map((nativeId) => ({ sourceItem: { site: 'mfc', nativeId } }));
    let pageToken = '';
    do {
      let page: { productsJson: string; nextPageToken: string };
      try {
        page = await spine.getProducts(refs, nowIso, null, { pageSize: SPINE_BATCH, pageToken });
      } catch (err) {
        // Never the upstream message: it routinely carries connection detail.
        throw new ConnectError('spine read is unavailable', Code.Unavailable, undefined, undefined, err);
      }
      for (const { productId, ids: named } of readPage(page.productsJson)) {
        for (const id of named) if (asked.has(id) && !heads.has(id)) heads.set(id, productId);
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== '');
  }
  return heads;
}
