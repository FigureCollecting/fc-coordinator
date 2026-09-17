// ============================================================================
// Fastify 5 application factory.
//
// Routes: GET /healthz (the entire public allowlist), the OIDC + DPoP edge's
// enrolment routes, and the coordinator.v1 Connect surface.
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
// ALSO CLOSED IN SLICE 1b: the traceparent Connect INTERCEPTORS (§A.5 rule 3).
// src/connect/interceptors.ts carries both halves — the server one continues the
// caller's trace into the handler, the client one injects on the outbound
// SpineRead hop — so a single traceparent now threads fc-mobile, this service
// and the spine.
//
// AUTH is optional here on purpose. buildApp({ auth }) registers the OIDC +
// DPoP edge; omitting it yields the health-only app the slice-1a tests build,
// so an auth misconfiguration cannot take /healthz down with it.
// ============================================================================
import Fastify, { type FastifyInstance } from 'fastify';
import { validateRoutePrefix } from './auth/config.js';
import { registerAuth, type AuthPluginOptions } from './auth/plugin.js';
import { probeDatabase, type QueryableDb } from './db/pool.js';
import { registerHttpTracing } from './platform/http-trace.js';
import { createStructuredLogger, type LogLevel, type LogSink } from './platform/logger.js';
import type { TelemetryState } from './platform/telemetry.js';
import { registerConnect, type ConnectOptions } from './connect/register.js';

export const SERVICE_NAME = 'fc-coordinator';

export interface BuildAppOptions {
  db: QueryableDb;
  telemetry?: TelemetryState;
  logLevel?: LogLevel;
  logSink?: LogSink;
  /** Omit to build a health-only app: the edge is not registered at all. */
  auth?: AuthPluginOptions;
  /**
   * The coordinator.v1 Connect surface. Omitted, the app serves /healthz only —
   * which is what the migration Job and the unit tests for the health contract
   * want. See src/connect/register.ts.
   *
   * Compare declares no `config.auth`, so the edge's deny-by-default registry
   * classifies it `guarded` — the absence IS the protection, which is the whole
   * point of having no opt-in.
   *
   * ON ORDERING, stated precisely because the obvious claim is WRONG. The auth
   * plugin's rule is that routes must be registered after registerAuth, since
   * Fastify binds a route's hooks when the route is added. The Connect surface
   * turns out to be immune to that trap: registerConnect goes through
   * `app.register()`, which Fastify DEFERS until ready(), so its routes are
   * bound after the hook whichever order these two calls appear in. Measured,
   * not assumed — moving this call above registerAuth leaves all nine methods
   * still answering 401.
   *
   * It stays here anyway. Relying on deferral is relying on an implementation
   * detail of a third-party plugin, and a future switch to registering these
   * routes synchronously would lose the guard silently. The thing that actually
   * protects this is test/connect/guarded.test.ts, which asks the socket.
   */
  compare?: ConnectOptions;
  /**
   * Serve everything except /healthz under this path. `''` — the default HERE —
   * is the root, which is what every test that does not care about the edge
   * wants. The PROCESS default is `/api`: src/server.ts reads it through
   * resolveRoutePrefix, so the deployed shape comes from the env contract while
   * this factory stays a library with no hidden environment read.
   */
  routePrefix?: string;
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
  // Validated even when injected directly: a caller that hands in 'api' would
  // otherwise mount `apicoordinator.v1…` and answer 401 to everything with no
  // clue why.
  const routePrefix = validateRoutePrefix(options.routePrefix ?? '');

  const app = Fastify({
    loggerInstance: createStructuredLogger({
      name: SERVICE_NAME,
      ...(options.logLevel !== undefined ? { level: options.logLevel } : {}),
      ...(options.logSink !== undefined ? { sink: options.logSink } : {}),
    }),
  });

  registerHttpTracing(app, { ignorePaths: ['/healthz'] });
  if (options.auth !== undefined) registerAuth(app, { ...options.auth, routePrefix });

  // THE PUBLIC ALLOWLIST, in full. The auth hook is deny-by-default, so this
  // is the only thing in the service that answers without credentials — and it
  // has to, because kubelet and the image HEALTHCHECK carry none.
  //
  // UNPREFIXED, deliberately, and it is the ONE route that does not move. Only
  // kubelet and the image HEALTHCHECK reach it, both in-cluster and both by
  // literal path; the public tunnel routes the prefix and nothing else, so
  // leaving it at the root is what keeps the one unauthenticated route off the
  // public surface entirely. `${prefix}/healthz` is an unknown path and gets
  // the same 401 as anything else that matched no route.
  app.get('/healthz', { config: { auth: 'public' } }, async (_request, reply) => {
    const probe = await probeDatabase(options.db);

    const body: HealthBody = {
      status: probe.reachable ? 'ok' : 'degraded',
      db: probe.reachable ? 'ok' : 'down',
      otel: options.telemetry?.registered === true ? 'registered' : 'missing',
    };

    return reply.code(probe.reachable ? 200 : 503).send(body);
  });

  if (options.compare) registerConnect(app, { ...options.compare, routePrefix });

  return app;
}
