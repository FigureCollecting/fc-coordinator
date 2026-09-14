// ============================================================================
// The DPoP edge, wired onto Fastify (plan §A.4, §C slice 1 items 4-5).
//
// Deliberately NOT a Fastify plugin in the encapsulated sense: it is a plain
// function called on the ROOT instance, so `app.dpopGuard` is visible to every
// route registered anywhere — including the Connect routes that land beside it
// — without pulling in fastify-plugin. Register it once in buildApp; attach the
// guard per route with `{ preHandler: app.dpopGuard }`.
//
// EVERY GUARDED RESPONSE CARRIES A FRESH `DPoP-Nonce`, success or failure. That
// is what lets a steady client never see a 401: it refreshes the nonce from
// every response, so a bucket roll is invisible to it. The header is set first
// thing, before any check can fail, precisely so the 401 that ASKS for a nonce
// is also the one that SUPPLIES it.
//
// WHAT IS NEVER LOGGED OR PUT ON A SPAN: the proof, the nonce, the access
// token, and `sub`. The outcome REASON is logged, because an operator needs to
// tell a clock-skew problem from an attack, and a reason names no secret.
// ============================================================================
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { verifyDpopProof, type BindingOutcome, type DpopOutcome } from './dpop.js';
import { createBindingResolver, type BindingResolver } from './binding.js';
import { createNonceEpoch, type NonceEpoch } from './nonce.js';
import { createJtiWindow, type JtiWindow } from './replay.js';
import { registerAuthRoutes } from './routes.js';
import type { AuthConfig } from './config.js';
import type { AccessTokenVerifier, VerifiedAccessToken } from './oidc.js';
import {
  ensureAppUser,
  enrollDevice,
  findLiveDevice,
  revokeDevice,
  type AppUserState,
  type EnrolDeviceInput,
  type EnrolledDevice,
  type LiveDevice,
  type RevokedDevice,
  type SqlClient,
} from '../db/devices.js';

/** The verified caller. Set by the guard; never assembled from request input. */
export interface CoordinatorIdentity {
  /** The Authentik uuid. Put it in no log line and on no span. */
  userId: string;
  deviceId: string;
  jkt: string;
}

/** The device table as a PORT, so the edge is testable without a container. */
export interface DeviceStore {
  ensureAppUser(userId: string): Promise<AppUserState>;
  findLiveDevice(userId: string, jkt: string): Promise<LiveDevice | undefined>;
  enroll(input: EnrolDeviceInput): Promise<EnrolledDevice>;
  revoke(input: { userId: string; deviceId: string }): Promise<RevokedDevice | undefined>;
}

export function createDeviceStore(db: SqlClient): DeviceStore {
  return {
    ensureAppUser: (userId) => ensureAppUser(db, userId),
    findLiveDevice: (userId, jkt) => findLiveDevice(db, userId, jkt),
    enroll: (input) => enrollDevice(db, input),
    revoke: (input) => revokeDevice(db, input),
  };
}

export interface AuthPluginOptions {
  config: AuthConfig;
  devices: DeviceStore;
  /** Injected so tests need no Authentik and no network. */
  verifyAccessToken: AccessTokenVerifier;
}

/** Handles the edge holds. Exposed so tests can assert the state budget. */
export interface AuthRuntime {
  nonce: NonceEpoch;
  jtiWindow: JtiWindow;
  bindings: BindingResolver;
  config: AuthConfig;
  devices: DeviceStore;
  verifyAccessToken: AccessTokenVerifier;
}

declare module 'fastify' {
  interface FastifyRequest {
    identity: CoordinatorIdentity | null;
  }
  interface FastifyInstance {
    /** Full chain: OIDC, then the seven DPoP steps against an ENROLLED device. */
    dpopGuard: preHandlerHookHandler;
    auth: AuthRuntime;
  }
}

/** The binding the ENROLMENT route uses: the presented key vouches for itself. */
const SELF_ASSERTED = 'self-asserted';

function challenge(
  reply: FastifyReply,
  error: 'invalid_token' | 'invalid_dpop_proof' | 'use_dpop_nonce',
  description: string,
  algorithms: string[],
): FastifyReply {
  // RFC 9449 §7.1. `error_description` is a FIXED string per outcome: it must
  // never echo anything the caller sent, and never name which check failed in
  // more detail than the client needs to act.
  reply.header(
    'WWW-Authenticate',
    `DPoP error="${error}", error_description="${description}", algs="${algorithms.join(' ')}"`,
  );
  return reply.code(401).send({ error });
}

const DESCRIPTIONS = {
  invalid_token: 'The access token is missing, malformed or not accepted',
  invalid_dpop_proof: 'The DPoP proof is missing, malformed or not bound to this request',
  use_dpop_nonce: 'Authorization server requires nonce in DPoP proof',
} as const;

