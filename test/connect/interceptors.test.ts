/**
 * The traceparent interceptors, looked at from the SPAN side rather than the
 * header side.
 *
 * test/connect/compare.test.ts already proves the header threads both hops end
 * to end. What it cannot see is what the interceptors WRITE — and §A.5's rule
 * about spans is a prohibition, not a feature: "record outcome and counts only
 * ... never `sub`, never the assertion, never a proof, never a nonce." A
 * prohibition needs a test that looks at the spans themselves, so this file
 * collects every exported span and reads it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  type Baggage,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { Code, ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createRouterTransport } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  SpineRead,
  CompareResponseSchema,
  type CompareResponse,
} from '@figurecollecting/ingest-contract/read';
import { startTelemetry, type Telemetry } from '../../src/platform/telemetry.js';
import { getActiveTraceIds } from '../../src/platform/shared.js';
import {
  TRACER_NAME,
  traceparentClientInterceptor,
  traceparentServerInterceptor,
} from '../../src/connect/interceptors.js';

/** Keeps every span it is handed, so a test can read what was recorded. */
class CollectingExporter implements SpanExporter {
  readonly spans: ReadableSpan[] = [];
  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    this.spans.push(...spans);
    done({ code: ExportResultCode.SUCCESS });
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

/** A compact JWS, the shape of both the entitlement assertion and a DPoP proof. */
const ASSERTION =
  'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI3ZjNhMWM2Mi05ZDQ0In0.c2lnbmF0dXJl';
const SUBJECT = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const NOW_ISO = '2026-09-14T12:00:00.000Z';

let telemetry: Telemetry;
let exporter: CollectingExporter;

beforeEach(() => {
  exporter = new CollectingExporter();
  telemetry = startTelemetry({ env: {}, serviceName: 'fc-coordinator-test', exporter });
});

afterEach(async () => {
  await telemetry.shutdown();
});

/**
 * A SpineRead client and server wired through connect's in-memory transport,
 * with both interceptors in the chain. No socket: the subject here is the
 * spans, and a real port would add nothing but flakiness.
 */
function wire(
  impl: () => CompareResponse | Promise<CompareResponse>,
  options: { tracer?: Tracer } = {},
): Client<typeof SpineRead> {
  const transport = createRouterTransport(
    ({ service }) => {
      service(SpineRead, { compare: impl });
    },
    {
      router: { interceptors: [traceparentServerInterceptor(options)] },
      transport: { interceptors: [traceparentClientInterceptor(options)] },
    },
  );
  return createClient(SpineRead, transport);
}

const ok = (): CompareResponse =>
  create(CompareResponseSchema, {
    resultJson: '{"heads":[],"coverage":{"semanticsRev":"a1b2c3d4e5f60789"}}',
  });

const named = (kind: SpanKind): ReadableSpan | undefined =>
  exporter.spans.find((s) => s.kind === kind);

/**
 * The exportable surface of a span, as one string.
 *
 * A live SpanImpl holds a reference back to its processor and on to this
 * exporter, so JSON.stringify of the span itself is a circular structure. What
 * actually reaches a collector is the name, the attributes, the status and the
 * events, and those are what a "must not appear anywhere" assertion needs.
 */
const exportedText = (span: ReadableSpan | undefined): string =>
  JSON.stringify({
    name: span?.name,
    attributes: span?.attributes,
    status: span?.status,
    events: span?.events,
    links: span?.links,
  });

describe('what the interceptors record', () => {
  it('opens a CLIENT span and a SERVER span, in one trace', async () => {
    await wire(ok).compare({ seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO });

    const client = named(SpanKind.CLIENT);
    const server = named(SpanKind.SERVER);
    expect(client).toBeDefined();
    expect(server).toBeDefined();
    expect(server?.spanContext().traceId).toBe(client?.spanContext().traceId);
    // The server span's parent is the client span — that is what "propagated"
    // means, as opposed to two unrelated spans that happen to share an id.
    expect(server?.parentSpanContext?.spanId).toBe(client?.spanContext().spanId);
  });

  it('names the rpc and nothing more', async () => {
    await wire(ok).compare({ seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO });

    const server = named(SpanKind.SERVER);
    expect(server?.name).toBe('read.v1.SpineRead/Compare');
    expect(server?.attributes).toEqual({
      'rpc.system': 'connect_rpc',
      'rpc.service': 'read.v1.SpineRead',
      'rpc.method': 'Compare',
    });
  });

  it('records OK on success', async () => {
    await wire(ok).compare({ seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO });
    expect(named(SpanKind.SERVER)?.status.code).toBe(SpanStatusCode.OK);
    expect(named(SpanKind.CLIENT)?.status.code).toBe(SpanStatusCode.OK);
  });

  it('records the Connect CODE on failure, and no exception event', async () => {
    const client = wire(() => {
      // The message deliberately carries something that must not be exported.
      throw new ConnectError(`upstream said ${ASSERTION}`, Code.PermissionDenied);
    });

    await expect(
      client.compare({ seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO }),
    ).rejects.toThrow();

    const server = named(SpanKind.SERVER);
    expect(server?.status.code).toBe(SpanStatusCode.ERROR);
    expect(server?.attributes['rpc.connect.status_code']).toBe(Code.PermissionDenied);
    // recordException would have copied the message and the stack onto the
    // span. Nothing here does, so there are no events at all.
    expect(server?.events).toEqual([]);
    expect(exportedText(server)).not.toContain(ASSERTION);
  });

  it('records a NON-Connect throw as an error, without inventing a status code', async () => {
    const client = wire(() => {
      throw new TypeError('something in the handler was undefined');
    });

    await expect(
      client.compare({ seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO }),
    ).rejects.toThrow();

    const server = named(SpanKind.SERVER);
    expect(server?.status.code).toBe(SpanStatusCode.ERROR);
    expect(server?.attributes['rpc.connect.status_code']).toBeUndefined();
    expect(exportedText(server)).not.toContain('something in the handler was undefined');
  });

  it('ends every span, so a failed call cannot leak one', async () => {
    const client = wire(() => {
      throw new ConnectError('nope', Code.Internal);
    });
    await expect(
      client.compare({ seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO }),
    ).rejects.toThrow();

    // Both spans reached the exporter at all, which only ended spans do.
    expect(exporter.spans.filter((s) => s.ended)).toHaveLength(2);
  });
});

describe('the tag fc-shared reads is live inside the handler', () => {
  // This is the half of the slice-1a "no trace tag on live log lines" gap that
  // rule 3 actually closes. getActiveTraceIds() reads the ACTIVE span, so any
  // line the HANDLER logs is tagged with the caller's trace from here on.
  //
  // WHAT IT DOES NOT CLOSE, stated so nobody reads more into it: Fastify's own
  // "incoming request" / "request completed" lines are written in Fastify's
  // lifecycle hooks, which run outside this interceptor. Tagging those needs an
  // onRequest hook, and that is being built on feat/oidc-dpop-edge.
  it('exposes the INBOUND trace id to handler code, not a fresh one', async () => {
    let seen: { traceId: string; spanId: string } | undefined;
    // SERVER interceptor only. With the client interceptor in front it would
    // open its own span and inject THAT, overwriting the traceparent this test
    // supplies — correct behaviour for the pair, but it would leave the server
    // half asserted against a header our own code wrote.
    const transport = createRouterTransport(
      ({ service }) => {
        service(SpineRead, {
          compare: () => {
            seen = getActiveTraceIds();
            return ok();
          },
        });
      },
      { router: { interceptors: [traceparentServerInterceptor()] } },
    );
    const client = createClient(SpineRead, transport);

    await client.compare(
      { seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO },
      { headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' } },
    );

    expect(seen?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    // A real span of this service's own, not the caller's and not the all-zero
    // id fc-shared treats as "no span".
    expect(seen?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(seen?.spanId).not.toBe('00f067aa0ba902b7');
    expect(seen?.spanId).not.toBe('0'.repeat(16));
  });
});

describe('§A.5 — secrets never reach a span', () => {
  it('exports neither the entitlement assertion nor the caller subject', async () => {
    const client = wire(ok);

    await client.compare(
      { seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO },
      { headers: { 'fc-entitlements': ASSERTION, 'x-subject': SUBJECT } },
    );

    // Everything the collector was handed, as one string. The interceptors set
    // three attributes by name and never touch the header bag, so neither value
    // can appear — and if a later change started copying headers onto a span,
    // this is the line that would go red.
    const exported = JSON.stringify(exporter.spans.map((s) => s.attributes));
    expect(exported).not.toContain(ASSERTION);
    expect(exported).not.toContain(SUBJECT);
    expect(exported).not.toContain('eyJ');
  });
});

describe('the tracer is injectable', () => {
  it('uses an injected tracer instead of the global one', async () => {
    const used: string[] = [];
    const real = trace.getTracer('injected');
    const spy = {
      startSpan: (name: string, opts?: unknown, ctx?: unknown) => {
        used.push(name);
        return (real as unknown as { startSpan: Function }).startSpan(name, opts, ctx);
      },
      startActiveSpan: (real as unknown as { startActiveSpan: Function }).startActiveSpan.bind(real),
    } as unknown as Tracer;

    await wire(ok, { tracer: spy }).compare({
      seed: { case: 'gtin14', value: '04573102591234' },
      nowIso: NOW_ISO,
    });

    expect(used).toEqual(['read.v1.SpineRead/Compare', 'read.v1.SpineRead/Compare']);
  });

  it('falls back to a tracer named for this module', () => {
    expect(TRACER_NAME).toBe('fc-coordinator/connect');
  });
});

describe('the carrier accessors match the WHATWG Headers API', () => {
  it('extracts a traceparent the propagator can read back', () => {
    // Headers is get/set/keys, not property access. Getting that wrong is
    // silent — the propagator finds nothing and injects nothing — so the shape
    // is asserted directly rather than only through an end-to-end call.
    const inbound = new Headers({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    const ctx = propagation.extract(context.active(), inbound, {
      get: (c, k) => (c as Headers).get(k) ?? undefined,
      keys: (c) => [...(c as Headers).keys()],
    });
    expect(trace.getSpanContext(ctx)?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });

  it('starts a fresh root when the inbound traceparent is absent or malformed', async () => {
    const client = wire(ok);
    await client.compare(
      { seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO },
      { headers: { traceparent: 'not-a-traceparent' } },
    );

    const server = named(SpanKind.SERVER);
    // A real id, not the all-zero one fc-shared reads as "no span".
    expect(server?.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(server?.spanContext().traceId).not.toBe('0'.repeat(32));
  });
});

// ===========================================================================
// LGMOB C1: what a CLIENT's trace headers can do at the Connect edge.
//
// A phone may name the trace it is in (traceparent) and nothing else. Its
// tracestate and baggage must not reach the server's context, because the SDK
// copies a parent's tracestate onto every child span and the W3C propagators
// re-inject both on the SpineRead hop. A phone-supplied `fc.run_id` entry would
// also become the server's run id once fc-shared's RunIdBaggagePropagator is
// installed (lg-logging U8). The strip is at the edge, not in the global
// propagator, so the server's OWN baggage still goes to our services; the last
// tests in this block pin both halves.
// ===========================================================================
const PHONE_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PHONE_PARENT = '00f067aa0ba902b7';
const phoneTraceparent = (flags: '00' | '01' = '01'): string =>
  `00-${PHONE_TRACE}-${PHONE_PARENT}-${flags}`;
/** Run ids have the shape of a trace id, so fc-shared would accept these. */
const PHONE_RUN = 'c0ffee00c0ffee00c0ffee00c0ffee00';
const SERVER_RUN = '5e1f9a332c6d4e518b0a7f3a1c629d44';

interface Relay {
  /** Plays fc-mobile: sends exactly the headers a test gives it, with no interceptor of ours. */
  phone: Client<typeof SpineRead>;
  /** Request headers of every call the coordinator made to the spine. */
  outbound: Headers[];
  /** The coordinator handler's active context, one entry per call. */
  inHandler: {
    baggage: Baggage | undefined;
    span: Span | undefined;
    /** Read while the span is open: an ended SDK span always reports false. */
    recording: boolean | undefined;
    ids: { traceId: string; spanId: string } | undefined;
  }[];
}

/**
 * fc-mobile -> coordinator -> SpineRead, in memory. The coordinator half runs
 * its handler behind the SERVER interceptor and calls the spine through the
 * CLIENT interceptor, as compare does. With `serverRun`, the handler adds a run
 * id of its own to baggage the way fc-shared's run-id rules do (fc.run_id
 * first, then the context's other entries), so a test can tell the server's
 * baggage apart from anything a client sent.
 */
function relay(options: { serverRun?: string } = {}): Relay {
  const outbound: Headers[] = [];
  const inHandler: Relay['inHandler'] = [];
  const spine = createClient(
    SpineRead,
    createRouterTransport(
      ({ service }) => {
        service(SpineRead, {
          compare: (_req, ctx) => {
            outbound.push(new Headers(ctx.requestHeader));
            return ok();
          },
        });
      },
      { transport: { interceptors: [traceparentClientInterceptor()] } },
    ),
  );
  const phone = createClient(
    SpineRead,
    createRouterTransport(
      ({ service }) => {
        service(SpineRead, {
          compare: (req) => {
            const active = context.active();
            const baggage = propagation.getBaggage(active);
            const span = trace.getSpan(active);
            inHandler.push({ baggage, span, recording: span?.isRecording(), ids: getActiveTraceIds() });
            if (options.serverRun === undefined) return spine.compare(req);
            let own = propagation.createBaggage({ 'fc.run_id': { value: options.serverRun } });
            for (const [key, entry] of baggage?.getAllEntries() ?? []) {
              if (key !== 'fc.run_id') own = own.setEntry(key, entry);
            }
            return context.with(propagation.setBaggage(active, own), () => spine.compare(req));
          },
        });
      },
      { router: { interceptors: [traceparentServerInterceptor()] } },
    ),
  );
  return { phone, outbound, inHandler };
}

const compareFrom = (r: Relay, headers: Record<string, string>): Promise<CompareResponse> =>
  r.phone.compare(
    { seed: { case: 'gtin14', value: '04573102591234' }, nowIso: NOW_ISO },
    { headers },
  );

describe('LGMOB C1: a client may set traceparent and nothing else (Connect edge)', () => {
  it.each([
    ['beside a valid traceparent', { traceparent: phoneTraceparent() }],
    ['with no traceparent at all', {}],
  ])("keeps a client's baggage out of the handler and off the spine hop (%s)", async (_label, tp) => {
    const r = relay();
    await compareFrom(r, { ...tp, baggage: `fc.run_id=${PHONE_RUN},vendor=x` });

    expect(r.inHandler[0]?.baggage).toBeUndefined();
    expect(r.outbound[0]?.get('baggage')).toBeNull();
  });

  it("drops a client's tracestate, so the spine hop carries none", async () => {
    const r = relay();
    await compareFrom(r, { traceparent: phoneTraceparent(), tracestate: 'vendor=x' });

    expect(r.inHandler[0]?.span?.spanContext().traceState).toBeUndefined();
    expect(r.outbound[0]?.get('tracestate')).toBeNull();
  });

  it("still honours the client's traceparent: same trace, parented on the phone's span", async () => {
    const r = relay();
    await compareFrom(r, {
      traceparent: phoneTraceparent(),
      tracestate: 'vendor=x',
      baggage: 'vendor=x',
    });

    const server = named(SpanKind.SERVER);
    expect(server?.spanContext().traceId).toBe(PHONE_TRACE);
    expect(server?.parentSpanContext?.spanId).toBe(PHONE_PARENT);
    expect(r.outbound[0]?.get('traceparent')).toMatch(
      new RegExp(`^00-${PHONE_TRACE}-[0-9a-f]{16}-01$`),
    );
  });

  it.each([
    ['not a traceparent', 'not-a-traceparent'],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${PHONE_PARENT}-01`],
    ['an all-zero parent id', `00-${PHONE_TRACE}-${'0'.repeat(16)}-01`],
    ['the forbidden version ff', `ff-${PHONE_TRACE}-${PHONE_PARENT}-01`],
    ['upper-case hex', `00-${PHONE_TRACE.toUpperCase()}-${PHONE_PARENT}-01`],
  ])('ignores a malformed traceparent (%s) and starts a fresh root', async (_label, bad) => {
    // SERVER-only path to the coordinator, so the bad header reaches the server
    // interceptor as sent. (The older malformed test above goes through the
    // client interceptor, which overwrites the header before the server sees it.)
    const r = relay();
    await compareFrom(r, { traceparent: bad, tracestate: 'vendor=x' });

    const server = named(SpanKind.SERVER);
    const fresh = server?.spanContext().traceId;
    expect(server?.parentSpanContext).toBeUndefined();
    expect(fresh).toMatch(/^[0-9a-f]{32}$/);
    expect(fresh).not.toBe('0'.repeat(32));
    expect(fresh).not.toBe(PHONE_TRACE);
    expect(r.outbound[0]?.get('traceparent')).toContain(fresh);
    expect(r.outbound[0]?.get('tracestate')).toBeNull();
  });

  it("still sends the server's OWN baggage to our services, and never the phone's run id", async () => {
    const r = relay({ serverRun: SERVER_RUN });
    await compareFrom(r, {
      traceparent: phoneTraceparent(),
      baggage: `fc.run_id=${PHONE_RUN},vendor=x`,
    });

    // Exactly the server's entry. The phone's run id and its other entry are
    // gone, and the global W3C baggage propagator still writes the header: a
    // global propagator with no baggage half (the plan's first cut) sends null.
    expect(r.outbound[0]?.get('baggage')).toBe(`fc.run_id=${SERVER_RUN}`);
  });

  it("does not let a client's not-sampled flag switch the coordinator's spans off", async () => {
    const r = relay();
    await compareFrom(r, { traceparent: phoneTraceparent('00') });

    const span = r.inHandler[0]?.span;
    expect(r.inHandler[0]?.recording).toBe(true);
    expect(span?.spanContext().traceId).toBe(PHONE_TRACE);
    // So the spine is asked to sample too, rather than inheriting the phone's 00.
    expect(r.outbound[0]?.get('traceparent')).toMatch(
      new RegExp(`^00-${PHONE_TRACE}-[0-9a-f]{16}-01$`),
    );
  });

  it('a not-sampled request was ALREADY joinable in logs: the sampler is export-time only', async () => {
    // Red-team finding 11, pinned. fc-shared's getActiveTraceIds reads the span
    // context of a NonRecordingSpan too, so a log line under a flags-00 request
    // carried the phone's trace id before the sampler existed. This passes with
    // or without the sampler; it is here so nobody credits it with log joins.
    const r = relay();
    await compareFrom(r, { traceparent: phoneTraceparent('00') });

    expect(r.inHandler[0]?.ids?.traceId).toBe(PHONE_TRACE);
    expect(r.outbound[0]?.get('traceparent')).toContain(PHONE_TRACE);
  });
});
