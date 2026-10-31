// The sync log seam: what SyncService writes about a Push, one `sync.push` line per Push, never one
// per event. A line is built from what the server answered (PushResponse) or the Connect code it
// failed with, and of what the client sent it takes only a well-formed origin_trace
// (originTraceFields). Every field goes through the allow-list below before it reaches the logger.
// The logger adds the request's trace (src/platform/logger.ts).
//
// NEVER on a line: SyncEvent.version (it carries the DPoP device id), facet_key, payload, basis,
// commit_cursor, client_id, the sub, the device id, a reason's detail (only its code), or a
// malformed origin_trace (only how many events carried one).
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

/**
 * The line of a Push the server answered: how many events, how many of each outcome, the REJECTED
 * by code, and whether it replayed a receipt (the same client_id sent again). Every count is
 * present, zero or not, and the counts add up to `events`.
 */
export function pushLine(response: PushResponse, replay: boolean): Record<string, unknown> {
  const counts = Object.fromEntries(Object.values(OUTCOME_FIELDS).map((field) => [field, 0])) as Record<string, number>;
  const reasons: Record<string, number> = {};
  for (const result of response.results) {
    counts[OUTCOME_FIELDS[result.outcome] ?? OUTCOME_FIELDS[PushOutcome.UNSPECIFIED]]! += 1;
    if (result.outcome === PushOutcome.REJECTED) {
      const code = reasonCode(result.reason);
      reasons[code] = (reasons[code] ?? 0) + 1;
    }
  }
  return allowListed({ outcome: 'ok', replay, events: response.results.length, ...counts, reasons });
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