export function registerAuth(app: FastifyInstance, options: AuthPluginOptions): AuthRuntime {
  const { config } = options;

  const runtime: AuthRuntime = {
    // No clock is injected HERE on purpose: every time-dependent rule lives in
    // nonce.ts, replay.ts and binding.ts, each of which takes its own `now` and
    // is tested against it directly. A second injection point at this level
    // would be four more branches that only the tests ever take.
    nonce: createNonceEpoch({ periodMs: config.noncePeriodMs }),
    jtiWindow: createJtiWindow({ ttlMs: config.jtiTtlMs, maxEntries: config.jtiMaxEntries }),
    bindings: createBindingResolver({
      findLiveDevice: (userId, jkt) => options.devices.findLiveDevice(userId, jkt),
      ttlMs: config.deviceCacheTtlMs,
      maxEntries: config.jtiMaxEntries,
    }),
    config,
    devices: options.devices,
    verifyAccessToken: options.verifyAccessToken,
  };

  app.decorateRequest('identity', null);
  app.decorate('auth', runtime);

  /**
   * Steps shared by the guard and by enrolment. Returns the verified subject
   * and the proof outcome, or a reply that has already been sent.
   */
  const authenticate = async (
    request: FastifyRequest,
    reply: FastifyReply,
    resolveBinding: (token: VerifiedAccessToken) => (jkt: string) => Promise<BindingOutcome>,
  ): Promise<{ userId: string; proof: DpopOutcome & { ok: true } } | undefined> => {
    // FIRST, unconditionally: the client must be able to learn a nonce from any
    // response, including the one that rejects it for not having one.
    reply.header('DPoP-Nonce', runtime.nonce.mint());

    const header = request.headers.authorization;
    const space = header?.indexOf(' ') ?? -1;
    const scheme = space > 0 ? header!.slice(0, space) : '';
    const accessToken = space > 0 ? header!.slice(space + 1).trim() : '';
    if (scheme.toLowerCase() !== 'dpop' || accessToken === '') {
      request.log.warn({ auth_outcome: 'scheme_not_dpop' }, 'rejected request');
      challenge(reply, 'invalid_token', DESCRIPTIONS.invalid_token, config.dpopAlgorithms);
      return undefined;
    }

    const verified = await runtime.verifyAccessToken(accessToken);
    if (!verified.ok) {
      request.log.warn({ auth_outcome: verified.reason }, 'rejected access token');
      challenge(reply, 'invalid_token', DESCRIPTIONS.invalid_token, config.dpopAlgorithms);
      return undefined;
    }

    const outcome = await verifyDpopProof({
      proof: request.headers['dpop'],
      method: request.method,
      path: request.url,
      origin: config.origin,
      accessToken,
      resolveBinding: resolveBinding(verified.token),
      nonce: runtime.nonce,
      jti: runtime.jtiWindow,
      algorithms: config.dpopAlgorithms,
      maxAgeSeconds: config.proofMaxAgeSeconds,
      clockSkewSeconds: config.clockSkewSeconds,
      requireNonce: config.requireNonce,
    });

    if (!outcome.ok) {
      request.log.warn({ auth_outcome: outcome.reason }, 'rejected dpop proof');
      challenge(reply, outcome.error, DESCRIPTIONS[outcome.error], config.dpopAlgorithms);
      return undefined;
    }

    return { userId: verified.token.sub, proof: outcome };
  };

  const dpopGuard: preHandlerHookHandler = async (request, reply) => {
    // cnf.jkt is PREFERRED when a future Authentik issues it, and ignored
    // (path B) when it is absent — binding.ts owns that choice.
    const result = await authenticate(request, reply, (token) =>
      runtime.bindings.for(token.sub, token.cnfJkt),
    );
    if (result === undefined) return reply;

    request.identity = {
      userId: result.userId,
      deviceId: result.proof.deviceId,
      jkt: result.proof.jkt,
    };
    return undefined;
  };

  app.decorate('dpopGuard', dpopGuard);

  registerAuthRoutes(app, {
    runtime,
    dpopGuard,
    /**
     * Enrolment is the bootstrap: the key being enrolled is not in the device
     * table yet, so it vouches for itself. Everything else in the chain still
     * applies — signature, htm/htu, iat, ath, nonce and jti — so a leaked
     * access token alone cannot enrol a key without a live proof.
     */
    enrolmentAuthenticate: (request, reply) =>
      authenticate(request, reply, () => async () => ({ bound: true, deviceId: SELF_ASSERTED })),
  });

  return runtime;
}

export { DESCRIPTIONS as AUTH_CHALLENGE_DESCRIPTIONS, challenge };
