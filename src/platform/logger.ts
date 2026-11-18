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
// ============================================================================
import type { FastifyBaseLogger } from 'fastify';
import { COORDINATOR_REDACT_OPTIONS, createLogger, type LevelSetting } from './shared.js';

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
  /** Minimum severity emitted. Default 'info'. */
  level?: LogLevel;
  /** Where a finished line goes. Default: one line on stdout. */
  sink?: LogSink;
}

/**
 * The service's logger. It reads NO environment: fc-shared would otherwise take
 * the level, the format and the identity from process.env, and buildApp is a
 * library whose caller decides them.
 */
export function createStructuredLogger(options: LoggerOptions = {}): StructuredLogger {
  return createLogger({
    env: {},
    service: options.service ?? DEFAULT_SERVICE_NAME,
    level: options.level ?? 'info',
    redact: COORDINATOR_REDACT_OPTIONS,
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.sink !== undefined ? { sink: options.sink } : {}),
  });
}
