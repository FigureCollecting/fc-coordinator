/**
 * A FAITHFUL PORT of the spine's live entitlement verifier, for tests only.
 *
 * PROVENANCE. This mirrors fc-aggregation `src/server/entitlement-assertion.ts`
 * (D6 U4, deployed) check for check, in the same ORDER, minus the parts that
 * belong to the server: the key directory, the counters, the rate-limited
 * logging and the Connect metadata entry point. It exists so fc-backend's mint
 * is proven against the algorithm that will actually judge it, rather than
 * against this repo's own idea of what it emits — a mint tested only against
 * its own assumptions is a mint that fails in production and reports success.
 *
 * KEEP IT DUMB AND DUPLICATED ON PURPOSE. It must never import from src/: the
 * moment it shares a constant or a helper with the minter, a bug in that shared
 * piece verifies itself. The only thing both sides may share is the CONTRACT
 * package, which is the declaration they are both compiled against.
 *
 * If the spine's verifier changes, change this copy in the same commit — the
 * contract package's constants are the seam that makes a silent drift loud
 * (a changed TTL or audience breaks this file's expectations immediately).
 */
import * as crypto from 'node:crypto';
import {
  ENTITLEMENT_ALG,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_CLOCK_SKEW_SECONDS,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_NAMES,
  ENTITLEMENT_TTL_SECONDS,
} from '@figurecollecting/ingest-contract/entitlement';

/** Every way an assertion can fail to produce grants. All of them are a NORMAL 200 at the spine. */
export type RejectReason =
  | 'absent'
  | 'oversized'
  | 'no_keys'
  | 'malformed'
  | 'unsupported_alg'
  | 'unsupported_crit'
  | 'unknown_kid'
  | 'bad_signature'
  | 'wrong_issuer'
  | 'wrong_audience'
  | 'no_subject'
  | 'bad_lifetime'
  | 'expired'
  | 'not_yet_valid';

export interface VerifyResult {
  grants: ReadonlySet<string>;
  outcome: 'granted' | RejectReason;
  unknownNames: number;
  sub?: string;
}

/** Matches the spine's ENTITLEMENT_MAX_HEADER_BYTES. */
export const MAX_HEADER_BYTES = 4096;

const RECOGNISED: ReadonlySet<string> = new Set<string>(ENTITLEMENT_NAMES);
const B64URL = /^[A-Za-z0-9_-]+$/;
const ED25519_SIGNATURE_BYTES = 64;
const NO_GRANTS: ReadonlySet<string> = new Set<string>();

const deny = (outcome: RejectReason): VerifyResult => ({ grants: NO_GRANTS, outcome, unknownNames: 0 });

const decodeSegment = (seg: string): Buffer | undefined =>
  B64URL.test(seg) ? Buffer.from(seg, 'base64url') : undefined;

const asObject = (buf: Buffer): Record<string, unknown> | undefined => {
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Verify one `fc-entitlements` header value against a kid -> public key map.
 * `keys` is what the spine builds from its mounted Secret; here the test builds
 * it from a throwaway keypair.
 */
export function verifyEntitlementHeader(
  raw: string | null | undefined,
  keys: ReadonlyMap<string, crypto.KeyObject>,
  nowMs: number = Date.now()
): VerifyResult {
  if (raw === null || raw === undefined || raw.trim() === '') return deny('absent');
  if (Buffer.byteLength(raw, 'utf8') > MAX_HEADER_BYTES) return deny('oversized');
  if (keys.size === 0) return deny('no_keys');

  const parts = raw.split('.');
  if (parts.length !== 3) return deny('malformed');
  const [h64, p64, s64] = parts as [string, string, string];
  const headerBuf = decodeSegment(h64);
  const payloadBuf = decodeSegment(p64);
  const sig = decodeSegment(s64);
  if (headerBuf === undefined || payloadBuf === undefined || sig === undefined) return deny('malformed');
  if (sig.length !== ED25519_SIGNATURE_BYTES) return deny('malformed');

  const joseHeader = asObject(headerBuf);
  if (joseHeader === undefined) return deny('malformed');
  const kid = joseHeader.kid;
  if (typeof kid !== 'string' || kid === '') return deny('malformed');
  if (joseHeader.alg !== ENTITLEMENT_ALG) return deny('unsupported_alg');
  if (joseHeader.crit !== undefined) return deny('unsupported_crit');

  const key = keys.get(kid);
  if (key === undefined) return deny('unknown_kid');
  let signatureOk = false;
  try {
    signatureOk = crypto.verify(null, Buffer.from(`${h64}.${p64}`), key, sig);
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) return deny('bad_signature');

  const claims = asObject(payloadBuf);
  if (claims === undefined) return deny('malformed');
  if (claims.iss !== ENTITLEMENT_ISSUER) return deny('wrong_issuer');
  if (claims.aud !== ENTITLEMENT_AUDIENCE) return deny('wrong_audience');
  const sub = claims.sub;
  if (typeof sub !== 'string' || sub.trim() === '') return deny('no_subject');

  const iat = claims.iat;
  const exp = claims.exp;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return deny('malformed');
  const iatS = iat as number;
  const expS = exp as number;
  if (expS <= iatS || expS - iatS > ENTITLEMENT_TTL_SECONDS) return deny('bad_lifetime');

  const nowS = Math.floor(nowMs / 1000);
  if (nowS > expS + ENTITLEMENT_CLOCK_SKEW_SECONDS) return deny('expired');
  if (nowS < iatS - ENTITLEMENT_CLOCK_SKEW_SECONDS) return deny('not_yet_valid');

  const ent = claims.ent;
  if (!Array.isArray(ent)) return deny('malformed');
  const grants = new Set<string>();
  let unknownNames = 0;
  for (const name of ent as unknown[]) {
    if (typeof name === 'string' && RECOGNISED.has(name)) grants.add(name);
    else unknownNames++;
  }
  return { grants, outcome: 'granted', unknownNames, sub };
}

/** A throwaway Ed25519 keypair. NEVER load real key material into a test. */
export function generateTestSigningKey(kid: string): {
  kid: string;
  privatePem: string;
  publicPem: string;
  keys: Map<string, crypto.KeyObject>;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { kid, privatePem, publicPem, keys: new Map([[kid, publicKey]]) };
}
