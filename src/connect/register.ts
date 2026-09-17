// ============================================================================
// Mounting the Connect surface on Fastify.
//
// CONNECT-WEB OVER PLAIN HTTPS, NO PROXY (plan §A.2). The client hop speaks the
// Connect protocol over ordinary HTTP, so fc-mobile needs no gRPC-Web proxy and
// the coordinator needs no second listener — the same Fastify instance that
// serves /healthz serves coordinator.v1. The MESH hop is the other half and
// lives in src/spine/spineReadClient.ts, pinned to HTTP/1.1.
//
// ONE FILE SO app.ts STAYS SMALL. Everything the Connect surface needs —
// the plugin, the routes, the server-side traceparent interceptor and the
// identity bridge — is assembled here, and app.ts adds one optional field and
// one call.
// ============================================================================
import { fastifyConnectPlugin } from '@connectrpc/connect-fastify';
import type { FastifyInstance } from 'fastify';
import {
  initEntitlementSigning,
  initOpenFgaAuth,
  setEntitlementAuditSink,
} from '../entitlements/index.js';
import { createCompareRoutes, type CompareRoutesDeps } from './compare.js';
import {
  decoratorIdentityResolver,
  identityContextValues,
  type IdentityResolver,
} from './identity.js';
import { traceparentServerInterceptor } from './interceptors.js';

export interface ConnectOptions extends CompareRoutesDeps {
  /**
   * How the caller's Authentik uuid is established. Defaults to reading the
   * decorator the OIDC + DPoP plugin sets; tests inject a fake. See
   * ./identity.ts for why this is a seam and not a lookup.
   */
  resolveIdentity?: IdentityResolver;
  /**
   * Load the entitlement signing key at registration and log whether minting is
   * on, and name which OpenFGA credential path is configured. Default true: a
   * missing Secret should be visible at start rather than discovered by a user
   * whose numbers quietly vanished. The key loads lazily on first mint either
   * way, and the token is minted on first Check, so turning this off changes
   * only the boot lines.
   *
   * BOTH LINES, because they answer one question between them — can this
   * process ask the authorization question, and can it sign the answer? A
   * ten-minute OpenFGA token that was never configured fails exactly the way a
   * missing signing key does: a normal 200 with the magnitudes gone.
   */
  initSigning?: boolean;
  /**
   * Mount the Connect surface under this path, so it is served NATIVELY at the
   * public URL and the edge rewrites nothing. See src/auth/config.ts for why
   * that is a requirement and not a preference.
   *
   * VERIFIED AGAINST THE PLUGIN'S SOURCE, because the obvious worry is real for
   * other plugins: `fastifyConnectPlugin` is a plain plugin function, NOT
   * wrapped in `fastify-plugin`, so `app.register` gives it an encapsulated
   * context and Fastify applies the prefix to the `instance.all(requestPath)`
   * calls it makes. Its own `addNoopContentTypeParsers` stays scoped to that
   * context, which its comment already relies on, and the handler still writes
   * through `reply.raw` — so `onSend` hooks still do not run on Connect
   * responses and `onRequest` hooks, which is what the auth guard and the trace
   * hook use, still do. A prefix changes none of that.
   */
  routePrefix?: string;
}

export function registerConnect(app: FastifyInstance, options: ConnectOptions): void {
  // THE HOST'S HALF OF THE AUDIT SEAM. The portable module cannot import this
  // app's logger and stay portable, so it exposes a sink and falls back to the
  // console; here is where it stops being a fallback. `app.log` is the same
  // logger every other line goes through, so the decision arrives tagged with
  // the trace of the request it belonged to — which is the difference between a
  // record and a pile of lines.
  //
  // INFO, not debug: this is an audit trail, and one that a log level can turn
  // off in production is not one. And the LOG, never a span: the subject is on
  // this line deliberately and must never reach the collector. See the seam's
  // comment in src/entitlements/grants.ts.
  setEntitlementAuditSink((event) => {
    app.log.info(event, 'entitlement decision');
  });

  if (options.initSigning !== false) {
    initEntitlementSigning();
    initOpenFgaAuth();
  }

  const resolveIdentity = options.resolveIdentity ?? decoratorIdentityResolver();

  void app.register(fastifyConnectPlugin, {
    // `prefix` is read by Fastify's register, not by the plugin, which ignores
    // the extra key. An empty string means no prefix.
    prefix: options.routePrefix ?? '',
    routes: createCompareRoutes(options),
    // §A.5 rule 3, inbound half: continue the caller's trace and be a span in
    // it, so every log line the handler writes carries the trace tag and the
    // outbound hop names this service as its parent.
    interceptors: [traceparentServerInterceptor()],
    contextValues: identityContextValues(resolveIdentity),
  });
}
