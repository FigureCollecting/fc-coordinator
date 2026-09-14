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
  telemetry?: TelemetryState;
  logLevel?: LogLevel;
  logSink?: LogSink;
  /** Omit to build a health-only app: the edge is not registered at all. */
  auth?: AuthPluginOptions;
}

/**
 * THE PUBLIC HEALTH BODY, and it is deliberately this small.
 *
 * /healthz is the entire public allowlist — kubelet and the image HEALTHCHECK
 * carry no credential, so it cannot be guarded. Everything it says, it says to
 * whoever can reach the port. It previously reported host:port/dbname, the
 * driver's error code and a probe latency; none of that is a caller's business
 * and the first is a map of the estate. The database target is logged ONCE at
 * startup instead, where an operator can still read it and a stranger cannot.
 *
 * Three keys, three states. A probe needs the status code; an operator needs to
 * know WHICH subsystem is unhappy. Neither needs anything else.
 */
export interface HealthBody {
  status: 'ok' | 'degraded';
  db: 'ok' | 'down';
  otel: 'registered' | 'missing';
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

  // THE PUBLIC ALLOWLIST, in full. The auth hook is deny-by-default, so this
  // is the only thing in the service that answers without credentials — and it
  // has to, because kubelet and the image HEALTHCHECK carry none.
  app.get('/healthz', { config: { auth: 'public' } }, async (_request, reply) => {
    const probe = await probeDatabase(options.db);

    const body: HealthBody = {
      status: probe.reachable ? 'ok' : 'degraded',
      db: probe.reachable ? 'ok' : 'down',
      otel: options.telemetry?.registered === true ? 'registered' : 'missing',
    };

    return reply.code(probe.reachable ? 200 : 503).send(body);
  });

  return app;
}
