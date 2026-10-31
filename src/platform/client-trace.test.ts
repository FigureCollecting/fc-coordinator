import { ROOT_CONTEXT, propagation, trace, type TextMapGetter } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_TRACE_HEADER, clientTraceGetter, extractClientTrace } from './client-trace.js';
import { startTelemetry, type Telemetry } from './telemetry.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

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
});
