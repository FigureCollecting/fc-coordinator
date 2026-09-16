// ============================================================================
// Carrying the authenticated caller from Fastify into the Connect handler.
//
// THE DECLARATION ITSELF LIVES IN src/identity.ts, not here. This module used to
// own `CALLER_IDENTITY_DECORATOR` and `CallerIdentity`, and the OIDC + DPoP edge
// owned its own copies on its branch. Two literals for one property name, with
// a silent and safe-looking failure if they ever disagreed: the resolver finds
// nothing, every caller reads as unauthenticated, every Compare comes back
// redacted, and both unit suites stay green because each side tests through its
// own fake. The shared declaration removed that possibility, so the constant and
// the interface are imported from there and re-exported for this module's
// callers rather than restated.
//
// WHAT REMAINS HERE is the part that is genuinely this side's: turning a Fastify
// request into a Connect handler-context value, and the INJECTION SEAM that lets
// a test supply an identity without standing up the edge.
//
// AUTHENTICATION IS NOT DECIDED HERE. The edge's onRequest hook is
// deny-by-default and has already rejected anyone it does not trust by the time
// a handler runs. If the decorator is somehow absent, the resolver returns null
// and null means NO ENTITLEMENT — a successful, redacted Compare, not a
// rejection. Two layers deciding one rule is how you get an answer that depends
// on which ran first.
// ============================================================================
import { createContextKey, createContextValues, type ContextValues } from '@connectrpc/connect';
import type { FastifyRequest } from 'fastify';
import { CALLER_IDENTITY_DECORATOR, type CallerIdentity } from '../identity.js';

export { CALLER_IDENTITY_DECORATOR, type CallerIdentity };

export type IdentityResolver = (request: FastifyRequest) => CallerIdentity | null;

/**
 * The caller's subject, carried from the Fastify request into the Connect
 * handler context. `null` is the default and means "nobody is authenticated",
 * which is a legitimate, redacted outcome rather than an error.
 */
export const kCallerSubject = createContextKey<string | null>(null, {
  description: 'fc-coordinator: the authenticated caller Authentik uuid, or null',
});

/**
 * The production resolver: read what the edge decorated, and be strict about
 * its shape.
 *
 * STRICT EVEN THOUGH THE EDGE IS TYPED. `request.callerIdentity` is
 * `AuthenticatedCaller | null` in the type system, but this runs behind a hook
 * on a different module's schedule, and a half-formed identity must not become a
 * half-formed SUBJECT downstream. The entitlement module would refuse it either
 * way — but it would refuse it as `bad_subject`, "someone sent us the wrong kind
 * of id", when the truth is "nobody is logged in". Those are different
 * operational facts and an operator chasing missing numbers needs the right one.
 *
 * IT DOES NOT JUDGE THE UUID. `{ sub: 'ross' }` passes through untouched; the
 * Authentik-uuid rule is enforced in src/entitlements/subject.ts, at the
 * boundary that actually talks to OpenFGA. A second copy of that regex is a
 * second copy to drift.
 */
export function decoratorIdentityResolver(
  property: string = CALLER_IDENTITY_DECORATOR,
): IdentityResolver {
  return (request) => {
    const decorated = (request as unknown as Record<string, unknown>)[property];
    if (typeof decorated !== 'object' || decorated === null) return null;
    const sub = (decorated as { sub?: unknown }).sub;
    if (typeof sub !== 'string' || sub.trim() === '') return null;
    // Only `sub`. The edge also hangs deviceId and jkt off the same property;
    // they are its business, not the entitlement path's, and copying them here
    // would be the start of a second identity model.
    return { sub };
  };
}

/**
 * Bridge one resolver into the `contextValues` hook connect-fastify calls per
 * request. This is the only place the Fastify request and the Connect handler
 * context touch, which keeps the handler testable without a socket.
 */
export function identityContextValues(
  resolve: IdentityResolver,
): (request: FastifyRequest) => ContextValues {
  return (request) => createContextValues().set(kCallerSubject, resolve(request)?.sub ?? null);
}
