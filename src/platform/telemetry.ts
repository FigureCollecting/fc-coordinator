// ============================================================================
// OpenTelemetry bootstrap: fc-shared's startTracing (LG-C1), which carries the
// three propagation rules of plan §A.5 for every service on the estate.
//
// RULE 1  An ASYNC CONTEXT MANAGER. fc-shared registers an
//         AsyncLocalStorageContextManager explicitly, so the active span
//         survives an `await` and every later log line keeps its trace_id.
//
// RULE 2  NEVER a no-op PROVIDER. fc-shared builds a TracerProvider (never
//         NodeSDK, so OTEL_TRACES_EXPORTER is not read): with no endpoint only
//         the span PROCESSOR is a no-op. Spans record with real ids and
//         nothing leaves the pod.
//
// RULE 3  W3C `traceparent` on every Connect hop. fc-shared's propagator is the
//         W3C pair behind a HOST ALLOWLIST (OTEL_PROPAGATION_ALLOWLIST, default
//         `*.svc.cluster.local,*.svc,localhost`): an injection happens only for
//         a target on the list, so the client interceptor names its target
//         (connect/interceptors.ts). A CLIENT's tracestate and baggage are
//         still dropped at the client-facing edges (client-trace.ts).
//
// EXPORT. OTLP over gRPC when OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or
// OTEL_EXPORTER_OTLP_ENDPOINT is set (the traces-specific one wins), batched,
// bounded, and never throwing into the app. The HTTP/protobuf exporter this
// service carried before is gone; an endpoint that names an HTTP collector
// (:4318) is not understood. No endpoint is set today (fc-infra LG-X1c sets it).
// shutdown() waits SHUTDOWN_TIMEOUT_MS for the last flush, then returns.
//
// SAMPLING (LGMOB C1). A client's sampled flag does not decide whether this
// service records its spans. fc-shared's provider uses the SDK default sampler
// (parent-based, always on), so that is decided where the client's traceparent
// is read: client-trace.ts marks the extracted parent sampled.
//
// SECRETS: the rule is never to SET a secret attribute; fc-shared's redacting
// exporter is the second line of defence, over every span's attributes, events
// and links just before export. It runs with COORDINATOR_REDACT_OPTIONS
// (platform/shared.ts), because the DPoP nonce is opaque base64url that no
// value pattern can tell from an id: only its KEY catches it.
// ============================================================================
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { DEFAULT_SERVICE_NAME } from './logger.js';
import { COORDINATOR_REDACT_OPTIONS, startTracing, type ExporterKind } from './shared.js';

export { DEFAULT_SERVICE_NAME };
export type { ExporterKind };

/**
 * How long shutdown() waits for the last flush. An export has 10 s (fc-shared's
 * default), and so had the shutdown behind a collector that never answers.
 * server.ts stops the process hard, with exit 1, 10 s after SIGTERM, and
 * telemetry shuts down last in that drain: a dead collector alone turned every
 * clean stop into a failed one. The spans still queued then are lost.
 */
export const SHUTDOWN_TIMEOUT_MS = 3_000;

/** Settles when `work` does, or once `ms` have passed: `work` then goes on unawaited. Never rejects. */
function within(work: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    work.then(done, done);
  });
}

/** What /healthz and the boot line read about tracing. Carries no endpoint and no credential. */
export interface TelemetryState {
  registered: boolean;
  /** 'otlp' (gRPC) with an endpoint, 'noop' without, 'custom' under the test seam. */
  exporter: ExporterKind;
  serviceName: string;
  /** The image's revision (SERVICE_VERSION, stamped by the image build); 'unknown' outside one. */
  version: string;
}

export interface Telemetry {
  readonly state: TelemetryState;
  forceFlush(): Promise<void>;
  /** Flush and stop. Returns after SHUTDOWN_TIMEOUT_MS at the latest, with the flush still going. */
  shutdown(): Promise<void>;
}

export interface StartTelemetryOptions {
  env?: Record<string, string | undefined>;
  serviceName?: string;
  /** Test seam: export here instead of OTLP, still redacted and batched. */
  exporter?: SpanExporter;
  /** Hosts added to the propagation allowlist; a test's loopback fake is not on the default list. */
  propagateHosts?: readonly string[];
  /** How long shutdown() waits. Default SHUTDOWN_TIMEOUT_MS. */
  shutdownTimeoutMs?: number;
}

/**
 * Register tracing for this process. One per process: a second call while the
 * first is running returns the running registration unchanged.
 */
export function startTelemetry(options: StartTelemetryOptions = {}): Telemetry {
  const tracing = startTracing(options.serviceName ?? DEFAULT_SERVICE_NAME, {
    env: options.env ?? process.env,
    redact: COORDINATOR_REDACT_OPTIONS,
    ...(options.exporter !== undefined ? { exporter: options.exporter } : {}),
    ...(options.propagateHosts !== undefined ? { propagateHosts: options.propagateHosts } : {}),
  });

  return {
    state: {
      registered: true,
      exporter: tracing.state.exporter,
      serviceName: tracing.state.service,
      version: tracing.state.version,
    },
    forceFlush: () => tracing.forceFlush(),
    shutdown: () => within(tracing.shutdown(), options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS),
  };
}
