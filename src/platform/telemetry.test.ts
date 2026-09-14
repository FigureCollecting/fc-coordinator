import { trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStructuredLogger } from './logger.js';
import { getActiveTraceIds } from './shared.js';
import {
  NoopSpanExporter,
  RedactingSpanExporter,
  redactSpan,
  resolveExporterChoice,
  scrubDisabledExporterEnv,
  startTelemetry,
  buildExporter,
  type Telemetry,
} from './telemetry.js';

class CaptureExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

let started: Telemetry | undefined;
afterEach(async () => {
  await started?.shutdown();
  started = undefined;
});

// A compact JWS — the shape of BOTH the entitlement assertion and the DPoP
// proof (§A.5, "keeping secrets out of spans").
const JWS = 'eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJzdWIiOiJyb3NzIn0.c2ln';

describe('telemetry — §A.5 rule 1: an async context manager is registered', () => {
  it('gives a span a non-zero trace id that survives an await', async () => {
    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: capture, env: {} });

    let inside: string | undefined;
    let afterAwait: string | undefined;
    await trace.getTracer('test').startActiveSpan('unit', async (span) => {
      inside = getActiveTraceIds()?.traceId;
      await new Promise((resolve) => setImmediate(resolve));
      afterAwait = getActiveTraceIds()?.traceId;
      span.end();
    });

    expect(inside).toMatch(/^[0-9a-f]{32}$/);
    expect(inside).not.toMatch(/^0+$/);
    // The whole point of AsyncLocalStorageContextManager: the SAME span is
    // still active on the far side of the await.
    expect(afterAwait).toBe(inside);
  });

  it('registers the AsyncLocalStorage context manager explicitly, not by default', () => {
    // Surviving an await is already asserted above, but NodeTracerProvider's own
    // default would satisfy that too. This pins the §A.5 rule-1 INTENT: the
    // manager is chosen here, so a future change to that default cannot quietly
    // swap in a synchronous one.
    started = startTelemetry({ exporter: new CaptureExporter(), env: {} });
    expect(started.contextManager).toBeInstanceOf(AsyncLocalStorageContextManager);
  });

  it('puts the canonical trace tag on a log line emitted inside the span', async () => {
    const lines: string[] = [];
    started = startTelemetry({ exporter: new CaptureExporter(), env: {} });
    const log = createStructuredLogger({ name: 'unit', level: 'info', sink: (l) => lines.push(l) });

    await trace.getTracer('test').startActiveSpan('logged', async (span) => {
      await new Promise((resolve) => setImmediate(resolve));
      log.info('hello');
      span.end();
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/trace=[0-9a-f]{32} span=[0-9a-f]{16}/);
  });
});

