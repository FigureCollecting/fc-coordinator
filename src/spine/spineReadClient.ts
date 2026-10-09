/**
 * Spine read client — the coordinator's half of read.v1 SpineRead
 * (@figurecollecting/ingest-contract/read): Compare for CompareService, and
 * GetProducts / GetProductImages / SearchProducts for CatalogService. The coordinator is the
 * client-facing caller; fc-mobile never talks to the spine directly.
 *
 * SCOPE: THIN READ-THROUGH ONLY. Each method sends one request and returns the
 * spine's response message unedited (opaque JSON text plus a page token). What
 * a caller may SEE is decided by the handlers in src/connect/, not here.
 *
 * TRANSPORT (R4d — load-bearing): gRPC over HTTP/2 cleartext (h2c), via
 * createGrpcTransport from @connectrpc/connect-node, aimed at ingest-server's
 * READ_H2C_PORT (:50062). Inside the pod the hop is cleartext; the Linkerd
 * proxy on each side is what makes it mutual TLS on the wire, which R4a proved
 * on prod for this exact shape (a real gRPC client through two meshed proxies,
 * `grpc-status` read from the TRAILER). Ross's rule, 2026-09-17: every
 * component-to-component API is gRPC with mTLS; the Connect-over-HTTP/1.1 hop
 * this replaces (:50052) was a violation of it.
 *
 * NO `httpVersion` OPTION, and that is the point: gRPC is HTTP/2 by
 * construction, so no value of any option here can put this hop back on
 * HTTP/1.1. The consequence is a FLAG DAY PER PORT — this client cannot talk to
 * :50052 at all (test/spine/spineReadClient.test.ts proves it), so the
 * SPINE_READ_URL change to :50062 must ship in the same deploy as this image.
 */
import {
  Code,
  ConnectError,
  createClient,
  type Client,
  type Interceptor,
} from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { traceparentClientInterceptor } from '../connect/interceptors.js';
import { create } from '@bufbuild/protobuf';
import {
  SpineRead,
  CompareRequestSchema,
  GetProductImagesRequestSchema,
  GetProductsRequestSchema,
  SearchProductsRequestSchema,
  SourceItemSchema,
  type CompareResponse,
  type GetProductImagesResponse,
  type GetProductsResponse,
  type SearchProductsResponse,
  type ProductRef as WireProductRef,
} from '@figurecollecting/ingest-contract/read';
import { ENTITLEMENTS_HEADER } from '@figurecollecting/ingest-contract/entitlement';

/** Per-call deadline. The spine's read RPC has no deadline of its own — a
 * caller-side timeout is the only thing standing between us and a hang. */
export const DEFAULT_COMPARE_TIMEOUT_MS = 10_000;

export type CompareSeed = { gtin14: string } | { headId: string };

/** read.v1.ProductRef, as this client sends it: one product, named one of three ways. */
export type SpineProductRef =
  | { productId: string }
  | { gtin14: string }
  | { sourceItem: { site: string; nativeId: string } };

/** One page of a batch read. Both values are forwarded verbatim; the spine clamps and binds them. */
export interface SpinePage {
  pageSize: number;
  pageToken: string;
}

const wireRef = (ref: SpineProductRef): WireProductRef['ref'] => {
  if ('productId' in ref) return { case: 'productId', value: ref.productId };
  if ('gtin14' in ref) return { case: 'gtin14', value: ref.gtin14 };
  return { case: 'sourceItem', value: create(SourceItemSchema, ref.sourceItem) };
};

export class SpineReadClient {
  private readonly client: Client<typeof SpineRead>;
  private readonly timeoutMs: number;

  /**
   * `interceptors` defaults to the W3C traceparent injector (plan §A.5 rule 3),
   * so the mesh hop is traced without any wiring at the call site and a future
   * caller cannot forget it. Pass an explicit list to REPLACE that default —
   * tests do, to prove the hop is untraced without it.
   */
  constructor(
    baseUrl: string,
    timeoutMs: number = DEFAULT_COMPARE_TIMEOUT_MS,
    interceptors: Interceptor[] = [traceparentClientInterceptor()],
  ) {
    // gRPC over h2c — see the TRANSPORT note above.
    const transport = createGrpcTransport({ baseUrl, interceptors });
    this.client = createClient(SpineRead, transport);
    this.timeoutMs = timeoutMs;
  }

