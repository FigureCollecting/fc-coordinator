// ============================================================================
// Inbound HTTP tracing — the gap slice 1a recorded as N3.
//
// The logger has always stamped `trace=<id> span=<id>` whenever a span is
// active, and telemetry has always registered a real SDK with an AsyncLocalStorage
// context manager. What was missing is the thing that OPENS a span: nothing
// instrumented inbound HTTP, so a running service emitted no tagged line and
// the tag was correctly absent rather than wrong. This closes it.
//
// THE MECHANISM, and why the hook is callback-style rather than async: the span
// must be active for the REST of the request lifecycle, not just for the hook.
// `context.with(ctx, done)` invokes Fastify's `done` INSIDE the AsyncLocalStorage
// run, so every later hook, the handler, and everything it awaits inherit the
// context. An `async` onRequest hook cannot do that — it would return, the ALS
// frame would unwind, and the handler would run outside the span with the trace
// tag silently absent again. That is precisely the failure mode N3 describes,
// so the shape here is load-bearing and the test asserts it across an `await`.
//
// CARDINALITY: the span is named by ROUTE TEMPLATE (`GET /auth/devices/:deviceId/revoke`),
// never by the concrete path. A uuid in a span name makes every request its own
// operation and is unusable in aggregate.
//
// SECRETS: `url.path` carries the path with the QUERY STRING REMOVED, and no
// header is copied onto the span. The exception message is handed to
// recordException (which the redacting exporter also passes over) rather than
// being set as a bare attribute.
// ============================================================================
import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
} from '@opentelemetry/semantic-conventions';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface HttpTracingOptions {
  tracer?: Tracer;
  /** Paths that open no span at all — a liveness probe every second is noise. */
  ignorePaths?: string[];
}

const TRACER_NAME = 'fc-coordinator/http';

export function registerHttpTracing(app: FastifyInstance, options: HttpTracingOptions = {}): void {
  const ignore = new Set(options.ignorePaths ?? []);
  // Resolved per request, not captured here: startTelemetry may register its
  // provider AFTER buildApp, and a tracer cached before that would be a no-op.
  const tracerFor = (): Tracer => options.tracer ?? trace.getTracer(TRACER_NAME);

  const spans = new WeakMap<FastifyRequest, Span>();

  const pathOf = (request: FastifyRequest): string => request.url.split('?')[0]!.split('#')[0]!;

  app.addHook('onRequest', (request, _reply, done) => {
    const path = pathOf(request);
    if (ignore.has(path)) {
      done();
      return;
    }

    // Routing has already happened by onRequest, so the TEMPLATE is available;
    // a request that matched nothing (404) falls back to its path.
    const route = request.routeOptions.url ?? path;
    const parent = propagation.extract(context.active(), request.headers);
    const span = tracerFor().startSpan(
      `${request.method} ${route}`,
      {
        kind: SpanKind.SERVER,
        attributes: {
          [ATTR_HTTP_REQUEST_METHOD]: request.method,
          [ATTR_HTTP_ROUTE]: route,
          [ATTR_URL_PATH]: path,
        },
      },
      parent,
    );
    spans.set(request, span);

    // `done` is called INSIDE the context: see the header. Do not make this
    // hook async.
    context.with(trace.setSpan(parent, span), done);
  });

  app.addHook('onError', async (request, _reply, error) => {
    spans.get(request)?.recordException(error);
  });

  app.addHook('onResponse', async (request, reply) => {
    const span = spans.get(request);
    if (span === undefined) return;

    const status = reply.statusCode;
    span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status);
    // 4xx is the CLIENT's problem — a rejected DPoP proof is the system working,
    // not an error. Only 5xx marks the span failed (OTel HTTP semantics).
    if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    spans.delete(request);
  });
}
