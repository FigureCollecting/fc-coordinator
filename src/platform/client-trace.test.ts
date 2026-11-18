import { ROOT_CONTEXT, TraceFlags, context, propagation, trace, type TextMapGetter } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_TRACE_HEADER, clientTraceGetter, extractClientTrace } from './client-trace.js';
import { createStructuredLogger } from './logger.js';
import { startTelemetry, type Telemetry } from './telemetry.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
/** Shaped like a trace id, so fc-shared would accept it as a run id. */
const PHONE_RUN = 'c0ffee00c0ffee00c0ffee00c0ffee00';

const headersGetter: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};

// extractClientTrace goes through the GLOBAL propagator, which only exists once
// a provider is registered; without one it is a no-op and every assertion on
// the extracted trace would be vacuous.
let telemetry: Telemetry;
beforeEach(() => {
  telemetry = startTelemetry({ env: {} });
});
afterEach(async () => {
  await telemetry.shutdown();
});

describe('clientTraceGetter: the view of a client request a propagator is given', () => {
  const headers = new Headers({
    traceparent: TRACEPARENT,
    tracestate: 'vendor=x',
    baggage: 'fc.run_id=c0ffee00c0ffee00c0ffee00c0ffee00',
    'uber-trace-id': 'a:b:0:1',
  });

  it('exposes traceparent, and only traceparent, through get and keys', () => {
    const view = clientTraceGetter(headersGetter);

    expect(CLIENT_TRACE_HEADER).toBe('traceparent');
    expect(view.get(headers, 'traceparent')).toBe(TRACEPARENT);
    expect(view.get(headers, 'TraceParent')).toBe(TRACEPARENT);
    expect(view.get(headers, 'tracestate')).toBeUndefined();
    expect(view.get(headers, 'baggage')).toBeUndefined();
    // An allowlist: a propagator added later reads nothing else either.
    expect(view.get(headers, 'uber-trace-id')).toBeUndefined();
    expect(view.keys(headers)).toEqual(['traceparent']);
  });

  it('leaves the carrier itself untouched', () => {
    clientTraceGetter(headersGetter).get(headers, 'baggage');
    expect(headers.get('baggage')).not.toBeNull();
    expect(headers.get('tracestate')).toBe('vendor=x');
  });
});

describe('extractClientTrace', () => {
  it('reads a plain header object (Fastify) through the default getter', () => {
    const ctx = extractClientTrace(ROOT_CONTEXT, {
      traceparent: TRACEPARENT,
      tracestate: 'vendor=x',
      baggage: 'k=v',
    });

    expect(trace.getSpanContext(ctx)?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(trace.getSpanContext(ctx)?.isRemote).toBe(true);
    expect(trace.getSpanContext(ctx)?.traceState).toBeUndefined();
    expect(propagation.getBaggage(ctx)).toBeUndefined();
  });

  it('reads WHATWG Headers (Connect) through the getter it is given', () => {
    const ctx = extractClientTrace(
      ROOT_CONTEXT,
      new Headers({ traceparent: TRACEPARENT, baggage: 'k=v' }),
      headersGetter,
    );

    expect(trace.getSpanContext(ctx)?.spanId).toBe('00f067aa0ba902b7');
    expect(propagation.getBaggage(ctx)).toBeUndefined();
  });

  it("keeps baggage the server's context already holds: only the carrier is filtered", () => {
    const own = propagation.setBaggage(ROOT_CONTEXT, propagation.createBaggage({ mine: { value: '1' } }));
    const ctx = extractClientTrace(own, { traceparent: TRACEPARENT, baggage: 'k=v' });

    expect(propagation.getBaggage(ctx)?.getEntry('mine')?.value).toBe('1');
    expect(propagation.getBaggage(ctx)?.getEntry('k')).toBeUndefined();
  });

  it("never takes a client's fc.run_id as the server's run, with or without a traceparent", () => {
    // fc-shared's propagator turns an inbound fc.run_id baggage entry into the run id on every log
    // line. The edge shows it no baggage header, so a phone cannot name a run.
    const lines: string[] = [];
    const log = createStructuredLogger({ level: 'info', sink: (line) => lines.push(line) });
    for (const headers of [
      { traceparent: TRACEPARENT, baggage: `fc.run_id=${PHONE_RUN}` },
      { baggage: `fc.run_id=${PHONE_RUN}` },
    ]) {
      context.with(extractClientTrace(ROOT_CONTEXT, headers), () => log.info('handling'));
    }

    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain(PHONE_RUN);
    for (const line of lines) expect(JSON.parse(line)).not.toHaveProperty('run_id');
  });
});

// LGMOB C1, decided here since LG-C1: the provider's sampler follows the parent, so the parent a
// client names is marked sampled before a span is started under it.
describe("extractClientTrace: a client's sampled flag is not trusted", () => {
  const NOT_SAMPLED = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00';

  it('marks a not-sampled client parent sampled, keeping its trace id and span id', () => {
    const parent = trace.getSpanContext(extractClientTrace(ROOT_CONTEXT, { traceparent: NOT_SAMPLED }));

    expect(parent).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
      isRemote: true,
      traceFlags: TraceFlags.SAMPLED,
    });
  });

  it('so a span started under it records, and is itself sampled', () => {
    const span = trace
      .getTracer('test')
      .startSpan('x', {}, extractClientTrace(ROOT_CONTEXT, { traceparent: NOT_SAMPLED }));

    expect(span.isRecording()).toBe(true);
    expect(span.spanContext().traceFlags & TraceFlags.SAMPLED).toBe(TraceFlags.SAMPLED);
    span.end();
  });

  it('keeps the other flag bits a client set, adding only the sampled bit', () => {
    // 0x02 is the level-2 random-trace-id flag.
    const parent = trace.getSpanContext(
      extractClientTrace(ROOT_CONTEXT, { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-02' }),
    );
    expect(parent?.traceFlags).toBe(0x03);
  });

  it('leaves an already-sampled client parent exactly as extracted', () => {
    const parent = trace.getSpanContext(extractClientTrace(ROOT_CONTEXT, { traceparent: TRACEPARENT }));
    expect(parent?.traceFlags).toBe(TraceFlags.SAMPLED);
  });

  it('adds no parent when the client sent none, or a malformed one', () => {
    expect(trace.getSpanContext(extractClientTrace(ROOT_CONTEXT, {}))).toBeUndefined();
    expect(trace.getSpanContext(extractClientTrace(ROOT_CONTEXT, { traceparent: 'not-a-traceparent' }))).toBeUndefined();
  });

  it("does not touch the server's own not-sampled span when the client names no trace", () => {
    // Only the REMOTE parent this extract read is overridden. A local span already in the
    // context keeps the flag this service gave it.
    const local = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: TraceFlags.NONE };
    const ctx = extractClientTrace(trace.setSpanContext(ROOT_CONTEXT, local), {});

    expect(trace.getSpanContext(ctx)).toEqual(local);
  });
});
