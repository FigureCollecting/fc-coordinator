/**
 * Spine read client — Connect client for read.v1 SpineRead.Compare
 * (@figurecollecting/ingest-contract/read). This is fc-backend's SCREEN
 * surface for the spine's derived comparison view: fc-backend is the SINGLE
 * user-facing caller (lookup-caller-architecture, RATIFIED) — the frontend
 * never talks to the spine directly.
 *
 * SCOPE (this increment): THIN READ-THROUGH ONLY. NO buy/sell framing, NO
 * landed-cost, NO comps — those are HELD for the product vision. Callers get
 * neutral observations out (the spine's CompareResult, opaque JSON, passed
 * through verbatim).
 *
 * TRANSPORT (load-bearing — DO NOT CHANGE without re-validating the meshed
 * hop end-to-end): createConnectTransport({ baseUrl, httpVersion: '1.1' })
 * from @connectrpc/connect-node. The spine's ingest-server serves the
 * Connect protocol over cleartext HTTP/1.1 (Linkerd meshes h1 natively, no
 * appProtocol hint or opaque-port tuning needed). This RPC is UNARY, so
 * HTTP/2 buys nothing here. createGrpcTransport requires h2 and FAILS
 * against this server — mirrors scraper/src/services/ingestEmitter.ts's
 * TRANSPORT note for the sibling ingest RPC verbatim.
 */
import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { create } from '@bufbuild/protobuf';
import {
  SpineRead,
  CompareRequestSchema,
  type CompareResponse,
} from '@figurecollecting/ingest-contract/read';
import { ENTITLEMENTS_HEADER } from '@figurecollecting/ingest-contract/entitlement';

/** Per-call deadline. The spine's read RPC has no deadline of its own — a
 * caller-side timeout is the only thing standing between us and a hang. */
export const DEFAULT_COMPARE_TIMEOUT_MS = 10_000;

export type CompareSeed = { gtin14: string } | { headId: string };

export class SpineReadClient {
  private readonly client: Client<typeof SpineRead>;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs: number = DEFAULT_COMPARE_TIMEOUT_MS) {
    // Connect over HTTP/1.1 — see the TRANSPORT note above. NEVER
    // createGrpcTransport here.
    const transport = createConnectTransport({ baseUrl, httpVersion: '1.1' });
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
    // Set the header only when there is one to set: an empty value reads as
    // `absent` at the spine anyway, but sending it always would make a caller
    // that lost its key look exactly like one that never had one.
    const headers =
      assertion !== undefined && assertion !== null && assertion !== ''
        ? { [ENTITLEMENTS_HEADER]: assertion }
        : undefined;
    return this.client.compare(request, {
      timeoutMs: this.timeoutMs,
      ...(headers === undefined ? {} : { headers }),
    });
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
