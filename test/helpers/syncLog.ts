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

  /** Every line whose msg starts `sync.`, from `mark` on, read with parseLine. */
  sync(mark = 0): LogLine[] {
    return this.raw
      .slice(mark)
      .map(parseLine)
      .filter((line) => typeof line['msg'] === 'string' && line['msg'].startsWith('sync.'));
  }

  /** The same lines as written: every field a scalar, an object or array field still one JSON string. */
  syncAsWritten(mark = 0): LogLine[] {
    return this.raw
      .slice(mark)
      .map((line) => JSON.parse(line) as LogLine)
      .filter((line) => typeof line['msg'] === 'string' && line['msg'].startsWith('sync.'));
  }
}

/**
 * A log line as a reader takes it. fc-shared's log shape writes every field as a flat scalar, so
 * an object or array a caller logged (`ages`, `reasons`, `origin_trace`, a display line's
 * `denials`) is ONE JSON string on the line: `jq '.ages | fromjson'`. This reads those back, so an
 * assertion can name the structure the caller logged. A string that is not a JSON object or array
 * is left as it is.
 */
export function parseLine(line: string): LogLine {
  const entry = JSON.parse(line) as LogLine;
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value !== 'string' || !/^[[{]/.test(value)) continue;
    try {
      entry[key] = JSON.parse(value) as unknown;
    } catch {
      // Not JSON after all: the string stands.
    }
  }
  return entry;
}

/** The fields the logger writes on every line, beside the line's own (fc-shared's log shape, src/platform/logger.ts). */
export const LOGGER_FIELDS: ReadonlySet<string> = new Set([
  'time', 'level', 'service', 'version', 'event', 'msg', 'trace_id', 'span_id',
]);

/** The trace id a line carries: the request's, from its traceparent. */
export const traceIdOf = (line: LogLine): unknown => line['trace_id'];
