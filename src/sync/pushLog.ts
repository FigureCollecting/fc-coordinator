// The sync log seam: what SyncService writes about a Push, one `sync.push` line per Push, never one
// per event. A line is built from what the server answered (PushResponse) or the Connect code it
// failed with, never from what the client sent, and every field goes through the allow-list below
// before it reaches the logger. The logger adds the request's trace (src/platform/logger.ts).
//
// NEVER on a line: SyncEvent.version (it carries the DPoP device id), facet_key, payload, basis,
// commit_cursor, client_id, the sub, the device id, or a reason's detail (only its code).
import { Code, ConnectError } from '@connectrpc/connect';
import { codeToString } from '@connectrpc/connect/protocol-connect';
import { PUSH_REJECT_REASONS, PushOutcome, type PushResponse } from '@figurecollecting/fc-api-contract';

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
export const SYNC_LOG_FIELDS: ReadonlySet<string> = new Set(['outcome', 'replay', 'events', ...Object.values(OUTCOME_FIELDS), 'reasons', 'code']);

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
