// ============================================================================
// OpenTelemetry bootstrap — plan §A.5, all three propagation rules.
//
// RULE 1  Register an SDK with an ASYNC CONTEXT MANAGER. fc-shared's trace.ts
//         reads the *active* span; without AsyncLocalStorageContextManager the
//         active span is lost at the first `await` and every log line after it
//         loses its trace tag. NodeTracerProvider.register() defaults to that
//         manager today, but it is passed EXPLICITLY here so the requirement
//         survives an upgrade that changes the default.
//
// RULE 2  NEVER `OTEL_TRACES_EXPORTER=none`. It makes NodeSDK register a no-op
//         provider whose trace id is all zeroes, and fc-shared treats an
//         all-zero id as "no span" — so logs silently lose their trace tag
//         rather than failing loudly. This bug already shipped once in
//         fc-backend. Two separate defences, and it is worth being precise
//         about which one is load-bearing HERE:
//           (a) STRUCTURAL, and the one that actually holds today: this module
//               builds a NodeTracerProvider with a real SimpleSpanProcessor
//               wrapping a NoopSpanExporter, and NEVER uses NodeSDK.
//               NodeTracerProvider does not read OTEL_TRACES_EXPORTER at all,
//               so the variable cannot produce a no-op provider on this path.
//               The test asserts spans RECORD, which is that property directly.
//           (b) DEFENCE IN DEPTH: scrubDisabledExporterEnv() deletes the
//               variable anyway, so the day someone swaps in NodeSDK — which
//               DOES read it — the bug cannot come back with it. Removing the
//               scrub would not fail the behavioural tests today; that is
//               expected, not a gap in them.
//
// RULE 3  W3C `traceparent` on every Connect hop, via interceptors. The W3C
//         propagator is registered here (NodeTracerProvider.register installs
//         the composite W3CTraceContext + Baggage propagator by default); the
//         interceptors themselves arrive with the first Connect hop in slice 1b.
//
// SECRETS: the rule is never to SET a secret attribute; RedactingSpanExporter
// is the second line of defence, running fc-shared's redactAttributes over
// every span's attributes just before export. The existing value patterns
// already cover our two new secret shapes — the entitlement assertion and the
// DPoP proof are both compact JWS (/eyJ[A-Za-z0-9._-]{10,}/).
// ============================================================================
import { context, propagation, trace, type ContextManager } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { redactAttributes, type AttributeValue } from './shared.js';

export const DEFAULT_SERVICE_NAME = 'fc-coordinator';

export type ExporterKind = 'otlp' | 'noop';

export interface ExporterChoice {
  kind: ExporterKind;
  endpoint?: string;
}

/** What /healthz reports about tracing. Carries no endpoint and no credential. */
export interface TelemetryState {
  registered: boolean;
  exporter: ExporterKind;
  serviceName: string;
}

export interface Telemetry {
  readonly state: TelemetryState;
  /**
   * The context manager actually registered. Exposed so §A.5 rule 1 is
   * ASSERTABLE: NodeTracerProvider.register() would default to the same class,
   * so "it survives an await" alone cannot tell an explicit choice from a lucky
   * default, and a future change to that default would go unnoticed.
   */
  readonly contextManager: ContextManager;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface StartTelemetryOptions {
  env?: Record<string, string | undefined>;
  serviceName?: string;
  /** Test seam. Production builds the exporter from the environment. */
  exporter?: SpanExporter;
}

/**
 * Remove `OTEL_TRACES_EXPORTER=none` from an environment. Returns true when it
 * was present, so the caller can warn: someone meant to disable export and
 * would instead have disabled TRACE IDS.
 */
export function scrubDisabledExporterEnv(env: Record<string, string | undefined>): boolean {
  if (env['OTEL_TRACES_EXPORTER']?.trim().toLowerCase() !== 'none') return false;
  delete env['OTEL_TRACES_EXPORTER'];
  return true;
}

/** Traces-specific endpoint wins over the generic one, per the OTel spec. */
export function resolveExporterChoice(env: Record<string, string | undefined>): ExporterChoice {
  const endpoint = (
    env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ??
    env['OTEL_EXPORTER_OTLP_ENDPOINT'] ??
    ''
  ).trim();
  return endpoint === '' ? { kind: 'noop' } : { kind: 'otlp', endpoint };
}

/** Swallows spans and always succeeds. Real exporter, no-op destination. */
export class NoopSpanExporter implements SpanExporter {
  export(_spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    resultCallback({ code: ExportResultCode.SUCCESS });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * A view of a span with its attributes redacted. Object.create keeps the real
 * span as the prototype, so the SDK's getter-backed fields (duration, ended,
 * events, status, resource) survive — a spread would silently drop them.
 */
export function redactSpan(span: ReadableSpan): ReadableSpan {
  const redacted = redactAttributes(span.attributes as unknown as Record<string, AttributeValue>);
  return Object.create(span as object, {
    attributes: { value: redacted, enumerable: true, configurable: true },
  }) as ReadableSpan;
}

/** Runs fc-shared's redaction policy over span attributes just before export. */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    this.delegate.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}

export function buildExporter(choice: ExporterChoice): SpanExporter {
  if (choice.kind === 'otlp') return new OTLPTraceExporter({ url: choice.endpoint });
  return new NoopSpanExporter();
}

export function startTelemetry(options: StartTelemetryOptions = {}): Telemetry {
  const env = options.env ?? process.env;
  const serviceName = options.serviceName ?? DEFAULT_SERVICE_NAME;

  scrubDisabledExporterEnv(env);
  const choice = resolveExporterChoice(env);

  const exporter = options.exporter ?? new RedactingSpanExporter(buildExporter(choice));
  // A REAL processor in both cases (rule 2). Batching only helps when spans
  // actually travel; the no-collector path stays simple and synchronous.
  const processor: SpanProcessor =
    choice.kind === 'otlp' ? new BatchSpanProcessor(exporter) : new SimpleSpanProcessor(exporter);

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: [processor],
  });

  // Rule 1, explicit.
  const contextManager = new AsyncLocalStorageContextManager();
  provider.register({ contextManager });

  return {
    state: { registered: true, exporter: choice.kind, serviceName },
    contextManager,
    forceFlush: () => provider.forceFlush(),
    shutdown: async () => {
      await provider.shutdown();
      contextManager.disable();
      trace.disable();
      context.disable();
      propagation.disable();
    },
  };
}
