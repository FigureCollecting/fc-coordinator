// ============================================================================
// Process entrypoint.
//
// Order matters: telemetry is registered BEFORE the app is built, so the very
// first log line already carries a trace tag and the pool's spans are captured.
//
// env: COORDINATOR_PORT (default 5052), COORDINATOR_HOST (default 0.0.0.0),
//      LOG_LEVEL (default info), SERVICE_VERSION (stamped by the image build),
//      DATABASE_URL or PG* (see db/pool), PG_POOL_MAX (default 10),
//      PGSSLMODE disable|require|verify-full (+ PGSSLROOTCERT) — unset is
//      plaintext dev; production sets verify-full with the mounted CNPG CA,
//      OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT to ship spans.
//
// Transport security is the substrate's job: the Linkerd sidecar (mTLS +
// AuthorizationPolicy) fronts this port, and the Postgres hop is secured by
// CNPG's own TLS via PGSSLMODE.
// ============================================================================
import { buildApp } from './app.js';
import { createCoordinatorPool, describeTarget } from './db/pool.js';
import type { LogLevel } from './platform/logger.js';
import { startTelemetry } from './platform/telemetry.js';

const port = Number(process.env['COORDINATOR_PORT'] ?? '5052');
const host = process.env['COORDINATOR_HOST'] ?? '0.0.0.0';

const telemetry = startTelemetry();
const pool = createCoordinatorPool();
const app = buildApp({
  db: pool,
  dbTarget: describeTarget(),
  telemetry: telemetry.state,
  logLevel: (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info',
});

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'draining');
  void app
    .close()
    .then(() => pool.end())
    .then(() => telemetry.shutdown())
    .then(() => process.exit(0));
  // Hard stop if a connection wedges the drain. unref'd so it never holds the
  // process open on a clean shutdown.
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port, host });
