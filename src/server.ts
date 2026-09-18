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
//      OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT to ship spans,
//      OIDC_ISSUER / OIDC_AUDIENCE / OIDC_JWKS_URI / COORDINATOR_PUBLIC_ORIGIN
//      (all REQUIRED, no defaults — see auth/config.ts for why) plus the
//      optional DPOP_* and DEVICE_CACHE_TTL_SECONDS tuning knobs,
//      IDP_PUBLIC_HOST, REQUIRED only when an IdP URL names the in-cluster
//      Authentik mirror: it is the public authority every such request
//      presents, because Authentik derives the token issuer from the request
//      (entitlements/idpEndpoint.ts). OIDC_ISSUER does NOT change with it,
//      COORDINATOR_ROUTE_PREFIX (default /api — everything except /healthz is
//      served under it, and the edge must NOT rewrite it away),
//      SPINE_READ_URL (+ SPINE_READ_TIMEOUT_MS) for the mesh hop, OPENFGA_* for
//      the entitlement Check and ENTITLEMENT_SIGNING_* for the mint — each of
//      which, left unset, degrades to a redacted read rather than an outage.
//
// Transport security is the substrate's job: the Linkerd sidecar (mTLS +
// AuthorizationPolicy) fronts this port, and the Postgres hop is secured by
// CNPG's own TLS via PGSSLMODE.
// ============================================================================
import { buildApp } from './app.js';
import { resolveAuthConfig, resolveRoutePrefix } from './auth/config.js';
import { createAccessTokenVerifier, createJwksFor } from './auth/oidc.js';
import { createDeviceStore } from './auth/plugin.js';
import { createCoordinatorPool, describeTarget } from './db/pool.js';
import type { LogLevel } from './platform/logger.js';
import { startTelemetry } from './platform/telemetry.js';
import { createSpineReadClientFromEnv } from './spine/spineReadClient.js';

const port = Number(process.env['COORDINATOR_PORT'] ?? '5052');
const host = process.env['COORDINATOR_HOST'] ?? '0.0.0.0';

const telemetry = startTelemetry();
const pool = createCoordinatorPool();

// Resolved BEFORE listen: a missing or malformed setting must stop the process
// here, not surface as a 401 storm once traffic arrives.
const authConfig = resolveAuthConfig();
// Defaults to `/api`, the shape the public edge forwards. Resolved here rather
// than inside buildApp so the factory stays free of environment reads.
const routePrefix = resolveRoutePrefix();

const app = buildApp({
  db: pool,
  telemetry: telemetry.state,
  logLevel: (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info',
  routePrefix,
  auth: {
    config: authConfig,
    devices: createDeviceStore(pool),
    verifyAccessToken: createAccessTokenVerifier({
      // ONE CALL, AND IT IS TESTED WHERE IT LIVES. The URL and the headers it
      // must be fetched with travel together in `jwksPath`, so this file
      // cannot reassemble them wrongly — which it previously could, invisibly,
      // because this file is outside the coverage gate.
      jwks: createJwksFor(authConfig.jwksPath),
      issuer: authConfig.issuer,
      audience: authConfig.audience,
      algorithms: authConfig.oidcAlgorithms,
    }),
  },
  // The coordinator.v1 Connect surface. `spineRead` is null when SPINE_READ_URL
  // is unset — the degraded-mode seam: Compare then answers UNAVAILABLE rather
  // than constructing a transport to nowhere, and /healthz is unaffected.
  //
  // No `resolveIdentity`: the default reads the decorator the edge above sets,
  // which is the whole point of the shared declaration in src/identity.ts. The
  // subject a caller is entitled AS is therefore the subject the DPoP proof was
  // verified for, and there is no path by which a client can name its own.
  compare: { spineRead: createSpineReadClientFromEnv() },
});

// /healthz no longer reports the database target: it is the one unauthenticated
// route, and host:port/dbname is a map of the estate. Operators still get it,
// once, here — the log is behind the same boundary as the process itself.
app.log.info(
  {
    db_target: describeTarget(),
    otel_exporter: telemetry.state.exporter,
    // The public shape, stated once: origin + prefix is exactly what a client's
    // DPoP `htu` must name, so an operator can compare it against the edge.
    public_base: `${authConfig.origin}${routePrefix}`,
    // WHICH WIRE the JWKS fetch travels, and what authority it presents on it.
    // The credential's own path is logged by initOpenFgaAuth; this is the
    // edge's half, and the two can legitimately differ during a migration.
    idp: authConfig.jwksPath.description,
  },
  'coordinator starting',
);

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
