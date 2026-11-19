// startTelemetry over fc-shared's startTracing: the context manager, the state it reports, the
// redaction it passes on and its lifecycle. What leaves the process (gRPC with an endpoint,
// nothing without) is in otlp-export.test.ts; the log line's ids are in trace-shape.test.ts.
import { ROOT_CONTEXT, TraceFlags, context, propagation, trace } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getActiveTraceIds, withPropagationTarget } from './shared.js';
import { DEFAULT_SERVICE_NAME, SHUTDOWN_TIMEOUT_MS, startTelemetry, type Telemetry } from './telemetry.js';

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

// A compact JWS, the shape of BOTH the entitlement assertion and the DPoP
// proof (§A.5, "keeping secrets out of spans").
const JWS = 'eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJzdWIiOiJyb3NzIn0.c2ln';
const NONCE = 'q8Zr3kVn1xMpLb7TfGhQaWcEdRyUiOpAsDfGhJkLzXcVbNm0';

describe('telemetry: §A.5 rule 1, an async context manager is registered', () => {
  it('gives a span a non-zero trace id that survives an await', async () => {
    started = startTelemetry({ exporter: new CaptureExporter(), env: {} });

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
    // The whole point of an AsyncLocalStorage context manager: the SAME span is
    // still active on the far side of the await.
    expect(afterAwait).toBe(inside);
  });

  it('loses the active span again once it is shut down: the manager was this registration', async () => {
    const telemetry = startTelemetry({ exporter: new CaptureExporter(), env: {} });
    await telemetry.shutdown();

    let inside: unknown = 'unset';
    trace.getTracer('test').startActiveSpan('unit', (span) => {
      inside = getActiveTraceIds();
      span.end();
    });
    expect(inside).toBeUndefined();
  });
});

describe('telemetry: sampling follows the parent; the client edge decides what a client may say', () => {
  const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
  const parent = (traceFlags: TraceFlags, isRemote: boolean) =>
    trace.setSpanContext(ROOT_CONTEXT, { traceId: TRACE_ID, spanId: '00f067aa0ba902b7', traceFlags, isRemote });

  it('records a root span, and a span under a sampled parent', () => {
    started = startTelemetry({ exporter: new CaptureExporter(), env: {} });
    const root = trace.getTracer('test').startSpan('root');
    const child = trace.getTracer('test').startSpan('child', {}, parent(TraceFlags.SAMPLED, true));

    expect(root.isRecording()).toBe(true);
    expect(child.isRecording()).toBe(true);
    expect(child.spanContext().traceId).toBe(TRACE_ID);
    root.end();
    child.end();
  });

  it('follows a not-sampled parent, which is why client-trace.ts marks a client parent sampled', () => {
    // fc-shared's provider has the SDK default sampler. The LGMOB C1 rule (a client's flag does
    // not switch this service's spans off) therefore lives at the edge: client-trace.test.ts.
    started = startTelemetry({ exporter: new CaptureExporter(), env: {} });
    const span = trace.getTracer('test').startSpan('x', {}, parent(TraceFlags.NONE, true));

    expect(span.isRecording()).toBe(false);
    // The ids are still real, so a log line under it would keep its trace_id.
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    span.end();
  });

  it.each([
    ['OTEL_TRACES_SAMPLER', 'always_off'],
    ['OTEL_TRACES_EXPORTER', 'none'],
    ['OTEL_SDK_DISABLED', 'true'],
  ])('does not let %s=%s in the process environment turn recording off', (name, value) => {
    // Pinned so it is a decision and not an accident: fc-infra sets none of these for the
    // coordinator, and a stray one must not silently cost every line its trace_id.
    const saved = process.env[name];
    process.env[name] = value;
    try {
      started = startTelemetry({ exporter: new CaptureExporter() });
      const span = trace.getTracer('test').startSpan('root');
      expect(span.isRecording()).toBe(true);
      expect(span.spanContext().traceId).not.toBe('0'.repeat(32));
      span.end();
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });
});

describe('telemetry: the state /healthz and the boot line read', () => {
  it('names the exporter kind, the service and the version, and nothing else', () => {
    started = startTelemetry({ env: { SERVICE_VERSION: 'abc1234' } });
    expect(started.state).toEqual({
      registered: true,
      exporter: 'noop',
      serviceName: 'fc-coordinator',
      version: 'abc1234',
    });
    expect(DEFAULT_SERVICE_NAME).toBe('fc-coordinator');
  });

  it('takes the service name it is given over OTEL_SERVICE_NAME', () => {
    started = startTelemetry({ env: { OTEL_SERVICE_NAME: 'from-env' }, serviceName: 'fc-coordinator-test' });
    expect(started.state.serviceName).toBe('fc-coordinator-test');
  });

  it('says custom under the test seam, whatever endpoint the environment names', () => {
    started = startTelemetry({
      exporter: new CaptureExporter(),
      env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector.invalid:4317' },
    });
    expect(started.state.exporter).toBe('custom');
    expect(JSON.stringify(started.state)).not.toContain('collector.invalid');
  });

  it('reads the ambient process environment when none is injected', () => {
    const saved = process.env['SERVICE_VERSION'];
    process.env['SERVICE_VERSION'] = 'ambient-revision';
    try {
      started = startTelemetry({ exporter: new CaptureExporter() });
      expect(started.state.version).toBe('ambient-revision');
      expect(started.state.serviceName).toBe('fc-coordinator');
    } finally {
      if (saved === undefined) delete process.env['SERVICE_VERSION'];
      else process.env['SERVICE_VERSION'] = saved;
    }
  });

  it('stamps the service name and the version on the span resource', async () => {
    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: capture, env: { SERVICE_VERSION: 'abc1234' } });

    trace.getTracer('test').startActiveSpan('unit', (span) => span.end());
    await started.forceFlush();

    expect(capture.spans[0]?.resource.attributes).toMatchObject({
      'service.name': 'fc-coordinator',
      'service.version': 'abc1234',
    });
  });
});

