// ============================================================================
// Fastify 5 application factory.
//
// Slice 1a carries exactly one route: GET /healthz. OIDC, DPoP, the entitlement
// port and the Compare pass-through are slice 1b and plug in here.
//
// Everything the route needs is INJECTED (db, telemetry state, log sink) so the
// health contract can be tested — including its failure branch — without a
// database, a collector or a socket.
//
// CLOSED IN SLICE 1b (was N3): inbound HTTP IS instrumented now.
// registerHttpTracing adds the onRequest hook that opens a server span from the
// incoming `traceparent` and keeps it active for the rest of the lifecycle, so
// every log line from a running request carries `trace=<id> span=<id>`.
// /healthz is excluded: a liveness probe every second is noise, not a trace.
// Still open: the traceparent Connect INTERCEPTORS (§A.5 rule 3), which arrive
// with the first Connect hop.
//
// AUTH is optional here on purpose. buildApp({ auth }) registers the OIDC +
// DPoP edge; omitting it yields the health-only app the slice-1a tests build,
// so an auth misconfiguration cannot take /healthz down with it.
// ============================================================================
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuth, type AuthPluginOptions } from './auth/plugin.js';
import { probeDatabase, type QueryableDb } from './db/pool.js';
import { registerHttpTracing } from './platform/http-trace.js';
import { createStructuredLogger, type LogLevel, type LogSink } from './platform/logger.js';
import type { TelemetryState } from './platform/telemetry.js';

export const SERVICE_NAME = 'fc-coordinator';

export interface BuildAppOptions {
  db: QueryableDb;
  /** host:port/database, already stripped of credentials (db/pool describeTarget). */
  dbTarget?: string;
  telemetry?: TelemetryState;
  logLevel?: LogLevel;
  logSink?: LogSink;
  /** Omit to build a health-only app: the edge is not registered at all. */
  auth?: AuthPluginOptions;
}

export interface HealthBody {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  db: { reachable: boolean; latencyMs: number; target: string; code?: string };
  otel: { registered: boolean; exporter: string };
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    loggerInstance: createStructuredLogger({
      name: SERVICE_NAME,
      ...(options.logLevel !== undefined ? { level: options.logLevel } : {}),
      ...(options.logSink !== undefined ? { sink: options.logSink } : {}),
    }),
  });

  registerHttpTracing(app, { ignorePaths: ['/healthz'] });
  if (options.auth !== undefined) registerAuth(app, options.auth);

  app.get('/healthz', async (_request, reply) => {
    const probe = await probeDatabase(options.db);

    // Never a secret: the target is pre-stripped of userinfo and the database
    // error is reported as a CODE, never as the driver's message.
    const body: HealthBody = {
      status: probe.reachable ? 'ok' : 'degraded',
      service: SERVICE_NAME,
      version: process.env['SERVICE_VERSION'] ?? 'unknown',
      db: { ...probe, target: options.dbTarget ?? 'unknown' },
      otel: options.telemetry
        ? { registered: options.telemetry.registered, exporter: options.telemetry.exporter }
        : { registered: false, exporter: 'none' },
    };

    return reply.code(probe.reachable ? 200 : 503).send(body);
  });

  return app;
}
