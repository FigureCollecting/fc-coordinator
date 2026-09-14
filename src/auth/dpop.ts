// ============================================================================
// DPoP proof verification — RFC 9449, in the ORDER plan §A.4 makes binding.
//
//   1. the proof's signature against the EMBEDDED jwk
//   2. that the jwk's thumbprint matches the key bound to THIS token/device
//   3. htm and htu match the actual request
//   4. iat inside a short window
//   5. ath matches the presented access token
//   6. the nonce, INCLUDING its epoch
//   7. and only then, jti unseen
//
// The order is not cosmetic. Two properties depend on it:
//
//   * The BINDING is checked before anything about the request, so a proof
//     signed by a key this user has not enrolled (or has revoked) is rejected
//     as `key_not_bound` and never gets to say anything about the request.
//   * The NONCE is checked before the jti, so after a restart every carried
//     nonce fails its MAC and is rejected WITHOUT the (empty) replay cache ever
//     being consulted. That is the whole reason the empty cache is not a hole.
//
// Nothing is recorded in the replay window unless every earlier step passed, so
// a failed proof can never burn the jti a legitimate retry will reuse — which
// is exactly what the `use_dpop_nonce` retry does NOT rely on (it sends a fresh
// jti), but a client that gets it wrong is not punished silently.
//
// Standards only: jose does the JWS work. EmbeddedJWK is jose's RFC 9449 key
// resolver — it imports the header's `jwk` and REFUSES anything that is not a
// public key, which is the single most catastrophic mistake available here.
// The explicit private-parameter guard below runs first anyway: defence in
// depth against a future resolver change, and a clearer failure in the logs.
// ============================================================================
import { createHash, timingSafeEqual } from 'node:crypto';
import { EmbeddedJWK, calculateJwkThumbprint, decodeProtectedHeader, jwtVerify, type JWK } from 'jose';
import type { NonceEpoch } from './nonce.js';
import type { JtiWindow } from './replay.js';

/** JWK members that only ever appear in a PRIVATE key. None may reach us. */
const PRIVATE_JWK_PARAMS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'oth'] as const;

/** A jti is an identifier, not a payload: cap it so it cannot bloat the window. */
const MAX_JTI_LENGTH = 128;

export type DpopFailure =
  | 'missing_proof'
  | 'multiple_proofs'
  | 'malformed_proof'
  | 'unsupported_algorithm'
  | 'key_not_bound'
  | 'htm_mismatch'
  | 'htu_mismatch'
  | 'iat_out_of_window'
  | 'ath_mismatch'
  | 'nonce_missing'
  | 'nonce_invalid'
  | 'jti_replayed';

/** The RFC 9449 §7.1 error code echoed to the client. Never the reason. */
export type DpopErrorCode = 'invalid_dpop_proof' | 'use_dpop_nonce';

export type DpopOutcome =
  | { ok: true; jkt: string; jti: string; deviceId: string; jwk: JWK }
  | { ok: false; reason: DpopFailure; error: DpopErrorCode };

export type BindingOutcome = { bound: true; deviceId: string } | { bound: false };

export interface DpopVerifyInput {
  /** The DPoP header(s) exactly as received: one is required, more is an error. */
  proof: string | string[] | undefined;
  method: string;
  /** Request path as received; query and fragment are stripped before comparison. */
  path: string;
  /** The CONFIGURED public origin — never the Host header, which the caller controls. */
  origin: string;
  accessToken: string;
  /** Step 2. Owns cnf.jkt preference, the device table and revocation. */
  resolveBinding: (jkt: string) => Promise<BindingOutcome>;
  nonce: NonceEpoch;
  jti: JtiWindow;
  algorithms: string[];
  maxAgeSeconds: number;
  clockSkewSeconds: number;
  requireNonce: boolean;
  now?: () => number;
}

