/**
 * A FAKE SpineRead server, SERVING read.v1 OVER gRPC ON CLEARTEXT h2c — the
 * shape ingest-server presents on READ_H2C_PORT (:50062), and the shape the
 * Linkerd proxy meets before it wraps the hop in mTLS (R4a, R4d).
 *
 * IT REGRESSION-PINS THE TRANSPORT, twice over.
 *
 *   `http2.createServer` WITHOUT `allowHTTP1`. A client that quietly fell back
 *   to HTTP/1.1 — the Connect-over-h1 shape this hop used until R4d, and the
 *   one ingest-server still serves on :50052 — cannot even open a stream here.
 *
 *   The adapter serves the gRPC protocol and NOTHING ELSE (`connect: false`,
 *   `grpcWeb: false`). An h2 server alone would not be enough: Connect speaks
 *   HTTP/2 too, so a client swapped to `createConnectTransport({ httpVersion:
 *   '2' })` would pass against a permissive h2 fake while still not being gRPC.
 *
 * And it RECORDS THE WIRE (`wire`): the content type and HTTP version of every
 * stream it was asked to serve, so a test can assert the protocol on the
 * socket, not only that a call happened to succeed.
 *
 * IT DECIDES REDACTION THE WAY THE SPINE DOES, rather than by a per-test flag:
 * it VERIFIES the `fc-entitlements` header with the faithful port of the
 * spine's verifier (./entitlementVerifier.ts) and serves the unredacted canned
 * result only on a `granted` outcome naming `inventory_levels`. Everything else
 * — absent, expired, wrong audience, signed by another key — is a normal answer
 * carrying the redacted canned result. That is the spine's actual contract, and
 * it means a test cannot pass by asserting against a flag it set itself.
 *
 * `requireAssertion` is the one deliberate departure from the real spine: it
 * REFUSES any call whose assertion does not verify. A test that reads entitled
 * fields through it has therefore PROVEN the assertion arrived and verified;
 * the real spine's silent redaction could not tell it that.
 *
 * NEVER POINTED AT PRODUCTION. It binds 127.0.0.1 on an ephemeral port.
 */
import * as http2 from 'node:http2';
import type * as crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  SpineRead,
  CompareResponseSchema,
  GetProductsResponseSchema,
  GetProductImagesResponseSchema,
  type CompareRequest as WireCompareRequest,
  type CompareResponse as WireCompareResponse,
  type GetProductsRequest as WireGetProductsRequest,
  type GetProductsResponse as WireGetProductsResponse,
  type GetProductImagesRequest as WireGetProductImagesRequest,
  type GetProductImagesResponse as WireGetProductImagesResponse,
} from '@figurecollecting/ingest-contract/read';
import {
  ENTITLEMENTS_HEADER,
  INVENTORY_LEVELS,
} from '@figurecollecting/ingest-contract/entitlement';
import { verifyEntitlementHeader } from './entitlementVerifier.js';

/**
 * The ENTITLED canned Compare result. `stockOnHand` is the level key the whole
 * gate exists for, and it is a STRING — read.v1's fidelity doctrine keeps every
 * scraped token as raw text, so a number here would be the float-fold bug the
 * contract was written to avoid.
 *
 * Written as a literal rather than JSON.stringify of an object, deliberately:
 * the byte-for-byte pass-through assertion needs a result_json whose exact
 * characters (key order, spacing) are ours to choose and to compare against.
 */
export const ENTITLED_RESULT_JSON =
  '{"heads":[{"head":"head-1","perStore":[{"store":"mfc","offers":[' +
  '{"price":{"amount":"2950","currency":"JPY"},"availability":"in_stock","stockOnHand":"7"}' +
  ']}],"editions":[]}],"related":[],' +
  '"coverage":{"semanticsRev":"a1b2c3d4e5f60789"}}';

/**
 * The REDACTED canned Compare result: the same offer with `stockOnHand`
 * REMOVED, and `coverage.redacted` naming the entitlement that would have been
 * required. Availability stays — the gate is on MAGNITUDE, not on whether a
 * thing is orderable (ingest-contract/entitlement, INVENTORY_LEVELS).
 */
export const REDACTED_RESULT_JSON =
  '{"heads":[{"head":"head-1","perStore":[{"store":"mfc","offers":[' +
  '{"price":{"amount":"2950","currency":"JPY"},"availability":"in_stock"}' +
  ']}],"editions":[]}],"related":[],' +
  '"coverage":{"redacted":["inventory_levels"],"semanticsRev":"a1b2c3d4e5f60789"}}';