describe('telemetry: span attributes are redacted before export', () => {
  it('redacts a compact-JWS attribute on a REAL span before the exporter sees it', async () => {
    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: capture, env: {} });

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

  it('redacts an OPAQUE dpop nonce attribute, which only the coordinator key pattern catches', async () => {
    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: capture, env: {} });

    trace.getTracer('test').startActiveSpan('dpop.verify', (span) => {
      span.setAttribute('app.dpop_nonce', NONCE);
      span.end();
    });
    await started.forceFlush();

    expect(capture.spans[0]?.attributes['app.dpop_nonce']).toBe('[REDACTED]');
  });

  it('redacts a span event and strips a URL attribute, which the local exporter did not', async () => {
    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: capture, env: {} });

    trace.getTracer('test').startActiveSpan('outbound', (span) => {
      span.addEvent('retry', { dpop_nonce: NONCE, attempt: 2 });
      span.setAttribute('url.full', 'https://fc:hunter2@pg.data.svc/db?sig=opaque-signature#frag');
      span.end();
    });
    await started.forceFlush();

    const span = capture.spans[0]!;
    expect(span.events[0]?.attributes).toEqual({ dpop_nonce: '[REDACTED]', attempt: 2 });
    expect(span.attributes['url.full']).toBe('https://pg.data.svc/db');
  });

  it('keeps the getter-backed fields of the span it hands on', async () => {
    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: capture, env: {} });

    trace.getTracer('test').startActiveSpan('unit', (span) => span.end());
    await started.forceFlush();

    const span = capture.spans[0]!;
    expect(span.ended).toBe(true);
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(Array.isArray(span.duration)).toBe(true);
  });
});

