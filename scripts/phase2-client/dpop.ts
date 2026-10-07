// The client half of RFC 9449: an ES256 device key held in memory, and the proof that presents it.
// The coordinator's verifier (src/auth/dpop.ts) is the judge of every proof built here; the
// tests run each one through it.
//
// The private key is generated NON-EXTRACTABLE: it signs and nothing can read it back, so no code
// path in this client can print it. The public JWK travels in every proof header (that is how
// DPoP presents a key) and is never printed either.
import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';

export interface ClientKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  /** RFC 7638 thumbprint: what the coordinator binds a device to. */
  jkt: string;
  alg: 'ES256';
}

export interface ProofFields {
  htm: string;
  htu: string;
  accessToken: string;
  /** Omitted from the proof when undefined. */
  nonce?: string | undefined;
  /** A fresh uuid when undefined. B3 and B7 reuse one on purpose. */
  jti?: string | undefined;
}

export async function generateClientKey(): Promise<ClientKey> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: false });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk, jkt: await calculateJwkThumbprint(publicJwk, 'sha256'), alg: 'ES256' };
}

export async function signProof(key: ClientKey, fields: ProofFields): Promise<{ proof: string; jti: string }> {
  const jti = fields.jti ?? randomUUID();
  const claims: Record<string, unknown> = {
    htm: fields.htm,
    htu: fields.htu,
    jti,
    ath: createHash('sha256').update(fields.accessToken, 'ascii').digest('base64url'),
  };
  if (fields.nonce !== undefined) claims['nonce'] = fields.nonce;
  const proof = await new SignJWT(claims)
    .setProtectedHeader({ alg: key.alg, typ: 'dpop+jwt', jwk: key.publicJwk })
    .setIssuedAt()
    .sign(key.privateKey);
  return { proof, jti };
}

// The coordinator's nonce layout (src/auth/nonce.ts): epoch_id(16) || bucket(8, big-endian) ||
// mac(16), base64url. The epoch id is public by design: it is how B6 shows "same epoch" and B7
// sees the restart. The MAC is never read.
const EPOCH_BYTES = 16;
const BUCKET_BYTES = 8;
const NONCE_BYTES = 40;

export function nonceParts(nonce: string | undefined): { epoch: string; bucket: bigint } | undefined {
  if (nonce === undefined || nonce === '') return undefined;
  const raw = Buffer.from(nonce, 'base64url');
  if (raw.byteLength !== NONCE_BYTES || raw.toString('base64url') !== nonce) return undefined;
  return {
    epoch: raw.subarray(0, EPOCH_BYTES).toString('base64url'),
    bucket: raw.subarray(EPOCH_BYTES, EPOCH_BYTES + BUCKET_BYTES).readBigUInt64BE(),
  };
}

/** The `error` of a `WWW-Authenticate: DPoP ...` challenge, or undefined. */
export function challengeError(header: string | null | undefined): string | undefined {
  if (header === null || header === undefined || !/^DPoP\b/i.test(header)) return undefined;
  return /\berror="([a-z_]+)"/.exec(header)?.[1];
}
