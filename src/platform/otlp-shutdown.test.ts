// LG-C1: a collector that takes the connection and never answers. server.ts stops the process
// hard, with exit 1, 10 s after SIGTERM, and telemetry shuts down last in that drain; the gRPC
// export's own deadline is 10 s, so this collector alone used to turn a clean stop into a failed
// one. In its own file: the abandoned flush is still running when shutdown() returns, and a file
// is a fresh process as far as the tracing globals go.
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { SHUTDOWN_TIMEOUT_MS, startTelemetry } from './telemetry.js';

const sockets: Socket[] = [];
let blackhole: Server | undefined;

afterEach(async () => {
  // Resetting the connections fails the export at once, so nothing outlives the test.
  sockets.splice(0).forEach((socket) => socket.destroy());
  const server = blackhole;
  blackhole = undefined;
  if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function startBlackhole(): Promise<string> {
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on('error', () => {});
  });
  blackhole = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('LG-C1: a dead collector does not hold the drain', () => {
  it('shutdown returns after its own budget with spans still queued, well inside the 10 s hard stop', async () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
    const telemetry = startTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: await startBlackhole() } });
    expect(telemetry.state.exporter).toBe('otlp');
    for (let i = 0; i < 100; i += 1) trace.getTracer('test').startSpan(`queued-${i}`).end();

    const startedAt = performance.now();
    await expect(telemetry.shutdown()).resolves.toBeUndefined();
    const waited = performance.now() - startedAt;

    // It waited for the collector (the spans were worth a try), and gave up on it.
    expect(waited).toBeGreaterThanOrEqual(SHUTDOWN_TIMEOUT_MS - 100);
    expect(waited).toBeLessThan(SHUTDOWN_TIMEOUT_MS + 3_000);
    expect(sockets.length).toBeGreaterThan(0);
  }, 30_000);
});
