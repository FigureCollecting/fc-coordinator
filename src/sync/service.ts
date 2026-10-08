// coordinator.v1.SyncService: Delta, Push and Status over migrations/0003_sync.sql and 0004.
// The user is the token's `sub` and the device is the DPoP binding; the client names neither.
// REVIEW is never emitted: there are no policy tables yet, so every user facet is AUTO_ACCEPT.
// Each Push is one server transaction (sync.proto rule 7), and Delta gives its last event
// commit_cursor. HELD is decided by a HoldPolicy; until the import supplies one, nothing is held.
// An answer to an import item (res/{site}/{head}) is the import's to accept or answer STALE
// (ImportHooks), and StatusResponse.pending_review is the import's count of what awaits review.
import { createHash } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { Code, ConnectError, type ConnectRouter, type HandlerContext } from '@connectrpc/connect';
import {
  DeltaResponseSchema,
  PushOutcome,
  PushRequestSchema,
  PushResponseSchema,
  PushResultSchema,
  StatusResponseSchema,
  SyncEventSchema,
  SyncOp,
  SyncService,
  normaliseDeviceId,
  parseUserFacetKey,
  type DeltaRequest,
  type DeltaResponse,
  type PushRequest,
  type PushResponse,
  type PushResult,
  type StatusResponse,
  type SyncEvent,
} from '@figurecollecting/fc-api-contract';
import { kCallerDevice, kCallerSubject } from '../connect/identity.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { KeyedSerialiser, QueueFull } from './serialise.js';
import {
  FeedTransaction,
  LOCK_NOT_AVAILABLE,
  applyEvent,
  boundLockWaits,
  feedHead,
  issuedHead,
  keepHeld,
  lockUser,
  readFacet,
  readFeed,
  readReceipt,
  recordCursor,
  serverNow,
  transaction,
  writeReceipt,
  type Facet,
  type FeedEvent,
  type SqlClient,
  type SyncPool,
  type TxClient,
} from './store.js';
import { validateEvent } from './validate.js';
import type { ImportHooks } from '../import/answers.js';

export const DEFAULT_PAGE = 500;
export const MAX_PAGE = 1000;
export const MAX_BATCH = 200;
/** Printable ASCII, no space, 1 to 128 characters: a uuid fits and the receipt key stays indexable. */
const CLIENT_ID = /^[\x21-\x7e]{1,128}$/;
/** A Push waits this long for its user's lock, then answers UNAVAILABLE rather than hold a connection. */
export const PUSH_LOCK_TIMEOUT_MS = 5_000;
/** Pushes one user may have running or waiting on one replica, then UNAVAILABLE; one device sends one at a time. */
export const MAX_QUEUED_PUSHES = 8;
/**
 * The largest request body read, before any handler runs. 200 notes of 10,000 U+0001, which
 * JSON.stringify writes as \u0001 and the JSON envelope escapes again, each with the longest
 * basis (the cursor of the largest seq), are 14,073,154 bytes.
 */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;

/** One event of a Push that passed every REJECTED check, as a HoldPolicy sees it. */
export interface PushedEdit extends Facet {
  /** Its place in the Push. */
  index: number;
  /** The seq its basis names; 0 for ''. */
  basisSeq: bigint;
}

/**
 * import.proto HELD: decided once, when a Push arrives, over its edits in push order, before
 * any of them is applied. Runs in the Push transaction under the user lock and returns the
 * indexes held.
 */
export type HoldPolicy = (tx: SqlClient, userId: string, edits: readonly PushedEdit[]) => Promise<ReadonlySet<number>>;

/** No import has run, so no edit meets a frame and none is late: each is placed by LWW. */
export const holdNothing: HoldPolicy = async () => new Set();

export interface SyncRoutesDeps {
  db: SyncPool;
  /** The per-user Push queue; tests pass one in to watch it. */
  writers?: KeyedSerialiser;
  /** Which edits a Push holds; holdNothing by default. */
  holds?: HoldPolicy;
  /** The import's answers and review count; without them an answer is placed by LWW and nothing awaits review. */
  imports?: ImportHooks;
}