/** The product every canned GetProducts answer describes. */
export const CANNED_HEAD_ID = '5f0c2a9e-4b7d-4e21-9c3a-8d1e6f2b7a40';

/**
 * One facet as fc-aggregation's getProducts() emits it (src/read/products.ts
 * AttrFacet): raw PostgreSQL tokens, `asOf` in PostgreSQL's own timestamptz
 * text rendering, not ISO.
 */
const facet = (value: string, asOf: string, kind = 'text'): Record<string, unknown> => ({
  kind,
  value,
  site: 'mfc',
  rank: '2',
  conf: '0.90',
  lang: 'en',
  asOf,
  lastSeenAt: '2026-09-20 08:00:00.5+00',
});

/**
 * A canned ProductRecord, shaped exactly like the spine's. It carries the
 * attributes a card is allowed to show AND the ones it must never show: an
 * image URL naming a store's ORIGINAL, a nested image key, and a key nobody has
 * ever heard of. When `entitled`, it also carries the gated level key, which
 * the real spine removes for everyone else.
 */
export function cannedProductRecord(
  requestedAs: unknown[],
  entitled: boolean,
): Record<string, unknown> {
  return {
    productId: CANNED_HEAD_ID,
    status: 'active',
    domain: 'figure',
    requestedAs,
    clusterSize: 1,
    display: {
      name: 'Hatsune Miku Symphony 2025 Ver.',
      manufacturer: 'Good Smile Company',
      originSeries: 'Character Vocal Series',
      productType: 'Scale Figure',
      scale: '1/7',
      releaseYm: '2026-03',
      heightMm: '245',
    },
    identifiers: [
      { idType: 'jan', value: '4573102591234', gtin14: '04573102591234', site: 'mfc' },
      { idType: 'source_native', value: '1144', gtin14: null, site: 'mfc' },
    ],
    attrs: {
      name: facet('Hatsune Miku Symphony 2025 Ver.', '2026-09-01 10:00:00.123456+00'),
      manufacturer: facet('Good Smile Company', '2026-09-02 11:00:00+00'),
      origin_series: facet('Character Vocal Series', '2026-09-03 12:30:00.5+09'),
      character: facet('Hatsune Miku', '2026-09-04 13:00:00.000001+00'),
      scale: facet('1/7', '2026-09-05 14:00:00+00'),
      contentLevel: facet('general', '2026-09-06 15:00:00+00'),
      imageUrl: facet('https://images.store.example/originals/1144.jpg', '2026-09-07 16:00:00+00'),
      'images.url': facet('https://images.store.example/originals/1144-2.jpg', '2026-09-07 16:00:00+00'),
      mysteryKey: facet('SHOULD-NEVER-SHIP', '2026-09-08 17:00:00+00'),
      ...(entitled ? { stockOnHand: facet('7', '2026-09-09 18:00:00+00', 'num') } : {}),
    },
  };
}

/** What a canned GetProducts answer serves, given what it was asked and what was verified. */
export function cannedProductsJson(request: WireGetProductsRequest, entitled: boolean): string {
  const requestedAs = request.refs.map((ref) => {
    if (ref.ref.case === 'productId') return { productId: ref.ref.value };
    if (ref.ref.case === 'gtin14') return { gtin14: ref.ref.value };
    if (ref.ref.case === 'sourceItem') {
      return { sourceItem: { site: ref.ref.value.site, nativeId: ref.ref.value.nativeId } };
    }
    return {};
  });
  return JSON.stringify({
    products: [cannedProductRecord(requestedAs, entitled)],
    unresolved: [],
    coverage: entitled ? {} : { redacted: [INVENTORY_LEVELS] },
  });
}

/** One stream as the server saw it on the socket, before any adapter ran. */
export interface WireRecord {
  path: string;
  contentType: string | undefined;
  httpVersion: string;
}

export interface SpineCall<R = WireCompareRequest> {
  request: R;
  headers: Headers;
  /** The verifier's verdict on this call's `fc-entitlements` header. */
  entitlementOutcome: string;
  /** Whether the verdict granted `inventory_levels`. */
  entitled: boolean;
}

