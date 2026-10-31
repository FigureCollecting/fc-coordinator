// The sync log seam: what SyncService writes about a Push, one `sync.push` line per Push, never one
// per event. A line is built from what the server answered (PushResponse) or the Connect code it
// failed with, and from what the server measured as it placed the Push (Arrival): ages and counts.
// Of what the client sent, a line takes only a well-formed origin_trace (originTraceFields). Every
// field goes through the allow-list below before it reaches the logger. The logger adds the
// request's trace (src/platform/logger.ts).
//
// NEVER on a line: SyncEvent.version (it carries the DPoP device id), facet_key, payload, basis,
// commit_cursor, client_id, the sub, the device id, a reason's detail (only its code), a raw
// delay or instant (only its age bucket: the exact value would date the user's edit), or a
// malformed origin_trace (only how many events carried one).
//
// THE SYNC DELAY of an event is server_now minus its version instant: the phone's HLC, anchored to
// the offset it measured against server_now (sync.proto rule 5). It is an ESTIMATE, wrong in either
// direction, and the line says so with age_basis=version:
// - too long: an edit minted on a phone clock running behind the server, or under a stale offset
//   kept from an earlier session, keeps its low version (fc-mobile's rebase re-versions only the
//   edits ahead of the present);
// - too short: a rebase re-version or a version_future re-mint restarts the clock, and an edit
//   minted on top of a base written later (by a fast-clock device, or the import) takes that base's
//   instant (Hlc.tick(base));
// - slightly negative for a fresh edit: the phone samples the offset at the midpoint of a probe
//   whose round trip it clamps to 3 s (fc-mobile src/sync/engine.ts PROBE_TIMEOUT_MS), so the offset
//   is off by up to about 1.5 s, and it pushes about 1 s after the write. A delay from 3 s ahead to
//   10 s is therefore `<10s`, and only a version more than 3 s ahead is `ahead`.
// Nothing is clamped: every delay lands in the one bucket its value names.
import { Code, ConnectError } from '@connectrpc/connect';
import { codeToString } from '@connectrpc/connect/protocol-connect';
import { PUSH_REJECT_REASONS, PushOutcome, isTraceId, type PushResponse, type SyncEvent } from '@figurecollecting/fc-api-contract';

/** The msg of the line each Push writes: `jq 'select(.msg == "sync.push")'`. */
export const PUSH_LINE = 'sync.push';

export type SyncLogLevel = 'info' | 'warn';

/** Where SyncService writes a line: the app's logger in production (src/connect/register.ts). */
export type SyncLog = (level: SyncLogLevel, fields: Record<string, unknown>, message: string) => void;

/** The count field of each outcome. Typed over the whole enum, so a new outcome fails the build here. */
const OUTCOME_FIELDS: Record<PushOutcome, string> = {
  [PushOutcome.UNSPECIFIED]: 'unspecified',
  [PushOutcome.APPLIED]: 'applied',
  [PushOutcome.DUPLICATE]: 'duplicate',
  [PushOutcome.STALE]: 'stale',
  [PushOutcome.REVIEW]: 'review',
  [PushOutcome.REJECTED]: 'rejected',
  [PushOutcome.HELD]: 'held',
};

/** Every field a sync line may carry; any other is dropped before the line is written. */
export const SYNC_LOG_FIELDS: ReadonlySet<string> = new Set([
  'outcome',
  'replay',
  'events',
  ...Object.values(OUTCOME_FIELDS),
  'reasons',
  'code',
  'age_basis',
  'ages',
  'oldest_age',
  'resend_stale',
  'origin_trace',
  'origin_trace_more',
  'origin_trace_malformed',
  'origin_trace_absent',
]);

/** `fields` with only the keys `allowed` names. */
export function allowListed(fields: Record<string, unknown>, allowed: ReadonlySet<string> = SYNC_LOG_FIELDS): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([key]) => allowed.has(key)));
}

const REJECT_CODES: ReadonlySet<string> = new Set(PUSH_REJECT_REASONS);

/** A reason's code, the text before its first ':' (sync.proto PushResult.reason); `other` when it is no contract code. */
function reasonCode(reason: string): string {
  const code = reason.split(':', 1)[0]!.trim();
  return REJECT_CODES.has(code) ? code : 'other';
}

const SECOND = 1_000_000n;
const MINUTE = 60n * SECOND;
const HOUR = 60n * MINUTE;
const DAY = 24n * HOUR;

/** A version further ahead of server_now than this is `ahead`; one less far is within the phone's offset error. */
export const AHEAD_BEYOND_MICROS = 3n * SECOND;

/** Each bucket below `ahead` and the delay it runs up to, exclusive; any longer is `>=7d`. */
const AGE_LIMITS = [
  ['<10s', 10n * SECOND],
  ['<1m', MINUTE],
  ['<10m', 10n * MINUTE],
  ['<1h', HOUR],
  ['<6h', 6n * HOUR],
  ['<24h', DAY],
  ['<7d', 7n * DAY],
] as const;

/** The age buckets, youngest first: `ages` counts events by these, and `oldest_age` is one of them. */
export const AGE_BUCKETS = ['ahead', ...AGE_LIMITS.map(([bucket]) => bucket), '>=7d'] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

/** The bucket of a sync delay in microseconds (server_now minus the version instant). */
export function ageBucket(delayMicros: bigint): AgeBucket {
  if (delayMicros < -AHEAD_BEYOND_MICROS) return 'ahead';
  for (const [bucket, below] of AGE_LIMITS) {
    if (delayMicros < below) return bucket;
  }
  return '>=7d';
}

