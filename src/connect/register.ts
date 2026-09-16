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
import { initEntitlementSigning } from '../entitlements/index.js';
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
   * on. Default true: a missing Secret should be visible at start rather than
   * discovered by a user whose numbers quietly vanished. The key loads lazily
   * on first mint either way, so turning this off changes only the boot line.
   */
  initSigning?: boolean;
}

export function registerConnect(app: FastifyInstance, options: ConnectOptions): void {
  if (options.initSigning !== false) initEntitlementSigning();

  const resolveIdentity = options.resolveIdentity ?? decoratorIdentityResolver();

  void app.register(fastifyConnectPlugin, {
    routes: createCompareRoutes(options),
    // §A.5 rule 3, inbound half: continue the caller's trace and be a span in
    // it, so every log line the handler writes carries the trace tag and the
    // outbound hop names this service as its parent.
    interceptors: [traceparentServerInterceptor()],
    contextValues: identityContextValues(resolveIdentity),
  });
}