interface Caller {
  userId: string;
  deviceId: string;
}

function callerOf(ctx: HandlerContext): Caller {
  const userId = ctx.values.get(kCallerSubject);
  const deviceId = ctx.values.get(kCallerDevice);
  // The edge refuses these first; this keeps a mis-wired app from syncing as nobody.
  if (userId === null || deviceId === null) {
    throw new ConnectError('sync needs an authenticated, device-bound caller', Code.Unauthenticated);
  }
  return { userId, deviceId };
}

/** A facet on the wire, with commit_cursor when it is a Delta event that ends its transaction. */
const toWire = (facet: Facet | FeedEvent): SyncEvent =>
  create(SyncEventSchema, {
    facetKey: facet.facetKey,
    version: facet.version,
    op: facet.op === 'delete' ? SyncOp.DELETE : SyncOp.UPSERT,
    payload: facet.payload,
    commitCursor: 'commits' in facet && facet.commits ? encodeCursor(facet.seq) : '',
  });

function result(facetKey: string, outcome: PushOutcome, current: Facet | undefined, reason = ''): PushResult {
  return create(PushResultSchema, {
    facetKey,
    outcome,
    version: current?.version ?? '',
    ...(current !== undefined ? { current: toWire(current) } : {}),
    reason,
  });
}

// The receipt keeps each event's first outcome and reason, never `current`.
const outcomesOf = (response: PushResponse): Uint8Array =>
  toBinary(
    PushResponseSchema,
    create(PushResponseSchema, {
      results: response.results.map((r) => create(PushResultSchema, { facetKey: r.facetKey, outcome: r.outcome, reason: r.reason })),
    }),
  );

// A replay repeats each outcome (APPLIED as DUPLICATE) and reason, with `current` read now under
// the user lock: the client adopts it whole, and a sibling may have written since the first answer.
async function replay(tx: SqlClient, userId: string, recorded: PushResponse): Promise<PushResponse> {
  const results: PushResult[] = [];
  for (const r of recorded.results) {
    const outcome = r.outcome === PushOutcome.APPLIED ? PushOutcome.DUPLICATE : r.outcome;
    const current = parseUserFacetKey(r.facetKey) === undefined ? undefined : await readFacet(tx, userId, r.facetKey);
    results.push(result(r.facetKey, outcome, current, r.reason));
  }
  return create(PushResponseSchema, { results });
}