  /**
   * Call SpineRead.Compare. `nowIso` is minted by the caller (this module
   * never reads wall time itself) — the RPC never reads wall time
   * server-side either (read.proto FIDELITY DOCTRINE): every verdict must
   * be reproducible from (gathered signals, cfg, now_iso).
   *
   * `assertion` is the compact JWS from src/services/entitlements/assertion.ts,
   * or null/undefined when the caller holds nothing. It travels as REQUEST
   * METADATA, never in the message: read-service.ts sets OTel span attributes
   * off request FIELDS, so a body-borne assertion would be exported to a
   * collector on every call, and every other caller would have to model a
   * field that is none of their business.
   *
   * AN ABSENT HEADER IS THE NORMAL CASE, NOT AN ERROR. Unentitled, unlinked,
   * denied, OpenFGA unreachable, no signing key — all of them arrive here as
   * no assertion, and the spine answers each with a normal 200 whose stock
   * magnitudes are withheld and marked in `coverage.redacted`. So nothing on
   * this path may throw or branch on the absence.
   */
  async compare(
    seed: CompareSeed,
    nowIso: string,
    assertion?: string | null
  ): Promise<CompareResponse> {
    const request = create(CompareRequestSchema, {
      seed:
        'gtin14' in seed
          ? { case: 'gtin14' as const, value: seed.gtin14 }
          : { case: 'headId' as const, value: seed.headId },
      nowIso,
    });
    return this.client.compare(request, this.callOptions(assertion));
  }

  /**
   * Call SpineRead.GetProducts for one page of a batch. The assertion travels
   * exactly as it does for Compare, for the same reasons, and its absence is
   * just as normal.
   */
  async getProducts(
    refs: readonly SpineProductRef[],
    nowIso: string,
    assertion: string | null,
    page: SpinePage,
  ): Promise<GetProductsResponse> {
    const request = create(GetProductsRequestSchema, {
      refs: refs.map((ref) => ({ ref: wireRef(ref) })),
      nowIso,
      pageSize: page.pageSize,
      pageToken: page.pageToken,
    });
    return this.client.getProducts(request, this.callOptions(assertion));
  }

  /** Call SpineRead.GetProductImages for one page of image rows. */
  async getProductImages(
    productIds: readonly string[],
    nowIso: string,
    assertion: string | null,
    page: SpinePage,
  ): Promise<GetProductImagesResponse> {
    const request = create(GetProductImagesRequestSchema, {
      productIds: [...productIds],
      nowIso,
      pageSize: page.pageSize,
      pageToken: page.pageToken,
    });
    return this.client.getProductImages(request, this.callOptions(assertion));
  }

  /**
   * Call SpineRead.SearchProducts for one page of one search. The query goes
   * as the caller typed it: the spine normalizes it, binds its page token to
   * and matches THAT form, so a copy normalized here would be a second form.
   * Neither filter is sent — catalog.proto has none yet — and they stay ABSENT,
   * because present-but-empty is INVALID_ARGUMENT at the spine.
   */
  async searchProducts(
    query: string,
    nowIso: string,
    assertion: string | null,
    page: SpinePage,
  ): Promise<SearchProductsResponse> {
    const request = create(SearchProductsRequestSchema, {
      query,
      nowIso,
      pageSize: page.pageSize,
      pageToken: page.pageToken,
    });
    return this.client.searchProducts(request, this.callOptions(assertion));
  }

  /**
   * The deadline, and the assertion header ONLY when there is one to set: an
   * empty value reads as `absent` at the spine anyway, but sending it always
   * would make a caller that lost its key look exactly like one that never
   * had one.
   */
  private callOptions(assertion: string | null | undefined): {
    timeoutMs: number;
    headers?: Record<string, string>;
  } {
    return assertion !== undefined && assertion !== null && assertion !== ''
      ? { timeoutMs: this.timeoutMs, headers: { [ENTITLEMENTS_HEADER]: assertion } }
      : { timeoutMs: this.timeoutMs };
  }
}

/**
 * Build the client from SPINE_READ_URL. Unset/empty -> null: this is the
 * DEGRADED MODE seam (fc-backend prod still runs on Coolify pre-k3s-cutover,
 * where the cluster-internal spine service is unreachable) — callers must
 * treat null as "do not attempt a call" and surface 503
 * SPINE_READ_UNCONFIGURED without ever constructing a transport.
 */
export function createSpineReadClientFromEnv(env: NodeJS.ProcessEnv = process.env): SpineReadClient | null {
  const baseUrl = env.SPINE_READ_URL;
  if (!baseUrl) return null;

  const timeoutMs = env.SPINE_READ_TIMEOUT_MS ? Number(env.SPINE_READ_TIMEOUT_MS) : undefined;
  return new SpineReadClient(
    baseUrl,
    timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined
  );
}

export { Code, ConnectError };
