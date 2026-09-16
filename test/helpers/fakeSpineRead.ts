/**
 * A FAKE SpineRead server: plain `node:http` (HTTP/1.1) + connectNodeAdapter,
 * the same cleartext h1 shape ingest-server serves on :50052.
 *
 * IT REGRESSION-PINS THE TRANSPORT. A plain node:http server has no ALPN and no
 * h2c upgrade handling, so if src/spine/spineReadClient.ts ever swapped
 * createConnectTransport for createGrpcTransport (which requires h2), every
 * call through this fake would fail. The transport note in that file says the
 * same thing in prose; this is the half that cannot go stale.
 *
 * IT DECIDES REDACTION THE WAY THE SPINE DOES, rather than by a per-test flag:
 * it VERIFIES the `fc-entitlements` header with the faithful port of the
 * spine's verifier (./entitlementVerifier.ts) and serves the unredacted canned
 * result only on a `granted` outcome naming `inventory_levels`. Everything else
 * — absent, expired, wrong audience, signed by another key — is a normal 200
 * carrying the redacted canned result. That is the spine's actual contract, and
 * it means a test cannot pass by asserting against a flag it set itself.
 *
 * NEVER POINTED AT PRODUCTION. It binds 127.0.0.1 on an ephemeral port.
 */
import * as http from 'node:http';
import type * as crypto from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  SpineRead,
  CompareResponseSchema,
  type CompareRequest as WireCompareRequest,
  type CompareResponse as WireCompareResponse,
} from '@figurecollecting/ingest-contract/read';
import {
  ENTITLEMENTS_HEADER,
  INVENTORY_LEVELS,
} from '@figurecollecting/ingest-contract/entitlement';
import { verifyEntitlementHeader } from './entitlementVerifier.js';

/**
 * The ENTITLED canned result. `stockOnHand` is the level key the whole gate
 * exists for, and it is a STRING — read.v1's fidelity doctrine keeps every
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
 * The REDACTED canned result: the same offer with `stockOnHand` REMOVED, and
 * `coverage.redacted` naming the entitlement that would have been required.
 * Availability stays — the gate is on MAGNITUDE, not on whether a thing is
 * orderable (ingest-contract/entitlement, INVENTORY_LEVELS).
 */
export const REDACTED_RESULT_JSON =
  '{"heads":[{"head":"head-1","perStore":[{"store":"mfc","offers":[' +
  '{"price":{"amount":"2950","currency":"JPY"},"availability":"in_stock"}' +
  ']}],"editions":[]}],"related":[],' +
  '"coverage":{"redacted":["inventory_levels"],"semanticsRev":"a1b2c3d4e5f60789"}}';

export interface SpineCall {
  request: WireCompareRequest;
  headers: Headers;
  /** The verifier's verdict on this call's `fc-entitlements` header. */
  entitlementOutcome: string;
}

export interface FakeSpineRead {
  baseUrl: string;
  calls: SpineCall[];
  close: () => Promise<void>;
}

export interface FakeSpineReadOptions {
  /** kid -> public key, as the spine builds from its mounted Secret. */
  keys: ReadonlyMap<string, crypto.KeyObject>;
  /** Override the whole reply — for malformed-body and error cases. */
  respond?: (call: SpineCall) => WireCompareResponse | Promise<WireCompareResponse>;
  /** Throw instead of replying, to exercise the transport-failure path. */
  fail?: (call: SpineCall) => never;
}

export async function startFakeSpineRead(options: FakeSpineReadOptions): Promise<FakeSpineRead> {
  const calls: SpineCall[] = [];

  const routes = (router: ConnectRouter): void => {
    router.service(SpineRead, {
      compare: async (
        request: WireCompareRequest,
        ctx: { requestHeader: Headers },
      ): Promise<WireCompareResponse> => {
        const raw = ctx.requestHeader.get(ENTITLEMENTS_HEADER);
        const verified = verifyEntitlementHeader(raw, options.keys);
        const call: SpineCall = {
          request,
          headers: ctx.requestHeader,
          entitlementOutcome: verified.outcome,
        };
        calls.push(call);

        if (options.fail) options.fail(call);
        if (options.respond) return options.respond(call);

        const entitled = verified.outcome === 'granted' && verified.grants.has(INVENTORY_LEVELS);
        return create(CompareResponseSchema, {
          resultJson: entitled ? ENTITLED_RESULT_JSON : REDACTED_RESULT_JSON,
        });
      },
    });
  };

  const server = http.createServer(connectNodeAdapter({ routes }));
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
