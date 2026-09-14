// ============================================================================
// Structured logging for fc-coordinator.
//
// Every line is one JSON object and carries the canonical fc-shared trace tag
// (`trace=<traceId> span=<spanId>`) whenever a span is active, so a single
// traceparent joins this service's logs to SpineRead's, media-manager's and
// fc-mobile's. The tag is ABSENT rather than zeroed when no span is active —
// fc-shared's trace.ts treats an all-zero id as "no span", and §A.5 rule 2
// exists because a no-op provider silently produces exactly that.
//
// Shaped as a pino-compatible logger so it can be handed to Fastify as
// `loggerInstance`: Fastify requires fatal/error/warn/info/debug/trace/child.
// ============================================================================
import {
  COORDINATOR_REDACT_OPTIONS,
  getActiveTraceIds,
  redactValue,
  sanitizeLogValue,
} from './shared.js';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const SEVERITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: 100,
};

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  /** Service/module name stamped on every line. */
  name?: string;
  /** Minimum severity emitted. Default 'info'. */
  level?: LogLevel;
  /** Where a finished line goes. Default: one line on stdout. */
  sink?: LogSink;
  /** Fields merged into every line (child loggers accumulate these). */
  bindings?: Record<string, unknown>;
}

export interface StructuredLogger {
  // Typed as `string`, not LogLevel, so the logger is structurally assignable
  // to Fastify's FastifyBaseLogger (pino's LevelWithSilentOrString) and can be
  // handed straight to Fastify as `loggerInstance`.
  readonly level: string;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  silent(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): StructuredLogger;
}

const defaultSink: LogSink = (line) => process.stdout.write(`${line}\n`);

/**
 * Split a pino-style call into (mergeObject, message). `log.info({a:1}, 'msg')`
 * and `log.info('msg')` are both valid; an Error first argument is a message,
 * not a merge object.
 */
function splitArgs(args: unknown[]): { fields: Record<string, unknown>; message: unknown } {
  const [first, ...rest] = args;
  if (first !== null && typeof first === 'object' && !(first instanceof Error) && !Array.isArray(first)) {
    return { fields: first as Record<string, unknown>, message: rest[0] };
  }
  return { fields: {}, message: first };
}

// Maximum object depth walked into a log field. Deliberately shallow: without
// it, one Fastify `{ req }` binding serialises the whole socket/server graph
// (a 40 KB line per request, measured), because fc-shared's default depth of 12
// is tuned for application payloads, not Node internals.
const MAX_FIELD_DEPTH = 4;

/**
 * Per-key reducers for the objects Fastify logs by default. Fastify exposes a
 * request's `method` and `url` as PROTOTYPE GETTERS, so they must be read by
 * property access — an own-keys walk (which is what a generic serialiser does)
 * misses them and keeps the circular `raw`/`socket` graph instead.
 */
const SERIALIZERS: Record<string, (value: unknown) => unknown> = {
  req: (value) => {
    if (value === null || typeof value !== 'object') return value;
    const req = value as { id?: unknown; method?: unknown; url?: unknown; ip?: unknown };
    return { id: req.id, method: req.method, url: req.url, remoteAddress: req.ip };
  },
  res: (value) => {
    if (value === null || typeof value !== 'object') return value;
    return { statusCode: (value as { statusCode?: unknown }).statusCode };
  },
};

/** Reduce known objects, redact by fc-shared policy, then make strings log-injection safe. */
function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const reduced: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) {
    const serializer = SERIALIZERS[key];
    reduced[key] = serializer ? serializer(fields[key]) : fields[key];
  }

  const redacted = redactValue(reduced, {
    ...COORDINATOR_REDACT_OPTIONS,
    maxDepth: MAX_FIELD_DEPTH,
  }) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(redacted)) {
    const value = redacted[key];
    out[key] = typeof value === 'string' ? sanitizeLogValue(value) : value;
  }
  return out;
}

export function createStructuredLogger(options: LoggerOptions = {}): StructuredLogger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? defaultSink;
  const bindings = options.bindings ?? {};
  const threshold = SEVERITY[level];

  const emit = (at: LogLevel, args: unknown[]): void => {
    if (SEVERITY[at] < threshold) return;

    const { fields, message } = splitArgs(args);
    const entry: Record<string, unknown> = {
      level: at,
      time: new Date().toISOString(),
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...bindings,
      ...safeFields(fields),
      msg: sanitizeLogValue(message),
    };

    const ids = getActiveTraceIds();
    if (ids !== undefined) {
      entry['trace'] = `trace=${ids.traceId} span=${ids.spanId}`;
      entry['traceId'] = ids.traceId;
      entry['spanId'] = ids.spanId;
    }

    sink(JSON.stringify(entry));
  };

  return {
    level,
    trace: (...args) => emit('trace', args),
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    fatal: (...args) => emit('fatal', args),
    // pino parity: a no-op sink for code that logs at the 'silent' level.
    silent: () => {},
    child: (childBindings) =>
      createStructuredLogger({
        ...options,
        level,
        sink,
        bindings: { ...bindings, ...safeFields(childBindings) },
      }),
  };
}