function fail(reason: DpopFailure): DpopOutcome {
  const error: DpopErrorCode =
    reason === 'nonce_missing' || reason === 'nonce_invalid' ? 'use_dpop_nonce' : 'invalid_dpop_proof';
  return { ok: false, reason, error };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/** Origin + path, with query and fragment removed from both sides (RFC 9449 §4.3). */
function normalizeHtu(value: unknown, origin: string, path: string): boolean {
  if (typeof value !== 'string') return false;
  let presented: URL;
  try {
    presented = new URL(value);
  } catch {
    return false;
  }
  const expectedPath = path.split('?')[0]!.split('#')[0]!;
  return `${presented.origin}${presented.pathname}` === `${origin}${expectedPath}`;
}

export async function verifyDpopProof(input: DpopVerifyInput): Promise<DpopOutcome> {
  const clock = input.now ?? Date.now;

  // ---- step 0: exactly one proof ------------------------------------------
  if (Array.isArray(input.proof)) {
    return fail(input.proof.length === 1 ? 'malformed_proof' : 'multiple_proofs');
  }
  if (input.proof === undefined || input.proof === '') return fail('missing_proof');

  // ---- step 1: the proof verifies against its own embedded key ------------
  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(input.proof);
  } catch {
    return fail('malformed_proof');
  }

  const jwk = header.jwk;
  if (typeof jwk !== 'object' || jwk === null || Array.isArray(jwk)) return fail('malformed_proof');
  for (const param of PRIVATE_JWK_PARAMS) {
    if (param in jwk) return fail('malformed_proof');
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(input.proof, EmbeddedJWK, {
      algorithms: input.algorithms,
      typ: 'dpop+jwt',
    }));
  } catch (error) {
    // The only step-1 failure worth naming separately: the client offered an
    // algorithm we do not accept, which is a configuration problem on its side,
    // not an attack. Every other shape — bad signature, wrong typ, not a JWS —
    // is one bucket: they are indistinguishable to the client anyway, which
    // sees only `invalid_dpop_proof`.
    return fail(
      (error as { code?: unknown }).code === 'ERR_JOSE_ALG_NOT_ALLOWED'
        ? 'unsupported_algorithm'
        : 'malformed_proof',
    );
  }

  const jti = payload['jti'];
  if (typeof jti !== 'string' || jti === '' || jti.length > MAX_JTI_LENGTH) {
    return fail('malformed_proof');
  }

  const jkt = await calculateJwkThumbprint(jwk as JWK, 'sha256');

  // ---- step 2: is THIS key bound to THIS token / device? ------------------
  const binding = await input.resolveBinding(jkt);
  if (!binding.bound) return fail('key_not_bound');

  // ---- step 3: the proof commits to this method and this URL --------------
  if (typeof payload['htm'] !== 'string' || payload['htm'].toUpperCase() !== input.method.toUpperCase()) {
    return fail('htm_mismatch');
  }
  if (!normalizeHtu(payload['htu'], input.origin, input.path)) return fail('htu_mismatch');

  // ---- step 4: the proof is recent ---------------------------------------
  const iat = payload['iat'];
  const nowSeconds = Math.floor(clock() / 1000);
  if (
    typeof iat !== 'number' ||
    !Number.isFinite(iat) ||
    iat < nowSeconds - input.maxAgeSeconds ||
    iat > nowSeconds + input.clockSkewSeconds
  ) {
    return fail('iat_out_of_window');
  }

  // ---- step 5: the proof is for THIS access token -------------------------
  const ath = payload['ath'];
  const expectedAth = createHash('sha256').update(input.accessToken, 'ascii').digest('base64url');
  if (typeof ath !== 'string' || !constantTimeEquals(ath, expectedAth)) return fail('ath_mismatch');

  // ---- step 6: the nonce, epoch included ----------------------------------
  const presentedNonce = payload['nonce'];
  if (presentedNonce === undefined) {
    if (input.requireNonce) return fail('nonce_missing');
  } else if (typeof presentedNonce !== 'string' || !input.nonce.verify(presentedNonce).ok) {
    // A volunteered nonce is validated even where the route does not demand
    // one: accepting a stale or forged value would teach clients to keep it.
    return fail('nonce_invalid');
  }

  // ---- step 7: and only now, has this proof been seen before? -------------
  if (input.jti.check(jti) === 'replay') return fail('jti_replayed');

  // The jwk is returned VERIFIED: enrolment stores the key the signature just
  // proved possession of, never one re-read from an unauthenticated body.
  return { ok: true, jkt, jti, deviceId: binding.deviceId, jwk: jwk as JWK };
}
