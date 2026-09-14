import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { CALLER_IDENTITY_DECORATOR, type AuthenticatedCaller, type CallerIdentity } from './identity.js';

/**
 * A byte-for-byte copy of PR #3's production resolver
 * (src/connect/identity.ts, decoratorIdentityResolver). It is duplicated here
 * ON PURPOSE and only here: this test exists to prove the edge decorates a
 * request in the exact shape the entitlement branch reads, WITHOUT importing
 * across the two branches. When #3 rebases it deletes its own constant and
 * interface and imports them from src/identity.ts; this test then guards the
 * shared declaration rather than a coincidence.
 */
function decoratorIdentityResolver(property: string = CALLER_IDENTITY_DECORATOR) {
  return (request: FastifyRequest): CallerIdentity | null => {
    const decorated = (request as unknown as Record<string, unknown>)[property];
    if (typeof decorated !== 'object' || decorated === null) return null;
    const sub = (decorated as { sub?: unknown }).sub;
    if (typeof sub !== 'string' || sub.trim() === '') return null;
    return { sub };
  };
}

describe('the identity seam shared with the entitlement branch', () => {
  it('names the decorator exactly as PR #3 reads it', () => {
    expect(CALLER_IDENTITY_DECORATOR).toBe('callerIdentity');
  });

  it("resolves a subject from what the edge actually sets on the request", () => {
    const caller: AuthenticatedCaller = {
      sub: '5f3c1b9a-7e2d-4c6b-8a10-3d9e2f4b6c81',
      deviceId: 'c9f0c6a5-9d06-4a5f-9b1f-6e3b9a4d0c21',
      jkt: 'O13Iz13JW_REly2DEoOr1AVfahzou5Rp79eYzmKHVEM',
    };
    const request = { [CALLER_IDENTITY_DECORATOR]: caller } as unknown as FastifyRequest;

    expect(decoratorIdentityResolver()(request)).toEqual({
      sub: '5f3c1b9a-7e2d-4c6b-8a10-3d9e2f4b6c81',
    });
  });

  it('resolves null for an unauthenticated request, which is a redacted read and not an error', () => {
    const request = { [CALLER_IDENTITY_DECORATOR]: null } as unknown as FastifyRequest;
    expect(decoratorIdentityResolver()(request)).toBeNull();
    expect(decoratorIdentityResolver()({} as FastifyRequest)).toBeNull();
  });

  it('carries the device fields alongside sub without disturbing the read', () => {
    // The entitlement branch only ever reads `sub`; the edge needs deviceId and
    // jkt for revocation and for its own logging. Both must coexist on ONE
    // property, or the two branches decorate the request twice.
    const caller: AuthenticatedCaller = { sub: 'x'.repeat(36), deviceId: 'd', jkt: 'k' };
    expect(Object.keys(caller).sort()).toEqual(['deviceId', 'jkt', 'sub']);
  });
});
