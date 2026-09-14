import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan as SdkReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerHttpTracing } from './http-trace.js';
import { createStructuredLogger } from './logger.js';
import { startTelemetry, type Telemetry } from './telemetry.js';
import { getActiveTraceIds } from './shared.js';

class CaptureExporter implements SpanExporter {
  readonly spans: SdkReadableSpan[] = [];
  export(spans: SdkReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

let app: FastifyInstance | undefined;
let telemetry: Telemetry | undefined;
let capture: CaptureExporter;

beforeEach(() => {
  capture = new CaptureExporter();
  telemetry = startTelemetry({ exporter: capture, env: {} });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await telemetry?.shutdown();
  telemetry = undefined;
});

describe('registerHttpTracing — the slice-1a N3 gap', () => {
  it('runs the handler inside an ACTIVE span, so a log line can carry the trace tag', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async () => ({ ids: getActiveTraceIds() ?? null }));

    const body = (await app.inject({ method: 'GET', url: '/x' })).json() as {
      ids: { traceId: string; spanId: string } | null;
    };
    expect(body.ids).not.toBeNull();
    expect(body.ids?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.ids?.traceId).not.toBe('0'.repeat(32));
  });

  it('CONTINUES an incoming W3C traceparent rather than starting a new trace', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async () => ({ ids: getActiveTraceIds() ?? null }));

    const res = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });
    expect((res.json() as { ids: { traceId: string } }).ids.traceId).toBe(traceId);
  });

  it('a LOG LINE from the handler carries trace= and span= with the propagated id', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const lines: string[] = [];
    app = Fastify({ loggerInstance: createStructuredLogger({ sink: (l) => lines.push(l), level: 'info' }) });
    registerHttpTracing(app);
    app.get('/x', async (request) => {
      request.log.info('handling');
      return { ok: true };
    });

    await app.inject({
      method: 'GET',
      url: '/x',
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
    });

    const handled = lines.map((l) => JSON.parse(l) as Record<string, string>).find((l) => l['msg'] === 'handling');
    expect(handled).toBeDefined();
    expect(handled?.['trace']).toMatch(new RegExp(`^trace=${traceId} span=[0-9a-f]{16}$`));
  });

  it('keeps the span active ACROSS an await, which is what rule 1 buys', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { ids: getActiveTraceIds() ?? null };
    });

    expect((await app.inject({ method: 'GET', url: '/x' })).json()).toHaveProperty('ids.traceId');
  });

  it('names the span by ROUTE TEMPLATE, never the raw path, so cardinality stays bounded', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/devices/:id', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/devices/0d1b1a3e-9f2c-4f63-8a11-2f9a5d6c7e80' });
    await telemetry?.forceFlush();

    expect(capture.spans[0]?.name).toBe('GET /devices/:id');
    expect(capture.spans[0]?.attributes['http.route']).toBe('/devices/:id');
  });

  it('records the status code and ends the span', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async (_request, reply) => reply.code(201).send({ ok: true }));

    await app.inject({ method: 'GET', url: '/x' });
    await telemetry?.forceFlush();

    expect(capture.spans).toHaveLength(1);
    expect(capture.spans[0]?.attributes['http.response.status_code']).toBe(201);
    expect(capture.spans[0]?.ended).toBe(true);
  });

  it('marks a 5xx as an ERROR span and a 4xx as unset — a rejected auth attempt is not our fault', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/boom', async () => {
      throw new Error('kaboom');
    });
    app.get('/nope', async (_request, reply) => reply.code(401).send({ error: 'invalid_token' }));

    await app.inject({ method: 'GET', url: '/boom' });
    await app.inject({ method: 'GET', url: '/nope' });
    await telemetry?.forceFlush();

    const boom = capture.spans.find((s) => s.name.includes('/boom'));
    const nope = capture.spans.find((s) => s.name.includes('/nope'));
    expect(boom?.status.code).toBe(SpanStatusCode.ERROR);
    expect(nope?.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('records the exception WITHOUT putting the message in an attribute we then export blind', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/boom', async () => {
      throw new Error('connect ECONNREFUSED pg://fc:hunter2@pg:5432');
    });

    await app.inject({ method: 'GET', url: '/boom' });
    await telemetry?.forceFlush();

    const span = capture.spans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(span.attributes)).not.toContain('hunter2');
  });

  it('puts the PATH on the span but never the query string', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/x?token=secret-value' });
    await telemetry?.forceFlush();

    expect(capture.spans[0]?.attributes['url.path']).toBe('/x');
    expect(JSON.stringify(capture.spans[0]?.attributes)).not.toContain('secret-value');
  });

  it('still ends a span for a route that does not exist', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/missing' });
    await telemetry?.forceFlush();

    expect(capture.spans).toHaveLength(1);
    expect(capture.spans[0]?.attributes['http.response.status_code']).toBe(404);
  });

  it('starts a SERVER-kind span', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/x' });
    await telemetry?.forceFlush();
    expect(capture.spans[0]?.kind).toBe(1);
  });

  it('can be told to skip a path, so a liveness probe does not flood the collector', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app, { ignorePaths: ['/healthz'] });
    app.get('/healthz', async () => ({ ok: true }));
    app.get('/x', async () => ({ ok: true }));

    await app.inject({ method: 'GET', url: '/healthz' });
    await app.inject({ method: 'GET', url: '/x' });
    await telemetry?.forceFlush();

    expect(capture.spans.map((s) => s.name)).toEqual(['GET /x']);
  });
});