describe('telemetry: propagation goes to listed hosts only', () => {
  const inject = (target: string | undefined): Record<string, string> => {
    const carrier: Record<string, string> = {};
    trace.getTracer('test').startActiveSpan('hop', (span) => {
      const ctx = target === undefined ? context.active() : withPropagationTarget(context.active(), target);
      propagation.inject(ctx, carrier);
      span.end();
    });
    return carrier;
  };

  it('injects a traceparent for an in-cluster target, by default', () => {
    started = startTelemetry({ env: {} });
    expect(inject('http://ingest-server.fc.svc.cluster.local:50062').traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it.each([
    ['a public host', 'https://auth.mindsignals1.com/application/o/token/'],
    ['a loopback address', 'http://127.0.0.1:50062'],
    ['no named target at all', undefined],
  ])('injects nothing for %s', (_label, target) => {
    started = startTelemetry({ env: {} });
    expect(inject(target)).toEqual({});
  });

  it('adds the hosts it is given to the list', () => {
    started = startTelemetry({ env: {}, propagateHosts: ['127.0.0.1'] });
    expect(inject('http://127.0.0.1:50062').traceparent).toBeDefined();
  });

  it('takes the list from OTEL_PROPAGATION_ALLOWLIST when it is set', () => {
    started = startTelemetry({ env: { OTEL_PROPAGATION_ALLOWLIST: 'spine.internal' } });
    expect(inject('http://spine.internal:50062').traceparent).toBeDefined();
    expect(inject('http://ingest-server.fc.svc.cluster.local:50062')).toEqual({});
  });
});

describe('telemetry: lifecycle', () => {
  it('shutdown releases the global provider so a later start is clean', async () => {
    const first = startTelemetry({ exporter: new CaptureExporter(), env: {} });
    await first.shutdown();

    const capture = new CaptureExporter();
    started = startTelemetry({ exporter: capture, env: {} });
    trace.getTracer('test').startActiveSpan('second', (span) => span.end());
    await started.forceFlush();
    expect(capture.spans).toHaveLength(1);
  });

  it('is one registration per process: a second start reports the running one', () => {
    started = startTelemetry({ env: {}, serviceName: 'first' });
    const second = startTelemetry({ env: { SERVICE_VERSION: 'other' }, serviceName: 'second' });

    expect(second.state).toEqual(started.state);
    expect(second.state.serviceName).toBe('first');
  });

  it('never rejects from forceFlush or shutdown when the exporter fails', async () => {
    const failing: SpanExporter = {
      export: (_spans, done) => done({ code: ExportResultCode.FAILED, error: new Error('collector down') }),
      shutdown: () => Promise.reject(new Error('collector down')),
    };
    const telemetry = startTelemetry({ exporter: failing, env: {} });
    trace.getTracer('test').startActiveSpan('unit', (span) => span.end());

    await expect(telemetry.forceFlush()).resolves.toBeUndefined();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown stops waiting after its budget, and the flush it left goes on to finish', async () => {
    const exported: string[] = [];
    let release: (() => void) | undefined;
    const stuck: SpanExporter = {
      export: (spans, done) => {
        release = () => {
          exported.push(...spans.map((span) => span.name));
          done({ code: ExportResultCode.SUCCESS });
        };
      },
      shutdown: () => Promise.resolve(),
    };
    const telemetry = startTelemetry({ exporter: stuck, env: {}, serviceName: 'stuck', shutdownTimeoutMs: 50 });
    trace.getTracer('test').startActiveSpan('queued', (span) => span.end());

    const startedAt = performance.now();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    const waited = performance.now() - startedAt;
    expect(waited).toBeGreaterThanOrEqual(45);
    // The budget it was given, not the default one.
    expect(waited).toBeLessThan(SHUTDOWN_TIMEOUT_MS - 1_000);

    // Not finished: the export is still in flight and the registration is still the running one.
    expect(exported).toEqual([]);
    expect(startTelemetry({ env: {}, serviceName: 'next' }).state.serviceName).toBe('stuck');

    release?.();
    await vi.waitFor(() => {
      started = startTelemetry({ env: {}, serviceName: 'next' });
      expect(started.state.serviceName).toBe('next');
    });
    expect(exported).toEqual(['queued']);
  });

  it('shutdown returns as soon as the flush is done, and leaves no timer behind', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const telemetry = startTelemetry({ env: {}, shutdownTimeoutMs: 60_000 });
      await expect(telemetry.shutdown()).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
