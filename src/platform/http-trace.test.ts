import { SpanStatusCode, context, propagation, trace } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan as SdkReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRACE_RESPONSE_HEADER, registerHttpTracing, traceResponseOf } from './http-trace.js';
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

  it('a LOG LINE from the handler carries trace_id and span_id with the propagated id', async () => {
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
    expect(handled?.['trace_id']).toBe(traceId);
    expect(handled?.['span_id']).toMatch(/^[0-9a-f]{16}$/);
  });

  it("Fastify's own request lines print the real request as {method, url}; the completed line carries the trace", async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const lines: string[] = [];
    app = Fastify({ loggerInstance: createStructuredLogger({ sink: (l) => lines.push(l), level: 'info' }) });
    registerHttpTracing(app);
    app.get('/x', async () => ({ ok: true }));
    // A real socket: fc-shared reads the node IncomingMessage a Fastify request holds, and
    // inject() hands Fastify a stand-in that is not one.
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/x?token=secret-value`, {
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01`, authorization: 'Bearer super-secret-value' },
    });
    await res.arrayBuffer();
    // 'request completed' is written after the response has gone out.
    await vi.waitFor(() => expect(lines.some((l) => l.includes('request completed'))).toBe(true));

    expect(res.headers.get(TRACE_RESPONSE_HEADER)).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const incoming = parsed.find((l) => l['msg'] === 'incoming request');
    const completed = parsed.find((l) => l['msg'] === 'request completed');
    // One JSON string, the query gone, no header and no client address.
    expect(incoming?.['req']).toBe('{"method":"GET","url":"/x"}');
    expect(completed?.['res']).toBe('{"statusCode":200}');
    expect(typeof completed?.['response_time']).toBe('number');
    expect(lines.join('\n')).not.toContain('secret-value');
    expect(JSON.stringify([incoming, completed])).not.toContain('127.0.0.1');
    // 'request completed' is written inside the span. 'incoming request' is NOT: Fastify writes
    // it before any onRequest hook runs, so it has no trace_id (it never had a trace tag) and
    // joins the request's other lines by req_id only.
    expect(completed?.['trace_id']).toBe(traceId);
    expect(incoming).not.toHaveProperty('trace_id');
    expect(completed?.['req_id']).toBe(incoming?.['req_id']);
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