export function createSyncRoutes(deps: SyncRoutesDeps): (router: ConnectRouter) => void {
  const { db } = deps;
  const writers = deps.writers ?? new KeyedSerialiser(MAX_QUEUED_PUSHES);
  const holds = deps.holds ?? holdNothing;

  const delta = async (req: DeltaRequest, ctx: HandlerContext): Promise<DeltaResponse> => {
    const caller = callerOf(ctx);
    const after = decodeCursor(req.cursor);
    // A cursor past anything this database issued comes from another database (a restore).
    if (after === undefined || (after > 0n && after > (await issuedHead(db)))) {
      throw new ConnectError('unreadable cursor: replay from an empty cursor', Code.InvalidArgument);
    }
    const limit = req.limit === 0 ? DEFAULT_PAGE : Math.min(req.limit, MAX_PAGE);
    const page = await readFeed(db, caller.userId, after, limit);
    const last = page.events.at(-1)?.seq ?? after;
    await recordCursor(db, caller.userId, caller.deviceId, after, last);
    return create(DeltaResponseSchema, {
      events: page.events.map(toWire),
      nextCursor: encodeCursor(last),
      hasMore: page.hasMore,
    });
  };

  const push = async (req: PushRequest, ctx: HandlerContext): Promise<PushResponse> => {
    const caller = callerOf(ctx);
    if (!CLIENT_ID.test(req.clientId)) {
      throw new ConnectError('client_id must be 1 to 128 printable ASCII characters, no spaces', Code.InvalidArgument);
    }
    if (req.events.length > MAX_BATCH) {
      throw new ConnectError(`a batch carries at most ${MAX_BATCH} events`, Code.InvalidArgument);
    }
    const requestSha256 = createHash('sha256').update(toBinary(PushRequestSchema, req)).digest();
    const deviceHex = normaliseDeviceId(caller.deviceId);

    const write = async (tx: TxClient): Promise<PushResponse> => {
      await boundLockWaits(tx, PUSH_LOCK_TIMEOUT_MS);
      await lockUser(tx, caller.userId);
      const receipt = await readReceipt(tx, caller.userId, req.clientId);
      if (receipt !== undefined) {
        if (!receipt.requestSha256.equals(requestSha256)) {
          throw new ConnectError('client_id was already used for a different batch', Code.InvalidArgument);
        }
        return replay(tx, caller.userId, fromBinary(PushResponseSchema, receipt.outcomes));
      }

      const now = await serverNow(tx);
      const verdicts = req.events.map((event) => validateEvent(event, { deviceHex, nowMicros: now.micros }));
      const facets = req.events.map(
        (event): Facet => ({
          facetKey: event.facetKey,
          version: event.version,
          op: event.op === SyncOp.DELETE ? 'delete' : 'upsert',
          payload: event.payload,
        }),
      );
      // Every REJECTED check runs before HELD routing: only an edit that passed them can be held.
      const edits = verdicts.flatMap((verdict, index) => (verdict.ok ? [{ ...facets[index]!, index, basisSeq: verdict.basisSeq }] : []));
      const held = await holds(tx, caller.userId, edits);

      const feed = new FeedTransaction();
      const results: PushResult[] = [];
      const applied: Facet[] = [];
      for (const [index, verdict] of verdicts.entries()) {
        const facet = facets[index]!;
        if (!verdict.ok) {
          const current = verdict.userOwned ? await readFacet(tx, caller.userId, facet.facetKey) : undefined;
          results.push(result(facet.facetKey, PushOutcome.REJECTED, current, verdict.reason));
        } else if (held.has(index)) {
          await keepHeld(tx, caller.userId, { ...facet, clientId: req.clientId, ordinal: index, basisSeq: verdict.basisSeq });
          results.push(result(facet.facetKey, PushOutcome.HELD, await readFacet(tx, caller.userId, facet.facetKey)));
        } else {
          const placed = (await deps.imports?.answer(tx, caller.userId, facet, feed)) ?? (await applyEvent(tx, caller.userId, facet, feed));
          if (placed.applied) applied.push(facet);
          results.push(result(facet.facetKey, placed.applied ? PushOutcome.APPLIED : PushOutcome.STALE, placed.current));
        }
      }
      await deps.imports?.applied(tx, caller.userId, applied);
      const response = create(PushResponseSchema, { results });
      await writeReceipt(tx, caller.userId, req.clientId, requestSha256, Buffer.from(outcomesOf(response)));
      return response;
    };
    try {
      // The signal aborts when the client goes away, which drops this Push if it is still queued.
      return await writers.run(caller.userId, () => transaction(db, write), ctx.signal);
    } catch (err) {
      // Retryable with the same client_id, like a lock timeout; RESOURCE_EXHAUSTED means split the batch.
      if (err instanceof QueueFull) {
        throw new ConnectError(`at most ${MAX_QUEUED_PUSHES} Pushes per user may run or wait here: retry later`, Code.Unavailable);
      }
      if ((err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
        throw new ConnectError("this user's writes are held elsewhere: retry later", Code.Unavailable);
      }
      throw err;
    }
  };

  const status = async (_req: unknown, ctx: HandlerContext): Promise<StatusResponse> => {
    const caller = callerOf(ctx);
    const head = await feedHead(db, caller.userId);
    const now = await serverNow(db);
    const pendingReview = (await deps.imports?.pendingReview(db, caller.userId)) ?? 0n;
    return create(StatusResponseSchema, { cursor: encodeCursor(head), pendingReview, serverNowIso: now.iso });
  };

  return (router: ConnectRouter) => {
    router.service(SyncService, { delta, push, status });
  };
}
