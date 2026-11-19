// ============================================================================
// What a CLIENT may tell this service about tracing: its traceparent, nothing
// else (LGMOB C1).
//
// The two client-facing edges, Fastify's onRequest hook (http-trace.ts) and
// the Connect server interceptor, extract through the GLOBAL propagator.
// Whatever it reads from a phone's request becomes part of the server's
// context, and from there part of every outbound hop:
//   tracestate  the SDK copies a parent's trace state onto each child span, and
//               the W3C injector writes it on the SpineRead hop.
//   baggage     the W3C baggage propagator re-injects it on every hop, and
//               fc-shared's RunIdBaggagePropagator (lg-logging U8) turns an
//               inbound `fc.run_id` entry into the run id on log lines.
// So an edge hands the propagator a VIEW of the headers in which only
// `traceparent` exists. It is an allowlist rather than a denylist, so a
// propagator added later reads nothing from a client either.
//
// WHY THE EDGE AND NOT THE GLOBAL PROPAGATOR: the server's OWN baggage must
// keep reaching our services (fc-shared's fc.run_id rules), and U8 installs
// fc-shared's propagator stack globally, which would undo a global change made
// here. The edge is the one place that knows the caller is a client.
//
// The traceparent itself is still parsed by the W3C propagator, which ignores
// a malformed one (the request then starts a fresh root).
//
// ITS SAMPLED FLAG IS NOT TRUSTED EITHER, and this is where that is decided
// (LG-C1; a sampler in telemetry.ts decided it before). The provider is
// fc-shared's, whose sampler follows the parent: a phone that sent `-00` would
// turn this service's spans off and pass the 00 on to the spine. So the
// extracted parent is marked sampled before any span is started under it. Only
// a REMOTE parent, the one this extract just read: a span already active in
// `ctx` is the server's own and keeps its flag.
// ============================================================================
import {
  TraceFlags,
  defaultTextMapGetter,
  propagation,
  trace,
  type Context,
  type TextMapGetter,
} from '@opentelemetry/api';

/** The one inbound header a client-facing edge lets the propagator read. */
export const CLIENT_TRACE_HEADER = 'traceparent';

const isClientTraceHeader = (key: string): boolean => key.toLowerCase() === CLIENT_TRACE_HEADER;

/** `inner`, seeing only the traceparent header. The carrier is never modified. */
export function clientTraceGetter<Carrier>(inner: TextMapGetter<Carrier>): TextMapGetter<Carrier> {
  return {
    get: (carrier, key) => (isClientTraceHeader(key) ? inner.get(carrier, key) : undefined),
    keys: (carrier) => inner.keys(carrier).filter(isClientTraceHeader),
  };
}

/**
 * `propagation.extract` for a request from a client: the remote span context
 * from its traceparent and nothing else, marked sampled whatever its flag said.
 * Baggage already in `ctx` is the server's own and is kept.
 */
export function extractClientTrace<Carrier>(
  ctx: Context,
  carrier: Carrier,
  getter: TextMapGetter<Carrier> = defaultTextMapGetter,
): Context {
  const extracted = propagation.extract(ctx, carrier, clientTraceGetter(getter));
  const parent = trace.getSpanContext(extracted);
  if (parent?.isRemote !== true || (parent.traceFlags & TraceFlags.SAMPLED) !== 0) return extracted;
  return trace.setSpanContext(extracted, { ...parent, traceFlags: parent.traceFlags | TraceFlags.SAMPLED });
}
