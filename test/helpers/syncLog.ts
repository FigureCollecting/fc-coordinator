// The sync lines of a captured log, read by JSON field (the logger writes JSON fields, never
// k=v text). Every assertion on a sync line reads its trace id through traceIdOf, so a rename of
// the logger's trace keys (lg-logging U8: traceId to trace_id) changes this file only.
import type { LogSink } from '../../src/platform/logger.js';

export type LogLine = Record<string, unknown>;

export class CapturedLog {
  readonly raw: string[] = [];
  readonly sink: LogSink = (line) => {
    this.raw.push(line);
  };

  /** Where the log ends now: pass it to sync() to read only what came after. */
  mark(): number {
    return this.raw.length;
  }

  /** Every line whose msg starts `sync.`, from `mark` on. */
  sync(mark = 0): LogLine[] {
    return this.raw
      .slice(mark)
      .map((line) => JSON.parse(line) as LogLine)
      .filter((line) => typeof line['msg'] === 'string' && line['msg'].startsWith('sync.'));
  }
}

/** The fields the logger writes on every line, beside the line's own (src/platform/logger.ts). */
export const LOGGER_FIELDS: ReadonlySet<string> = new Set(['level', 'time', 'name', 'msg', 'trace', 'traceId', 'spanId']);

/** The trace id a line carries: the request's, from its traceparent. */
export const traceIdOf = (line: LogLine): unknown => line['traceId'];
