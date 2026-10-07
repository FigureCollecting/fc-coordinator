// WK-11 skeleton: the behaviour lands in the next commit.
import type { CryptoKey, JWK } from 'jose';
export interface ClientKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  jkt: string;
  alg: 'ES256';
}
export interface ProofFields {
  htm: string;
  htu: string;
  accessToken: string;
  nonce?: string | undefined;
  jti?: string | undefined;
}
export async function generateClientKey(): Promise<ClientKey> {
  throw new Error('not implemented: WK-11');
}
export async function signProof(_key: ClientKey, _fields: ProofFields): Promise<{ proof: string; jti: string }> {
  throw new Error('not implemented: WK-11');
}
export function nonceParts(_nonce: string | undefined): { epoch: string; bucket: bigint } | undefined {
  throw new Error('not implemented: WK-11');
}
export function challengeError(_header: string | null | undefined): string | undefined {
  throw new Error('not implemented: WK-11');
}
