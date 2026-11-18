// LG-C1: what leaves the process. With an OTLP endpoint in the environment a span is exported
// over gRPC (HTTP/2, the TraceService/Export method), redacted first; with none, nothing is
// exported and spans still record real ids. Proven on the wire against a cleartext HTTP/2
// server, with nothing injected into startTelemetry.
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { startRawH2cServer, type RawH2cServer } from '../../test/helpers/rawH2cServer.js';
import { startTelemetry, type Telemetry } from './telemetry.js';

const EXPORT_PATH = '/opentelemetry.proto.collector.trace.v1.TraceService/Export';
// A compact JWS, the shape of the DPoP proof and the entitlement assertion.
const JWS = 'eyJhbGciOiJFUzI1NiIsInR5cCI6ImRwb3Arand0In0.eyJzdWIiOiJyb3NzIn0.c2ln';
const NONCE = 'q8Zr3kVn1xMpLb7TfGhQaWcEdRyUiOpAsDfGhJkLzXcVbNm0';

interface Received {
  path: string;
  contentType: string;
  body: Buffer;
}

interface Collector {
  server: RawH2cServer;
  received: Received[];
}

/** A collector that answers every stream as a gRPC server does: an empty message, grpc-status 0. */
async function startCollector(): Promise<Collector> {
  const received: Received[] = [];
  const server = await startRawH2cServer((stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      received.push({
        path: String(headers[':path']),
        contentType: String(headers['content-type']),
        body: Buffer.concat(chunks),
      });
      stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
      stream.end(Buffer.alloc(5));
    });
  });
  return { server, received };
}

let telemetry: Telemetry | undefined;
let collector: Collector | undefined;

afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
  await collector?.server.close();
  collector = undefined;
});

function emitSpan(name: string): string {
  let traceId = '';
  trace.getTracer('test').startActiveSpan(name, (span) => {
    span.setAttribute('app.dpop.proof', JWS);
    span.setAttribute('app.dpop_nonce', NONCE);
    span.setAttribute('app.dpop.attempts', 2);
    traceId = span.spanContext().traceId;
    span.end();
  });
  return traceId;
}

describe('LG-C1: the exporter is gRPC when an endpoint is set', () => {
  it.each([
    ['OTEL_EXPORTER_OTLP_ENDPOINT'],
    ['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'],
  ])('exports a span to %s as a gRPC call over HTTP/2', async (variable) => {
    collector = await startCollector();
    telemetry = startTelemetry({ env: { [variable]: collector.server.baseUrl } });
    expect(telemetry.state.exporter).toBe('otlp');

    const traceId = emitSpan('exported');
    await telemetry.forceFlush();

    expect(collector.received).toHaveLength(1);
    const call = collector.received[0]!;
    expect(call.path).toBe(EXPORT_PATH);
    expect(call.contentType).toMatch(/^application\/grpc/);
    // The gRPC frame: one uncompressed message whose length prefix is the rest of the body.
    expect(call.body[0]).toBe(0);
    expect(call.body.readUInt32BE(1)).toBe(call.body.length - 5);
    // The span is in it: its trace id (16 raw bytes) and its name.
    expect(call.body.includes(Buffer.from(traceId, 'hex'))).toBe(true);
    expect(call.body.includes(Buffer.from('exported'))).toBe(true);
  });

  it('redacts the span on the way out: a JWS by shape, a DPoP nonce by key', async () => {
    collector = await startCollector();
    telemetry = startTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: collector.server.baseUrl } });

    emitSpan('dpop.verify');
    await telemetry.forceFlush();

    const body = collector.received[0]!.body;
    expect(body.includes(Buffer.from(JWS))).toBe(false);
    expect(body.includes(Buffer.from(NONCE))).toBe(false);
    expect(body.includes(Buffer.from('[REDACTED]'))).toBe(true);
    // The attribute names survive, so an operator still sees that a proof was there.
    expect(body.includes(Buffer.from('app.dpop.attempts'))).toBe(true);
  });

  it('the traces-specific endpoint wins over the generic one', async () => {
    collector = await startCollector();
    const other = await startCollector();
    try {
      telemetry = startTelemetry({
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: other.server.baseUrl,
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: collector.server.baseUrl,
        },
      });

      emitSpan('routed');
      await telemetry.forceFlush();

      expect(collector.received).toHaveLength(1);
      expect(other.received).toHaveLength(0);
    } finally {
      await telemetry?.shutdown();
      telemetry = undefined;
      await other.server.close();
    }
  });

  it('reports no endpoint in its state: /healthz and the boot line read it', async () => {
    collector = await startCollector();
    telemetry = startTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: collector.server.baseUrl } });

    expect(JSON.stringify(telemetry.state)).not.toContain('127.0.0.1');
  });
});

describe('LG-C1: the exporter is a no-op when no endpoint is set', () => {
  it.each([
    ['unset', {}],
    ['blank', { OTEL_EXPORTER_OTLP_ENDPOINT: '  ', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: '' }],
  ])('exports nothing (%s), and a span still records with a real trace id', async (_label, env) => {
    telemetry = startTelemetry({ env });
    expect(telemetry.state.exporter).toBe('noop');
    expect(telemetry.state.registered).toBe(true);

    let recording: boolean | undefined;
    let traceId: string | undefined;
    trace.getTracer('test').startActiveSpan('local', (span) => {
      recording = span.isRecording();
      traceId = span.spanContext().traceId;
      span.end();
    });
    await telemetry.forceFlush();

    expect(recording).toBe(true);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).not.toBe('0'.repeat(32));
  });

  it('OTEL_TRACES_EXPORTER=none does not turn trace ids off', () => {
    // The bug that shipped once in fc-backend: a no-op PROVIDER hands out all-zero ids, and every
    // log line then loses its trace_id. Only the destination is ever a no-op here.
    telemetry = startTelemetry({ env: { OTEL_TRACES_EXPORTER: 'none' } });

    const span = trace.getTracer('test').startSpan('unit');
    expect(span.isRecording()).toBe(true);
    expect(span.spanContext().traceId).not.toBe('0'.repeat(32));
    span.end();
  });

  it('stamps the image revision it was given on its state, and unknown without one', async () => {
    telemetry = startTelemetry({ env: { SERVICE_VERSION: 'f12b8db612256cd714496c6d8b583c1b8eed11b6' } });
    expect(telemetry.state).toEqual({
      registered: true,
      exporter: 'noop',
      serviceName: 'fc-coordinator',
      version: 'f12b8db612256cd714496c6d8b583c1b8eed11b6',
    });
    await telemetry.shutdown();

    telemetry = startTelemetry({ env: {} });
    expect(telemetry.state.version).toBe('unknown');
  });
});