describe('telemetry — §A.5 rule 2: never a no-op provider', () => {
  it('chooses a real SimpleSpanProcessor + NoopSpanExporter when no collector is configured', () => {
    expect(resolveExporterChoice({})).toEqual({ kind: 'noop' });
  });

  it('chooses OTLP when an endpoint is configured, traces-specific winning over generic', () => {
    expect(resolveExporterChoice({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' })).toEqual({
      kind: 'otlp',
      endpoint: 'http://c:4318',
    });
    expect(
      resolveExporterChoice({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://generic:4318',
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces:4318/v1/traces',
      }),
    ).toEqual({ kind: 'otlp', endpoint: 'http://traces:4318/v1/traces' });
  });

  it('scrubs OTEL_TRACES_EXPORTER=none out of the environment', () => {
    const env: Record<string, string> = { OTEL_TRACES_EXPORTER: 'none' };
    expect(scrubDisabledExporterEnv(env)).toBe(true);
    expect('OTEL_TRACES_EXPORTER' in env).toBe(false);
    expect(scrubDisabledExporterEnv({ OTEL_TRACES_EXPORTER: 'otlp' })).toBe(false);
    expect(scrubDisabledExporterEnv({})).toBe(false);
  });

  it('still produces a non-zero trace id even when the environment asked for exporter=none', async () => {
    const env: Record<string, string> = { OTEL_TRACES_EXPORTER: 'none' };
    started = startTelemetry({ exporter: new CaptureExporter(), env });

    let traceId: string | undefined;
    let recording: boolean | undefined;
    trace.getTracer('test').startActiveSpan('unit', (span) => {
      traceId = getActiveTraceIds()?.traceId;
      recording = span.isRecording();
      span.end();
    });

    // The bug this guards: an all-zero id makes fc-shared's trace.ts report
    // "no span", and every log line silently loses its trace tag.
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toMatch(/^0+$/);
    // A no-op provider hands out NonRecordingSpan. Asserting the span RECORDS
    // proves a real SDK is registered, which is the property rule 2 protects —
    // the env scrub alone proves nothing here (see the module header).
    expect(recording).toBe(true);
    expect(started.state.exporter).toBe('noop');
  });

  it('reports its state for /healthz without leaking anything', () => {
    started = startTelemetry({ exporter: new CaptureExporter(), env: {}, serviceName: 'fc-coordinator' });
    expect(started.state).toEqual({
      registered: true,
      exporter: 'noop',
      serviceName: 'fc-coordinator',
    });
  });
});

describe('telemetry — span attributes are redacted before export', () => {
  it('redacts a compact-JWS attribute on a REAL span before the exporter sees it', async () => {
    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: new RedactingSpanExporter(capture), env: {} });

    trace.getTracer('test').startActiveSpan('dpop.verify', (span) => {
      span.setAttribute('app.dpop.proof', JWS);
      span.setAttribute('app.dpop.attempts', 2);
      span.end();
    });
    await started.forceFlush();

    expect(capture.spans).toHaveLength(1);
    expect(capture.spans[0]?.attributes['app.dpop.proof']).toBe('[REDACTED]');
    expect(capture.spans[0]?.attributes['app.dpop.attempts']).toBe(2);
    expect(capture.spans[0]?.name).toBe('dpop.verify');
  });

  it('wraps the PRODUCTION exporter, with nothing injected', async () => {
    // The other redaction tests construct RedactingSpanExporter themselves and
    // inject it, so they pass even if startTelemetry stops wrapping. This one
    // injects NOTHING and asserts what the real exporter is handed. Dropping the
    // wrapper makes it fail printing the raw JWS — the leak the rule prevents.
    const shipped = vi.spyOn(NoopSpanExporter.prototype, 'export');
    try {
      started = startTelemetry({ env: {} });
      trace.getTracer('test').startActiveSpan('dpop.verify', (span) => {
        span.setAttribute('app.dpop.proof', JWS);
        span.setAttribute('app.dpop.attempts', 1);
        span.end();
      });
      await started.forceFlush();

      const spans = shipped.mock.calls[0]?.[0];
      expect(spans).toHaveLength(1);
      expect(spans?.[0]?.attributes['app.dpop.proof']).toBe('[REDACTED]');
      expect(spans?.[0]?.attributes['app.dpop.attempts']).toBe(1);
    } finally {
      shipped.mockRestore();
    }
  });

  it('redacts by key name as well as by value shape', () => {
    const span = {
      name: 'x',
      attributes: { authorization: 'opaque-but-sensitive', 'app.ok': true },
    } as unknown as ReadableSpan;
    const out = redactSpan(span);
    expect(out.attributes['authorization']).toBe('[REDACTED]');
    expect(out.attributes['app.ok']).toBe(true);
    expect(out.name).toBe('x');
  });

  it('delegates shutdown and forceFlush, and the noop exporter always succeeds', async () => {
    const capture = new CaptureExporter();
    const wrapper = new RedactingSpanExporter(capture);
    await expect(wrapper.shutdown()).resolves.toBeUndefined();
    await expect(wrapper.forceFlush()).resolves.toBeUndefined();

    const noop = new NoopSpanExporter();
    const results: ExportResult[] = [];
    noop.export([], (r) => results.push(r));
    expect(results).toEqual([{ code: ExportResultCode.SUCCESS }]);
    await expect(noop.shutdown()).resolves.toBeUndefined();
  });
});

describe('telemetry — lifecycle', () => {
  it('shutdown releases the global provider so a later start is clean', async () => {
    const first = startTelemetry({ exporter: new CaptureExporter(), env: {} });
    await first.shutdown();

    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: capture, env: {} });
    trace.getTracer('test').startActiveSpan('second', (span) => span.end());
    await started.forceFlush();
    expect(capture.spans).toHaveLength(1);
  });
});

describe('telemetry — the production wiring, with nothing injected', () => {
  it('builds a NoopSpanExporter with no collector and an OTLP exporter with one', () => {
    expect(buildExporter({ kind: 'noop' })).toBeInstanceOf(NoopSpanExporter);
    const otlp = buildExporter({ kind: 'otlp', endpoint: 'http://collector:4318/v1/traces' });
    expect(otlp).not.toBeInstanceOf(NoopSpanExporter);
    expect(typeof otlp.export).toBe('function');
  });

  it('starts with no injected exporter and still yields a non-zero trace id', async () => {
    const telemetry = startTelemetry({ env: {} });
    try {
      expect(telemetry.state).toEqual({
        registered: true,
        exporter: 'noop',
        serviceName: 'fc-coordinator',
      });
      let traceId: string | undefined;
      trace.getTracer('test').startActiveSpan('unwired', (span) => {
        traceId = getActiveTraceIds()?.traceId;
        span.end();
      });
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      await telemetry.forceFlush();
    } finally {
      await telemetry.shutdown();
    }
  });
});

describe('telemetry — the OTLP path', () => {
  it('batches spans when a collector endpoint is configured', async () => {
    const capture = new CaptureExporter();
    started = startTelemetry({
      exporter: capture,
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces' },
    });
    expect(started.state.exporter).toBe('otlp');

    trace.getTracer('test').startActiveSpan('batched', (span) => span.end());
    await started.forceFlush();
    expect(capture.spans).toHaveLength(1);
  });

  it('reads the ambient process environment when none is injected', async () => {
    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: capture });
    expect(started.state.exporter).toBe(resolveExporterChoice(process.env).kind);
    expect(started.state.serviceName).toBe('fc-coordinator');
  });
});