/**
 * What the server read as it placed a Push, in push order, to measure it by. Nothing here is ever
 * copied onto a line: only the buckets and counts measured from it are.
 */
export interface Arrival {
  /** server_now when the Push was placed (store.ts serverNow), in epoch microseconds. */
  nowMicros: bigint;
  /** Each event's version instant (validate.ts Verdict.micros); undefined when its version did not parse. */
  instants: readonly (bigint | undefined)[];
  /** Each event's version as sent, to tell a STALE that was answered with the event's own version. */
  versions: readonly string[];
}

/**
 * The line of a Push the server answered: how many events, how many of each outcome, the REJECTED
 * by code, and whether it replayed a receipt (the same client_id sent again). Every count is
 * present, zero or not, and the counts add up to `events`.
 *
 * With the Arrival of a placed Push it also carries:
 * - `ages`: how many events had each sync delay (see THE SYNC DELAY above), by bucket. Every event
 *   whose version parsed is aged, so a version_future reject counts as `ahead`; one whose version
 *   did not parse is not.
 * - `oldest_age`: the bucket of the largest delay, how long the oldest edit in the batch waited to
 *   reach the server; an estimate either way like each age, not a bound. `none` when nothing was aged.
 * - `resend_stale`: the events answered STALE with their own version, that is an edit the server
 *   already held sent again under a new client_id, or twice in one batch. A CLIENT-BUG DETECTOR
 *   that should read 0, not a duplicate ratio: receipts are never deleted (migrations/0003_sync.sql)
 *   and the phone resends an unanswered batch under its own client_id, which is `replay`.
 * A replay has no Arrival and measures nothing (`ages` {}, `oldest_age` none, `resend_stale` 0):
 * its edits arrived with the Push it repeats, whose line measured them.
 */
export function pushLine(response: PushResponse, replay: boolean, arrival?: Arrival): Record<string, unknown> {
  const counts = Object.fromEntries(Object.values(OUTCOME_FIELDS).map((field) => [field, 0])) as Record<string, number>;
  const reasons: Record<string, number> = {};
  let resendStale = 0;
  for (const [index, result] of response.results.entries()) {
    counts[OUTCOME_FIELDS[result.outcome] ?? OUTCOME_FIELDS[PushOutcome.UNSPECIFIED]]! += 1;
    if (result.outcome === PushOutcome.REJECTED) {
      const code = reasonCode(result.reason);
      reasons[code] = (reasons[code] ?? 0) + 1;
    }
    // PushResult.version is wire compatibility only (sync.proto): the answer is current.version.
    if (result.outcome === PushOutcome.STALE && arrival !== undefined && result.current?.version === arrival.versions[index]) {
      resendStale += 1;
    }
  }

  const ages: Partial<Record<AgeBucket, number>> = {};
  let oldest: bigint | undefined;
  for (const instant of arrival?.instants ?? []) {
    if (instant === undefined) continue;
    const delay = arrival!.nowMicros - instant;
    const bucket = ageBucket(delay);
    ages[bucket] = (ages[bucket] ?? 0) + 1;
    if (oldest === undefined || delay > oldest) oldest = delay;
  }

  return allowListed({
    outcome: 'ok',
    replay,
    events: response.results.length,
    ...counts,
    reasons,
    age_basis: 'version',
    ages,
    oldest_age: oldest === undefined ? 'none' : ageBucket(oldest),
    resend_stale: resendStale,
  });
}

/**
 * The line of a Push that failed: the Connect code the client was answered (Connect answers any
 * error that is not a ConnectError INTERNAL) and how many events it carried. Never the message: a
 * database error's text can quote a value.
 */
export function pushErrorLine(err: unknown, events: number): Record<string, unknown> {
  const code = err instanceof ConnectError ? err.code : Code.Internal;
  return allowListed({ outcome: 'error', code: codeToString(code), events });
}

/** The most distinct origin_trace values one line lists; origin_trace_more counts the rest. */
export const ORIGIN_TRACE_CAP = 20;

/**
 * The origin_trace fields of a Push's line (sync.proto SyncEvent.origin_trace, 0.7.0): which user
 * actions minted the edits it carries, so an action can be found by the id the device kept. Read
 * from the request on every line, the replay's and the refused Push's included:
 * - `origin_trace`: each distinct value isTraceId calls well-formed, in push order (oldest edit
 *   first), at most ORIGIN_TRACE_CAP; find a Push by one with
 *   `jq 'select(.msg == "sync.push" and any(.origin_trace[]?; . == "<id>"))'`;
 * - `origin_trace_more`: how many distinct well-formed values past those;
 * - `origin_trace_malformed`: how many events carried any other value, whatever its length; the
 *   value itself is never written;
 * - `origin_trace_absent`: how many carried none, as every event from an app built before 0.7.0.
 * The value is client-chosen and unchecked, so a join on it is a lead, never proof.
 */
export function originTraceFields(events: readonly Pick<SyncEvent, 'originTrace'>[]): Record<string, unknown> {
  const wellFormed = new Set<string>();
  let malformed = 0;
  let absent = 0;
  for (const { originTrace } of events) {
    if (originTrace === undefined) absent += 1;
    else if (isTraceId(originTrace)) wellFormed.add(originTrace);
    else malformed += 1;
  }
  const listed = [...wellFormed];
  return allowListed({
    origin_trace: listed.slice(0, ORIGIN_TRACE_CAP),
    origin_trace_more: Math.max(0, listed.length - ORIGIN_TRACE_CAP),
    origin_trace_malformed: malformed,
    origin_trace_absent: absent,
  });
}
