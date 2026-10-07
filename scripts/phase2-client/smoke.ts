// The sync smoke: Status, then ONE Push, then Delta from the Status cursor shows what was pushed.
//
// It writes contract 0.3.0's keys (Ross, GR 2026-09-26): one new copy, occ/{occ}/head with its
// occ/{occ}/status, in one batch, as fc-mobile writes a copy's first status. Never holding/*,
// which 0.3.0 retires. A coordinator that predates 0.3.0 (develop before WK-05b) REJECTS both
// facet_key_not_user_owned, and the smoke fails saying so rather than falling back to a key the
// estate has retired.
//
// The copy is a throwaway: a fresh occurrence id, a random head_id that names no product, status
// `wished`. Once the Push has APPLIED its status it is tombstoned (a second Push, DELETE of the
// status, which is how a copy is removed), whatever failed after, so a live run leaves no live
// copy in the account it signed in as; a tombstone the coordinator refuses is said out loud.
import { randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import {
  DeltaRequestSchema,
  DeltaResponseSchema,
  Hlc,
  PushOutcome,
  PushRequestSchema,
  PushResponseSchema,
  StatusRequestSchema,
  StatusResponseSchema,
  SyncEventSchema,
  SyncOp,
  type SyncEvent,
} from '@figurecollecting/fc-api-contract';
import type { CaseContext, CaseResult } from './cases.js';
import { occKey, occPayload } from './occ030.js';

const SYNC = '/coordinator.v1.SyncService';
/** Delta pages are 500 events by default; a fresh test account has a handful. */
const MAX_DELTA_PAGES = 20;

const fail = (detail: string): CaseResult => ({ id: 'smoke', verdict: 'FAIL', detail });
/** A 0.3.0 server may answer an outcome 0.2.1 has no name for (HELD); say its number. */
const named = (outcome: PushOutcome | undefined): string => (outcome === undefined ? 'no result' : (PushOutcome[outcome] ?? `outcome ${outcome}`));

export async function syncSmoke(ctx: CaseContext): Promise<CaseResult> {
  const { session, primary } = ctx;

  const sent = ctx.now();
  const status = await session.unary(primary, `${SYNC}/Status`, StatusRequestSchema, StatusResponseSchema, create(StatusRequestSchema, {}), 'smoke:status');
  if (!status.ok) return fail(`Status answered ${status.status} ${status.code}`.trimEnd());
  const hlc = new Hlc({ deviceId: ctx.primaryDeviceId });
  hlc.measure(status.message.serverNowIso, ctx.now() - sent);

  const occ = randomUUID();
  const display = { editedAt: new Date(ctx.now()).toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
  const events: SyncEvent[] = [
    create(SyncEventSchema, { facetKey: occKey(occ, 'head'), version: hlc.tick(undefined), op: SyncOp.UPSERT, payload: occPayload({ field: 'head', headId: randomUUID(), ...display }) }),
    create(SyncEventSchema, { facetKey: occKey(occ, 'status'), version: hlc.tick(undefined), op: SyncOp.UPSERT, payload: occPayload({ field: 'status', status: 'wished', ...display }) }),
  ];
  const keys = events.map((e) => e.facetKey).join(', ');

  const push = await session.unary(primary, `${SYNC}/Push`, PushRequestSchema, PushResponseSchema, create(PushRequestSchema, { clientId: randomUUID(), events }), 'smoke:push');
  if (!push.ok) return fail(`Push answered ${push.status} ${push.code}`.trimEnd());
  const refused = push.message.results.filter((r) => r.outcome !== PushOutcome.APPLIED);
  let problem: string | undefined;
  if (refused.length > 0 || push.message.results.length !== events.length) {
    const why = refused.map((r) => `${r.facetKey}: ${named(r.outcome)} ${r.reason}`.trimEnd()).join('; ');
    const predates = refused.some((r) => r.reason.startsWith('facet_key_not_user_owned'))
      ? ' (this coordinator predates fc-api-contract 0.3.0: WK-05b)'
      : '';
    problem = `Push of ${keys} was not APPLIED: ${why || `${push.message.results.length} results for ${events.length} events`}${predates}`;
  } else {
    problem = await deltaMisses(ctx, status.message.cursor, events);
  }

  // Results answer the events in order. A status not APPLIED has set `problem` above; an APPLIED
  // one is a live copy, so it is tombstoned whatever else failed.
  const statusEvent = events[1]!;
  if (push.message.results[1]?.outcome !== PushOutcome.APPLIED) return fail(problem!);
  const tombstone = create(SyncEventSchema, { facetKey: statusEvent.facetKey, version: hlc.tick(statusEvent.version), op: SyncOp.DELETE, payload: '' });
  const cleanup = await session.unary(primary, `${SYNC}/Push`, PushRequestSchema, PushResponseSchema, create(PushRequestSchema, { clientId: randomUUID(), events: [tombstone] }), 'smoke:push-cleanup');
  const said = problem ?? `Status, then one Push (${keys}: APPLIED), then Delta from the Status cursor shows both`;
  if (!cleanup.ok || cleanup.message.results[0]?.outcome !== PushOutcome.APPLIED) {
    const how = cleanup.ok ? named(cleanup.message.results[0]?.outcome) : `${cleanup.status} ${cleanup.code}`;
    return fail(`${said}; ${problem === undefined ? 'but' : 'and'} the cleanup tombstone of ${statusEvent.facetKey} was not applied (${how}): a wished copy is left live`);
  }
  const detail = `${said}; cleanup: the copy's status tombstoned`;
  return problem === undefined ? { id: 'smoke', verdict: 'PASS', detail } : fail(detail);
}

/** Read Delta from the Status cursor until it shows every event as pushed: undefined, or what it missed. */
async function deltaMisses(ctx: CaseContext, from: string, events: SyncEvent[]): Promise<string | undefined> {
  let cursor = from;
  const seen = new Set<string>();
  for (let page = 0; page < MAX_DELTA_PAGES; page += 1) {
    const delta = await ctx.session.unary(ctx.primary, `${SYNC}/Delta`, DeltaRequestSchema, DeltaResponseSchema, create(DeltaRequestSchema, { cursor }), 'smoke:delta');
    if (!delta.ok) return `Delta answered ${delta.status} ${delta.code}`.trimEnd();
    for (const got of delta.message.events) {
      const mine = events.find((e) => e.facetKey === got.facetKey && e.version === got.version && e.op === got.op && e.payload === got.payload);
      if (mine !== undefined) seen.add(mine.facetKey);
    }
    if (!delta.message.hasMore || seen.size === events.length) break;
    cursor = delta.message.nextCursor;
  }
  if (seen.size === events.length) return undefined;
  return `Delta from the Status cursor did not show ${events.filter((e) => !seen.has(e.facetKey)).map((e) => e.facetKey).join(', ')} as pushed`;
}
