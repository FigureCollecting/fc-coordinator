// ============================================================================
// Fastify 5 application factory.
//
// Slice 1a carries exactly one route: GET /healthz. OIDC, DPoP, the entitlement
// port and the Compare pass-through are slice 1b and plug in here.
//
// Everything the route needs is INJECTED (db, telemetry state, log sink) so the
// health contract can be tested — including its failure branch — without a
// database, a collector or a socket.
// ============================================================================
import Fastify, { type FastifyInstance } from 'fastify';
import { probeDatabase, type QueryableDb } from './db/pool.js';
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
