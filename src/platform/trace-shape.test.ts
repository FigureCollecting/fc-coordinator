// LG-C1: the two places a request's trace id is visible. A log line carries the active span's ids
// as trace_id and span_id (the fc-shared log shape; the old `trace=<id> span=<id>` string and the
// camelCase traceId/spanId are gone), and every traced response names the same span in a W3C
// `traceresponse` header (Trace Context level 2: version-traceid-spanid-flags).
import { trace } from '@opentelemetry/api';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { TRACE_RESPONSE_HEADER } from './http-trace.js';
import { createStructuredLogger } from './logger.js';
import { startTelemetry, type Telemetry } from './telemetry.js';

type Line = Record<string, unknown>;

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const TRACE_RESPONSE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const reachableDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

let telemetry: Telemetry | undefined;
let app: FastifyInstance | undefined;

beforeEach(() => {
  telemetry = startTelemetry({ env: {} });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await telemetry?.shutdown();
  telemetry = undefined;
});

/** The trace id and span id a `traceresponse` value names. */
function idsOf(header: unknown): { traceId: string; spanId: string; flags: string } {
  expect(header).toEqual(expect.stringMatching(TRACE_RESPONSE));
  const [, traceId, spanId, flags] = TRACE_RESPONSE.exec(header as string)!;
  return { traceId: traceId!, spanId: spanId!, flags: flags! };
}

describe('LG-C1: a log line carries the active span as trace_id and span_id', () => {
  it('writes trace_id and span_id equal to the active span, across an await', async () => {
    const lines: string[] = [];
    const log = createStructuredLogger({ level: 'info', sink: (line) => lines.push(line) });

    let active: { traceId: string; spanId: string } | undefined;
    await trace.getTracer('test').startActiveSpan('unit', async (span) => {
      await new Promise((resolve) => setImmediate(resolve));
      active = span.spanContext();
      log.info('inside');
      span.end();
    });

    const line = JSON.parse(lines[0]!) as Line;
    expect(active?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(line['trace_id']).toBe(active?.traceId);
    expect(line['span_id']).toBe(active?.spanId);
  });

  it('drops the old trace= string and the camelCase ids', async () => {
    const lines: string[] = [];
    const log = createStructuredLogger({ level: 'info', sink: (line) => lines.push(line) });

    trace.getTracer('test').startActiveSpan('unit', (span) => {
      log.info('inside');
      span.end();
    });

    const line = JSON.parse(lines[0]!) as Line;
    expect(Object.keys(line)).not.toEqual(expect.arrayContaining(['trace']));
    expect(line).not.toHaveProperty('traceId');
    expect(line).not.toHaveProperty('spanId');
    expect(lines[0]).not.toContain('trace=');
  });

  it('writes neither id outside a span, never a zeroed one', () => {
    const lines: string[] = [];
    createStructuredLogger({ level: 'info', sink: (line) => lines.push(line) }).info('outside');

    const line = JSON.parse(lines[0]!) as Line;
    expect(line).not.toHaveProperty('trace_id');
    expect(line).not.toHaveProperty('span_id');
    expect(line['msg']).toBe('outside');
  });
});

describe('LG-C1: every traced response carries a matching traceresponse', () => {
  function build(lines: string[]): FastifyInstance {
    const built = buildApp({ db: reachableDb, logLevel: 'info', logSink: (line) => lines.push(line) });
    built.get('/ok', async (request) => {
      request.log.info('handling');
      return { ok: true };
    });
    built.get('/boom', async (request) => {
      request.log.info('handling');
      throw new Error('kaboom');
    });
    built.get('/refused', async (request, reply) => {
      request.log.info('handling');
      return reply.code(401).send({ error: 'invalid_token' });
    });
    return built;
  }

  const handled = (lines: string[]): Line =>
    lines.map((line) => JSON.parse(line) as Line).find((line) => line['msg'] === 'handling')!;

  it('names the request span: the same trace_id and span_id its log line carries', async () => {
    const lines: string[] = [];
    app = build(lines);

    const res = await app.inject({ method: 'GET', url: '/ok' });

    expect(res.statusCode).toBe(200);
    const ids = idsOf(res.headers[TRACE_RESPONSE_HEADER]);
    expect(ids.traceId).not.toBe('0'.repeat(32));
    expect(handled(lines)['trace_id']).toBe(ids.traceId);
    expect(handled(lines)['span_id']).toBe(ids.spanId);
  });

  it("continues the caller's trace: the caller's trace id, this service's span id, sampled", async () => {
    app = build([]);

    const res = await app.inject({
      method: 'GET',
      url: '/ok',
      headers: { traceparent: `00-${TRACE_ID}-${PARENT}-01` },
    });

    const ids = idsOf(res.headers[TRACE_RESPONSE_HEADER]);
    expect(ids.traceId).toBe(TRACE_ID);
    expect(ids.spanId).not.toBe(PARENT);
    expect(ids.flags).toBe('01');
  });

  it.each([
    ['a 500 from a handler that threw', '/boom', 500],
    ['a 401 the handler answered', '/refused', 401],
  ])('is on an error response too (%s), matching that request line', async (_label, url, status) => {
    const lines: string[] = [];
    app = build(lines);

    const res = await app.inject({ method: 'GET', url });

    expect(res.statusCode).toBe(status);
    const ids = idsOf(res.headers[TRACE_RESPONSE_HEADER]);
    expect(handled(lines)['trace_id']).toBe(ids.traceId);
    expect(handled(lines)['span_id']).toBe(ids.spanId);
  });

  it('is on a 404 for a path no route matched', async () => {
    app = build([]);

    const res = await app.inject({ method: 'GET', url: '/missing' });

    expect(res.statusCode).toBe(404);
    expect(idsOf(res.headers[TRACE_RESPONSE_HEADER]).traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('gives two requests two different traces', async () => {
    app = build([]);

    const first = idsOf((await app.inject({ method: 'GET', url: '/ok' })).headers[TRACE_RESPONSE_HEADER]);
    const second = idsOf((await app.inject({ method: 'GET', url: '/ok' })).headers[TRACE_RESPONSE_HEADER]);

    expect(second.traceId).not.toBe(first.traceId);
  });

  it('is absent on /healthz, which opens no span: there is no trace to name', async () => {
    app = build([]);

    const res = await app.inject({ method: 'GET', url: '/healthz' });

    expect(res.statusCode).toBe(200);
    expect(res.headers).not.toHaveProperty(TRACE_RESPONSE_HEADER);
  });
});