export interface FakeSpineRead {
  baseUrl: string;
  /** Compare calls, in order. */
  calls: SpineCall[];
  /** GetProducts calls, in order. */
  productCalls: SpineCall<WireGetProductsRequest>[];
  /** GetProductImages calls, in order. */
  imageCalls: SpineCall<WireGetProductImagesRequest>[];
  /** Every stream, whatever its protocol — including ones the adapter refused. */
  wire: WireRecord[];
  close: () => Promise<void>;
}

export interface FakeSpineReadOptions {
  /** kid -> public key, as the spine builds from its mounted Secret. */
  keys: ReadonlyMap<string, crypto.KeyObject>;
  /** Override the whole Compare reply — for malformed-body and error cases. */
  respond?: (call: SpineCall) => WireCompareResponse | Promise<WireCompareResponse>;
  /** Throw instead of replying to Compare, to exercise the transport-failure path. */
  fail?: (call: SpineCall) => never;
  /** Override the whole GetProducts reply. Throw from it to answer with a status. */
  respondProducts?: (
    call: SpineCall<WireGetProductsRequest>,
  ) => WireGetProductsResponse | Promise<WireGetProductsResponse>;
  /** Override the whole GetProductImages reply. Throw from it to answer with a status. */
  respondImages?: (
    call: SpineCall<WireGetProductImagesRequest>,
  ) => WireGetProductImagesResponse | Promise<WireGetProductImagesResponse>;
  /** Refuse, PERMISSION_DENIED, every call whose assertion does not verify as granted. */
  requireAssertion?: boolean;
}

export async function startFakeSpineRead(options: FakeSpineReadOptions): Promise<FakeSpineRead> {
  const calls: SpineCall[] = [];
  const productCalls: SpineCall<WireGetProductsRequest>[] = [];
  const imageCalls: SpineCall<WireGetProductImagesRequest>[] = [];
  const wire: WireRecord[] = [];

  const admit = <R>(request: R, requestHeader: Headers): SpineCall<R> => {
    const verified = verifyEntitlementHeader(requestHeader.get(ENTITLEMENTS_HEADER), options.keys);
    const entitled = verified.outcome === 'granted' && verified.grants.has(INVENTORY_LEVELS);
    return { request, headers: requestHeader, entitlementOutcome: verified.outcome, entitled };
  };
  const refuseUnlessEntitled = (call: SpineCall<unknown>): void => {
    if (options.requireAssertion === true && !call.entitled) {
      throw new ConnectError('fake spine: no verified fc-entitlements assertion', Code.PermissionDenied);
    }
  };

  const routes = (router: ConnectRouter): void => {
    router.service(SpineRead, {
      compare: async (request, ctx): Promise<WireCompareResponse> => {
        const call = admit(request, ctx.requestHeader);
        calls.push(call);
        refuseUnlessEntitled(call);

        if (options.fail) options.fail(call);
        if (options.respond) return options.respond(call);
        return create(CompareResponseSchema, {
          resultJson: call.entitled ? ENTITLED_RESULT_JSON : REDACTED_RESULT_JSON,
        });
      },
      getProducts: async (request, ctx): Promise<WireGetProductsResponse> => {
        const call = admit(request, ctx.requestHeader);
        productCalls.push(call);
        refuseUnlessEntitled(call);

        if (options.respondProducts) return options.respondProducts(call);
        return create(GetProductsResponseSchema, {
          productsJson: cannedProductsJson(request, call.entitled),
        });
      },
      getProductImages: async (request, ctx): Promise<WireGetProductImagesResponse> => {
        const call = admit(request, ctx.requestHeader);
        imageCalls.push(call);
        refuseUnlessEntitled(call);

        if (options.respondImages) return options.respondImages(call);
        return create(GetProductImagesResponseSchema, {
          imagesJson: '{"products":[],"coverage":{}}',
        });
      },
    });
  };

  // gRPC ONLY: see the header. The adapter refuses Connect and gRPC-web, and
  // the server refuses HTTP/1.1, so the only call that can succeed here is the
  // one the coordinator is now required to make.
  const adapter = connectNodeAdapter({ routes, connect: false, grpcWeb: false });
  const server = http2.createServer((req, res) => {
    wire.push({
      path: req.url,
      contentType: req.headers['content-type'],
      httpVersion: req.httpVersion,
    });
    adapter(req, res);
  });
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (s) => {
    sessions.add(s);
    s.once('close', () => sessions.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    productCalls,
    imageCalls,
    wire,
    close: async () => {
      // Sessions first: a handler parked on a never-settling promise holds a
      // stream open, and server.close() waits for streams.
      for (const s of sessions) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
