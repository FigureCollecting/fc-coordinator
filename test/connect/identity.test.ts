/**
 * The identity seam.
 *
 * WHY IT IS A SEAM AND NOT A LOOKUP. The Compare handler needs one thing from
 * authentication: the Authentik uuid of the caller. Everything about HOW that
 * uuid is established — an OIDC token, a DPoP proof, a nonce epoch — belongs to
 * the edge plugin and is built on its own branch. A handler that reached into
 * the token would couple the two, and the entitlement module that ports between
 * hosts would be back to knowing about its host.
 *
 * So the handler takes a RESOLVER. In production it reads the decorator the
 * auth plugin sets on the Fastify request; in tests it is a one-line fake. The
 * two branches meet at one constant and one shape, and nowhere else.
 *
 * AUTHENTICATION IS NOT THIS MODULE'S JOB. A resolver that finds nothing
 * returns null, and null means "no entitlement" — a successful, redacted
 * response. REJECTING an unauthenticated caller is the plugin's decision,
 * upstream of here; if this module also rejected, two layers would own one
 * rule and the answer would depend on which ran first.
 */
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import {
  CALLER_IDENTITY_DECORATOR,
  decoratorIdentityResolver,
} from '../../src/connect/identity.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';

/** Just enough of a FastifyRequest to carry a decorator. */
const requestWith = (props: Record<string, unknown>): FastifyRequest =>
  props as unknown as FastifyRequest;

describe('decoratorIdentityResolver', () => {
  it('reads the subject from the decorator the auth plugin sets', () => {
    const resolve = decoratorIdentityResolver();
    expect(resolve(requestWith({ [CALLER_IDENTITY_DECORATOR]: { sub: SUB } }))).toEqual({
      sub: SUB,
    });
  });

  it('names the decorator as a constant, so the auth branch and this one agree in one place', () => {
    expect(CALLER_IDENTITY_DECORATOR).toBe('callerIdentity');
  });

  it('returns null when nothing has been decorated — the request is simply unauthenticated', () => {
    expect(decoratorIdentityResolver()(requestWith({}))).toBeNull();
  });

  it.each([
    ['null', null],
    ['a bare string', SUB],
    ['an object with no sub', { id: SUB }],
    ['a non-string sub', { sub: 12345 }],
    ['an empty sub', { sub: '' }],
    ['a blank sub', { sub: '   ' }],
  ])('returns null for %s rather than passing the shape along', (_label, decorated) => {
    // A malformed identity must not become a malformed subject downstream: the
    // entitlement module would refuse it anyway, but it would refuse it as a
    // `bad_subject` counter rather than as "nobody is logged in", and those are
    // different operational facts.
    expect(decoratorIdentityResolver()(requestWith({ [CALLER_IDENTITY_DECORATOR]: decorated })))
      .toBeNull();
  });

  it('does not itself judge whether the subject is an Authentik uuid', () => {
    // That rule lives in src/entitlements/subject.ts and is enforced there, at
    // the boundary that actually talks to OpenFGA. Duplicating it here would be
    // a second copy to drift.
    expect(
      decoratorIdentityResolver()(requestWith({ [CALLER_IDENTITY_DECORATOR]: { sub: 'ross' } })),
    ).toEqual({ sub: 'ross' });
  });

  it('can be pointed at a different decorator name without touching the handler', () => {
    const resolve = decoratorIdentityResolver('auth');
    expect(resolve(requestWith({ auth: { sub: SUB } }))).toEqual({ sub: SUB });
    expect(resolve(requestWith({ [CALLER_IDENTITY_DECORATOR]: { sub: SUB } }))).toBeNull();
  });

  it('trims nothing and folds nothing — the subject reaches OpenFGA verbatim', () => {
    // OpenFGA compares subjects byte for byte, so an identity layer that
    // normalised case would turn two people into one.
    const upper = SUB.toUpperCase();
    expect(
      decoratorIdentityResolver()(requestWith({ [CALLER_IDENTITY_DECORATOR]: { sub: upper } })),
    ).toEqual({ sub: upper });
  });
});
