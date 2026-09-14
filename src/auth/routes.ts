// ============================================================================
// Device enrolment, revocation and session introspection.
//
// ENROLMENT is the bootstrap AND the revocation point (plan §A.4, "Identity").
// At first sign-in the client presents its public JWK inside a normal DPoP
// proof — the signature is the presentation, so the key is proven, never merely
// claimed in a request body. What is stored is the thumbprint plus the PUBLIC
// parameters, nothing else.
//
// REVOCATION sets `revoked_at`. It never deletes: a revoked key stays auditable
// and the partial unique index lets the same key be enrolled again later as a
// NEW row. Ending one device touches neither the user's credentials (which live
// in Authentik) nor any other device.
//
// NO ROUTE HERE ATTACHES A GUARD. Authentication happens in the global hook in
// plugin.ts, which is deny-by-default; a route only ever declares how it is
// WEAKENED. `/auth/devices` declares `enrolment` because its key cannot be in
// the device table yet. Everything else says nothing and is fully guarded.
//
// Input validation is written out rather than left to a JSON schema: these
// three routes take two scalars between them, and an explicit 400 is easier to
// read than a schema whose failure mode is a 500 on an absent body.
// ============================================================================
import type { FastifyInstance } from 'fastify';
import type { AuthRuntime } from './plugin.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL_LENGTH = 100;

export interface AuthRoutesOptions {
  runtime: AuthRuntime;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRoutesOptions): void {
  const { runtime } = options;

  app.post('/auth/devices', { config: { auth: 'enrolment' } }, async (request, reply) => {
    const caller = request.callerIdentity!;
    const proof = request.dpopProof!;

    const label = (request.body as { label?: unknown } | null | undefined)?.label;
    if (label !== undefined && (typeof label !== 'string' || label.length > MAX_LABEL_LENGTH)) {
      return reply.code(400).send({ error: 'invalid_label' });
    }

    const state = await runtime.devices.ensureAppUser(caller.sub);
    if (state === 'deleted') {
      request.log.warn({ auth_outcome: 'user_soft_deleted' }, 'refused enrolment');
      return reply.code(403).send({ error: 'account_closed' });
    }

    const device = await runtime.devices.enroll({
      userId: caller.sub,
      jkt: proof.jkt,
      jwk: proof.jwk as Record<string, unknown>,
      label: typeof label === 'string' ? label : undefined,
    });

    // A negative cache entry may exist for a key that was tried before it was
    // enrolled; drop it so the very next request with this key is bound.
    runtime.bindings.invalidate(caller.sub, device.jkt);

    // The one place deviceId goes from null to known.
    caller.deviceId = device.deviceId;

    return reply.code(device.created ? 201 : 200).send({
      deviceId: device.deviceId,
      jkt: device.jkt,
      enrolledAt: device.enrolledAt,
      created: device.created,
    });
  });

  app.post<{ Params: { deviceId: string } }>(
    '/auth/devices/:deviceId/revoke',
    async (request, reply) => {
      const caller = request.callerIdentity!;
      const { deviceId } = request.params;
      if (!UUID.test(deviceId)) return reply.code(400).send({ error: 'invalid_device_id' });

      const revoked = await runtime.devices.revoke({ userId: caller.sub, deviceId });
      if (revoked === undefined) {
        // Not this user's device, or no such device. The two are reported
        // identically on purpose: a 404 that distinguishes them is a device-id
        // oracle for any authenticated user.
        return reply.code(404).send({ error: 'device_not_found' });
      }

      runtime.bindings.invalidate(caller.sub, revoked.jkt);
      return reply.code(200).send({
        deviceId: revoked.deviceId,
        revokedAt: revoked.revokedAt,
        revoked: revoked.changed,
      });
    },
  );

  app.get('/auth/session', async (request) => {
    const caller = request.callerIdentity!;
    return { userId: caller.sub, deviceId: caller.deviceId, jkt: caller.jkt };
  });
}