// LGMOB C1: the HTTP edge is the first extract site, and its context becomes
// context.active() for everything later in the request, the Connect
// interceptor included. A client may name its trace here and nothing else.
describe('LGMOB C1: a client may set traceparent and nothing else (HTTP edge)', () => {
  const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
  const PARENT = '00f067aa0ba902b7';
  const PHONE_RUN = 'c0ffee00c0ffee00c0ffee00c0ffee00';

  /** What the handler's active context holds, as JSON. */
  const probe = (): Record<string, unknown> => {
    const active = context.active();
    const span = trace.getSpan(active);
    return {
      baggage: propagation.getBaggage(active)?.getAllEntries() ?? null,
      traceState: span?.spanContext().traceState?.serialize() ?? null,
      traceId: span?.spanContext().traceId ?? null,
      recording: span?.isRecording() ?? null,
    };
  };

  it("keeps a client's baggage out of the request context, so no log line can carry its run id", async () => {
    const lines: string[] = [];
    app = Fastify({ loggerInstance: createStructuredLogger({ sink: (l) => lines.push(l), level: 'info' }) });
    registerHttpTracing(app);
    app.get('/x', async (request) => {
      request.log.info('handling');
      return probe();
    });

    const res = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { traceparent: `00-${TRACE_ID}-${PARENT}-01`, baggage: `fc.run_id=${PHONE_RUN},vendor=x` },
    });

    expect(res.json()).toMatchObject({ baggage: null, traceId: TRACE_ID });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(PHONE_RUN);
  });

  it("drops a client's tracestate but keeps its trace id and parent", async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async () => probe());

    const res = await app.inject({
      method: 'GET',
      url: '/x',
      headers: { traceparent: `00-${TRACE_ID}-${PARENT}-01`, tracestate: 'vendor=x' },
    });
    await telemetry?.forceFlush();

    expect(res.json()).toMatchObject({ traceState: null, traceId: TRACE_ID });
    expect(capture.spans[0]?.parentSpanContext?.spanId).toBe(PARENT);
  });

  it.each([
    ['not a traceparent', 'not-a-traceparent'],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${PARENT}-01`],
    ['upper-case hex', `00-${TRACE_ID.toUpperCase()}-${PARENT}-01`],
  ])('ignores a malformed traceparent (%s) and starts a fresh root', async (_label, bad) => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async () => probe());

    const body = (await app.inject({ method: 'GET', url: '/x', headers: { traceparent: bad } })).json() as {
      traceId: string;
    };
    await telemetry?.forceFlush();

    expect(body.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.traceId).not.toBe('0'.repeat(32));
    expect(body.traceId).not.toBe(TRACE_ID);
    expect(capture.spans[0]?.parentSpanContext).toBeUndefined();
  });

  it("records a not-sampled client's span; its log line carried the trace id all along", async () => {
    const lines: string[] = [];
    app = Fastify({ loggerInstance: createStructuredLogger({ sink: (l) => lines.push(l), level: 'info' }) });
    registerHttpTracing(app);
    app.get('/x', async (request) => {
      request.log.info('handling');
      return probe();
    });

    const res = await app.inject({ method: 'GET', url: '/x', headers: { traceparent: `00-${TRACE_ID}-${PARENT}-00` } });

    // The sampled override at the edge: the span records (and would export) despite the 00.
    expect(res.json()).toMatchObject({ recording: true, traceId: TRACE_ID });
    // And the response says so: sampled, in the caller's trace.
    expect(res.headers[TRACE_RESPONSE_HEADER]).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
    // Red-team finding 11: this half held BEFORE the override too. A
    // NonRecordingSpan still has the trace id, so log joins never needed it.
    const handled = lines.map((l) => JSON.parse(l) as Record<string, string>).find((l) => l['msg'] === 'handling');
    expect(handled?.['trace_id']).toBe(TRACE_ID);
  });
});

describe('LG-C1: the traceresponse header', () => {
  it('is the traceparent layout for the span that served the request', () => {
    expect(TRACE_RESPONSE_HEADER).toBe('traceresponse');
    const span = { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7' };
    expect(traceResponseOf({ ...span, traceFlags: 1 })).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(traceResponseOf({ ...span, traceFlags: 0 })).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00');
  });

  it('names the exported SERVER span, and survives a handler that sets its own headers', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/x', async (_request, reply) => reply.header('cache-control', 'no-store').code(201).send({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/x' });
    await telemetry?.forceFlush();

    const span = capture.spans[0]!;
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers[TRACE_RESPONSE_HEADER]).toBe(`00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`);
  });

  it('is on a response Fastify did not write: a handler that hijacks the reply and answers on the node response', async () => {
    // No reply.send(), so a header kept on Fastify's reply is never written here.
    app = Fastify({ logger: false });
    registerHttpTracing(app);
    app.get('/raw', (_request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/proto' });
      reply.raw.end('ok');
    });

    const res = await app.inject({ method: 'GET', url: '/raw' });

    expect(res.statusCode).toBe(200);
    expect(res.headers[TRACE_RESPONSE_HEADER]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('is absent on an ignored path', async () => {
    app = Fastify({ logger: false });
    registerHttpTracing(app, { ignorePaths: ['/healthz'] });
    app.get('/healthz', async () => ({ ok: true }));

    const res = await app.inject({ method: 'GET', url: '/healthz?probe=1' });

    expect(res.headers).not.toHaveProperty(TRACE_RESPONSE_HEADER);
  });
});
