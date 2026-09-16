// ============================================================================
// W3C `traceparent` on every Connect hop — plan §A.5, RULE 3, the half slice 1a
// left open.
//
// WHAT WAS MISSING AND WHY IT MATTERED. fc-shared's getActiveTraceIds() reads
// the ACTIVE span; it neither creates one nor propagates one. Slice 1a
// registered a real SDK with an async context manager (rule 1) and kept the
// trace ids non-zero (rule 2), but nothing ever started a span for an inbound
// request — so a running coordinator emitted log lines with no trace tag, and
// an outbound call carried no header for the next service to join on. These two
// interceptors are the close.
//
//   SERVER  extracts `traceparent` from the incoming request headers into
//           context, then opens a SERVER span under it. Every line the HANDLER
//           logs now carries `trace=<id> span=<id>`, and the id is the CALLER's
//           trace, so fc-mobile, the coordinator and the spine all join on one
//           value.
//
//           WHAT THIS DOES NOT COVER, said plainly so nobody reads the slice-1a
//           gap as fully closed: Fastify's own "incoming request" and "request
//           completed" lines are written in Fastify's lifecycle hooks, which run
//           OUTSIDE this interceptor — it wraps the RPC invocation, not the HTTP
//           request. Those lines are still untagged. Tagging them needs an
//           onRequest hook, which is being built on feat/oidc-dpop-edge; this
//           file deliberately does not duplicate it.
//
//   CLIENT  opens a CLIENT span and injects `traceparent` from it into the
//           outgoing headers. It opens a span rather than merely copying the
//           active one for two reasons: the outbound RPC is genuinely its own
//           unit of work, and a hop made outside any span would otherwise go
//           out untraced — an all-zero id, which fc-shared reads as "no span".
//
// FOUR HOPS use these, per §A.5: fc-mobile -> coordinator (server),
// coordinator -> SpineRead (client), -> media-manager and -> OpenFGA later.
//
// SECRETS NEVER REACH A SPAN. The rule is never to SET them; these interceptors
// record OUTCOME AND COUNTS ONLY, following read-service.ts's precedent — the
// rpc name, and on failure the Connect status code. Never a subject, never the
// entitlement assertion, never a DPoP proof, never a nonce. What attributes
// they do set are passed through fc-shared's redactAttributes first, which is
// belt to RedactingSpanExporter's braces at export time.
// ============================================================================
import {
  type Attributes,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Span,
  type TextMapGetter,
  type TextMapSetter,
  type Tracer,
} from '@opentelemetry/api';
import { ConnectError, type Interceptor } from '@connectrpc/connect';
import { redactAttributes, type AttributeValue } from '../platform/shared.js';

/** The instrumentation scope these spans are attributed to. */
export const TRACER_NAME = 'fc-coordinator/connect';

/**
 * Connect's `Headers` is the WHATWG type, so the propagator's carrier accessors
 * are `get`/`set`/`keys` rather than plain property access. Getting this wrong
 * is silent: the propagator simply finds nothing and injects nothing.
 */
const headersGetter: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => [...carrier.keys()],
};

const headersSetter: TextMapSetter<Headers> = {
  set: (carrier, key, value) => carrier.set(key, value),
};

const tracerFor = (tracer?: Tracer): Tracer => tracer ?? trace.getTracer(TRACER_NAME);

/**
 * Outcome only. Redacted BEFORE the attribute is set, not after.
 *
 * SCALARS ONLY, and that is the type signature rather than a comment: every
 * attribute either interceptor sets is an rpc name or a status code. Narrowing
 * here also resolves a real gap between the two libraries — fc-shared's
 * AttributeValue admits `null` and a heterogeneous array, OTel's admits neither
 * — and the narrowing is done by DROPPING what does not fit, never by coercing
 * it. A null attribute is an attribute with nothing to say; stringifying it
 * would put the word "null" on a dashboard as though it were data.
 */
function setSafeAttributes(span: Span, attributes: Record<string, string | number>): void {
  // WHY A CAST AND NOT A RUNTIME GUARD. The two libraries' AttributeValue types
  // genuinely differ — fc-shared's admits null and a heterogeneous array, OTel's
  // admits neither — but the difference cannot materialise on this path.
  // redactAttributes maps a string to a string (via redactString) and passes
  // every other scalar through untouched, so a Record<string, string | number>
  // in is a Record<string, string | number> out. The parameter type is what
  // makes that hold, and it is the guarantee worth having: a guard here would
  // be a branch no call site can reach, which is worse than a stated cast
  // because it looks like it is doing something.
  span.setAttributes(redactAttributes(attributes as Record<string, AttributeValue>) as Attributes);
}

/**
 * Close a span from a thrown value WITHOUT recording the exception.
 *
 * `span.recordException` copies the message and the stack onto the span, and a
 * ConnectError's message routinely carries whatever the upstream said — which
 * is exactly the text that must not reach a collector. The CODE is the useful
 * part and the safe part, so that is all that is kept.
 */
function failSpan(span: Span, err: unknown): void {
  span.setStatus({ code: SpanStatusCode.ERROR });
  if (err instanceof ConnectError) {
    setSafeAttributes(span, { 'rpc.connect.status_code': err.code });
  }
}

/**
 * SERVER interceptor: continue the caller's trace, and be a span in it.
 *
 * `propagation.extract` alone would put the remote span context in scope, which
 * is enough for a log tag — but the coordinator would never appear in the trace
 * as a participant, and its outbound hop would name the CALLER's span as its
 * parent. Opening a span here is what makes the service visible.
 */
export function traceparentServerInterceptor(options: { tracer?: Tracer } = {}): Interceptor {
  return (next) => async (req) => {
    const parent = propagation.extract(context.active(), req.header, headersGetter);
    const span = tracerFor(options.tracer).startSpan(
      `${req.service.typeName}/${req.method.name}`,
      { kind: SpanKind.SERVER },
      parent,
    );
    setSafeAttributes(span, {
      'rpc.system': 'connect_rpc',
      'rpc.service': req.service.typeName,
      'rpc.method': req.method.name,
    });

    return context.with(trace.setSpan(parent, span), async () => {
      try {
        const res = await next(req);
        span.setStatus({ code: SpanStatusCode.OK });
        return res;
      } catch (err) {
        failSpan(span, err);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}

/**
 * CLIENT interceptor: be a span, and tell the next service which trace it is in.
 *
 * The span is started unconditionally. Inside a request it becomes a child of
 * the server span above; outside one — a background job, a startup probe — it
 * is a fresh root, which still yields a real non-zero id. The alternative,
 * injecting only when a span happens to be active, produces a hop that is
 * sometimes traced and sometimes not, and the untraced case is precisely the
 * one nobody notices until they need it.
 */
export function traceparentClientInterceptor(options: { tracer?: Tracer } = {}): Interceptor {
  return (next) => async (req) => {
    const span = tracerFor(options.tracer).startSpan(
      `${req.service.typeName}/${req.method.name}`,
      { kind: SpanKind.CLIENT },
    );
    setSafeAttributes(span, {
      'rpc.system': 'connect_rpc',
      'rpc.service': req.service.typeName,
      'rpc.method': req.method.name,
    });

    return context.with(trace.setSpan(context.active(), span), async () => {
      // Injected from the ACTIVE context, which is now this span — so the
      // header names this hop, not its parent.
      propagation.inject(context.active(), req.header, headersSetter);
      try {
        const res = await next(req);
        span.setStatus({ code: SpanStatusCode.OK });
        return res;
      } catch (err) {
        failSpan(span, err);
        throw err;
      } finally {
        span.end();
      }
    });
  };
}
