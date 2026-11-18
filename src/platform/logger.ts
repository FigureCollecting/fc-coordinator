// ============================================================================
// Structured logging for fc-coordinator: fc-shared's server logger (LG-C1).
//
// Every line is one JSON object in the estate's log shape:
//
//   time level service version event msg [call code duration_ms peer]
//   trace_id span_id [job err queue_ms run_id], then the line's own fields
//
// trace_id and span_id are the ACTIVE span's and are absent, never zeroed,
// without one, so a single traceparent joins this service's lines to
// SpineRead's and media-manager's. The `trace=<id> span=<id>` string and the
// camelCase traceId/spanId this service wrote before are gone.
//
// What fc-shared does with a line's own fields, because it differs from the
// local logger this replaced:
//   - a key prints in lowercase snake_case (reqId -> req_id);
//   - a value is a flat scalar: an object or array prints as ONE JSON string
//     (`ages` on a sync.push line is '{"<10s":2}', read with jq's fromjson);
//   - a Fastify request prints as {method, url} and a reply as {statusCode};
//     the client address the local serialiser wrote is no longer on the line;
//   - redaction is fc-shared's policy with this service's DPoP key pattern
//     (COORDINATOR_REDACT_OPTIONS). src/platform/redaction-keys.test.ts holds
//     the list of keys the local copy masked and proves each still is.
//
// `version` is the image's revision: CI builds the image with SERVICE_VERSION
// set to the commit, and server.ts hands it here from the telemetry state.
//
// The logger is pino-compatible (level, trace..fatal, silent, child), so it is
// handed to Fastify as `loggerInstance`.
//
// Two things this file adds to fc-shared's logger:
//   - THE LEVEL IS CHECKED. server.ts hands over LOG_LEVEL as it was typed, and
//     fc-shared takes an explicit level unchecked: one it does not know
//     ('INFO', 'warning') silences every line. Here it is trimmed and
//     lowercased, and anything that still names no level means 'info', said
//     once in a `log.level_fallback` warn line.
//   - AN ERROR LINE CARRIES ITS STACK. fc-shared's `err` is {type, message}.
//     On an error or fatal line with an Error (the first argument, or `err` in
//     the merge object, which is how Fastify logs a 500) the stack's frames
//     are added as `error.stack`, which fc-shared prints as `error_stack`: one
//     line, redacted as any field is, cut at its 1000-character cap. Only the
//     frames: V8's header repeats the message, which is already on the line as
//     err.message, masked as a message is (a JSON document's keys, a header
//     line, a form body). Those rules do not see a message once frames follow
//     it, so a secret in a message could ride the header; it is not printed.
// ============================================================================
import type { FastifyBaseLogger } from 'fastify';
import { COORDINATOR_REDACT_OPTIONS, LOG_LEVELS, createLogger, type LevelSetting, type SharedLogger } from './shared.js';

export const DEFAULT_SERVICE_NAME = 'fc-coordinator';

export type LogLevel = LevelSetting;
export type LogSink = (line: string) => void;
/**
 * Fastify's logger type, not fc-shared's: fc-shared's adds isLevelEnabled, and
 * Fastify would then infer a logger type its own plugin signatures do not take.
 */
export type StructuredLogger = FastifyBaseLogger;

export interface LoggerOptions {
  /** `service` on every line. Default 'fc-coordinator'. */
  service?: string;
  /** `version` on every line: the image's revision. Default 'unknown'. */
  version?: string;
  /**
   * Minimum severity emitted, as an operator may have typed it: a LogLevel in
   * any case, spaces around it allowed. Default, and for any other value, 'info'.
   */
  level?: string;
  /** Where a finished line goes. Default: one line on stdout. */
  sink?: LogSink;
}

const KNOWN_LEVELS: ReadonlySet<string> = new Set<LogLevel>([...LOG_LEVELS, 'silent']);

/** The level a setting names, or undefined when it names none. */
function levelOf(given: unknown): LogLevel | undefined {
  const normalised = typeof given === 'string' ? given.trim().toLowerCase() : undefined;
  return normalised !== undefined && KNOWN_LEVELS.has(normalised) ? (normalised as LogLevel) : undefined;
}

/** A stack frame line, as V8 writes one ('    at fn (file.js:1:2)'). */
const STACK_FRAME = /^\s+at /;
/** Printed as `error_stack`: fc-shared writes every key in snake_case. */
const STACK_KEY = 'error.stack';

/** The frames of an Error's stack, without the header that repeats its message; undefined when it has none. */
function framesOf(error: Error): string | undefined {
  const { stack } = error;
  if (typeof stack !== 'string') return undefined;
  const frames = stack.split('\n').filter((line) => STACK_FRAME.test(line));
  return frames.length > 0 ? frames.join('\n') : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A log call's arguments with the stack added, for the two shapes that carry an
 * Error: (err, ...msg) and ({ err, ... }, ...msg). Any other call, an Error
 * with no frames, and one that cannot be read are returned as they came.
 */
function withStack(args: unknown[]): unknown[] {
  try {
    const [first, ...rest] = args;
    if (first instanceof Error) {
      const stack = framesOf(first);
      if (stack === undefined) return args;
      // fc-shared reads (err, ...msg) as { err } and the message, the Error's own when none follows.
      return [{ err: first, [STACK_KEY]: stack }, ...(rest.length > 0 ? rest : [first.message])];
    }
    if (isPlainObject(first) && first['err'] instanceof Error) {
      const stack = framesOf(first['err']);
      return stack === undefined ? args : [{ ...first, [STACK_KEY]: stack }, ...rest];
    }
    return args;
  } catch {
    return args;
  }
}

function withErrorStacks(base: SharedLogger): SharedLogger {
  return {
    ...base,
    error: (...args) => base.error(...withStack(args)),
    fatal: (...args) => base.fatal(...withStack(args)),
    child: (bindings, options) => withErrorStacks(base.child(bindings, options)),
  };
}

/**
 * The service's logger. It reads NO environment: fc-shared would otherwise take
 * the level, the format and the identity from process.env, and buildApp is a
 * library whose caller decides them.
 */
export function createStructuredLogger(options: LoggerOptions = {}): StructuredLogger {
  const level = levelOf(options.level);
  const logger = withErrorStacks(
    createLogger({
      env: {},
      service: options.service ?? DEFAULT_SERVICE_NAME,
      level: level ?? 'info',
      redact: COORDINATOR_REDACT_OPTIONS,
      ...(options.version !== undefined ? { version: options.version } : {}),
      ...(options.sink !== undefined ? { sink: options.sink } : {}),
    }),
  );
  if (options.level !== undefined && level === undefined) {
    logger.warn(
      { event: 'log.level_fallback', log_level_given: options.level, log_level: 'info' },
      'LOG_LEVEL names no level; logging at info',
    );
  }
  return logger;
}
