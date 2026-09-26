// coordinator.v1.SyncService: Delta, Push and Status over migrations/0003_sync.sql.
// The user is the token's `sub` and the device is the DPoP binding; the client names neither.
// REVIEW is never emitted: there are no policy tables yet, so every user facet is AUTO_ACCEPT.
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
import { KeyedSerialiser } from './serialise.js';
import {
  applyEvent,
  feedHead,
  issuedHead,
  lockUser,
  readFacet,
  readFeed,
  readReceipt,
  recordCursor,
  serverNow,
  transaction,
  writeReceipt,
  type Facet,
  type SqlClient,
  type SyncPool,
  type TxClient,
} from './store.js';
import { validateEvent } from './validate.js';

export const DEFAULT_PAGE = 500;
export const MAX_PAGE = 1000;
export const MAX_BATCH = 200;
/** Printable ASCII, no space, 1 to 128 characters: a uuid fits and the receipt key stays indexable. */
const CLIENT_ID = /^[\x21-\x7e]{1,128}$/;

export interface SyncRoutesDeps {
  db: SyncPool;
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

const toWire = (facet: Facet): SyncEvent =>
  create(SyncEventSchema, {
    facetKey: facet.facetKey,
    version: facet.version,
    op: facet.op === 'delete' ? SyncOp.DELETE : SyncOp.UPSERT,
    payload: facet.payload,
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

// The receipt holds the answer a replay gets: APPLIED becomes DUPLICATE, and every outcome and
// reason is repeated as first given.
const asReplay = (response: PushResponse): PushResponse =>
  create(PushResponseSchema, {
    results: response.results.map((r) =>
      r.outcome === PushOutcome.APPLIED ? create(PushResultSchema, { ...r, outcome: PushOutcome.DUPLICATE }) : r,
    ),
  });

// A REJECTED `current` is re-read on replay. The client adopts it whole while it holds the rejected
// edit, and may since have pulled a write older than that edit, so a recorded one would undo it.
async function replay(tx: SqlClient, userId: string, recorded: PushResponse): Promise<PushResponse> {
  const results: PushResult[] = [];
  for (const r of recorded.results) {
    const reread = r.outcome === PushOutcome.REJECTED && parseUserFacetKey(r.facetKey) !== undefined;
    results.push(reread ? result(r.facetKey, r.outcome, await readFacet(tx, userId, r.facetKey), r.reason) : r);
  }
  return create(PushResponseSchema, { results });
}

export function createSyncRoutes(deps: SyncRoutesDeps): (router: ConnectRouter) => void {
  const { db } = deps;
  const writers = new KeyedSerialiser();

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
      await lockUser(tx, caller.userId);
      const receipt = await readReceipt(tx, caller.userId, req.clientId);
      if (receipt !== undefined) {
        if (!receipt.requestSha256.equals(requestSha256)) {
          throw new ConnectError('client_id was already used for a different batch', Code.InvalidArgument);
        }
        return replay(tx, caller.userId, fromBinary(PushResponseSchema, receipt.response));
      }

      const now = await serverNow(tx);
      const results: PushResult[] = [];
      for (const event of req.events) {
        const verdict = validateEvent(event, { deviceHex, nowMicros: now.micros });
        if (!verdict.ok) {
          const current = verdict.userOwned ? await readFacet(tx, caller.userId, event.facetKey) : undefined;
          results.push(result(event.facetKey, PushOutcome.REJECTED, current, verdict.reason));
          continue;
        }
        const applied = await applyEvent(tx, caller.userId, {
          facetKey: event.facetKey,
          version: event.version,
          op: event.op === SyncOp.DELETE ? 'delete' : 'upsert',
          payload: event.payload,
        });
        results.push(result(event.facetKey, applied.applied ? PushOutcome.APPLIED : PushOutcome.STALE, applied.current));
      }
      const response = create(PushResponseSchema, { results });
      await writeReceipt(tx, caller.userId, req.clientId, requestSha256, Buffer.from(toBinary(PushResponseSchema, asReplay(response))));
      return response;
    };
    return writers.run(caller.userId, () => transaction(db, write));
  };

  const status = async (_req: unknown, ctx: HandlerContext): Promise<StatusResponse> => {
    const caller = callerOf(ctx);
    const head = await feedHead(db, caller.userId);
    const now = await serverNow(db);
    return create(StatusResponseSchema, { cursor: encodeCursor(head), pendingReview: 0n, serverNowIso: now.iso });
  };

  return (router: ConnectRouter) => {
    router.service(SyncService, { delta, push, status });
  };
}
