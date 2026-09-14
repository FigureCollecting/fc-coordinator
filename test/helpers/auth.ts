// ============================================================================
// Test-only DPoP / OIDC fixtures.
//
// Lives under test/ deliberately: vitest measures coverage over src/** only, so
// a helper here cannot inflate (or be dragged down by) the per-file gate.
//
// There is no Authentik OIDC provider yet (decision D5 runs in parallel), so
// every test mints its own issuer: a freshly generated signing key, a JWKS
// served either directly to a resolver or over loopback HTTP by a real Fastify
// instance. Nothing here is imported by production code.
// ============================================================================
import { createHash, randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type CryptoKey,
  type JSONWebKeySet,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';

export const TEST_ISSUER = 'https://auth.test.invalid/application/o/fc-coordinator/';
export const TEST_AUDIENCE = 'fc-coordinator';
export const TEST_ORIGIN = 'https://api.test.invalid';

/** A device key pair: the private half signs proofs, the public half is enrolled. */
export interface DeviceKey {
  privateKey: CryptoKey;
  publicJwk: JWK;
  jkt: string;
  alg: string;
}

export async function makeDeviceKey(alg = 'ES256'): Promise<DeviceKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk, jkt: await calculateJwkThumbprint(publicJwk, 'sha256'), alg };
}

export interface ProofFields {
  htm: string;
  htu: string;
  accessToken?: string;
  /** Pass null to omit `ath` entirely. */
  ath?: string | null;
  nonce?: string;
  jti?: string;
  iat?: number;
  typ?: string;
  /** Extra/replacement protected-header members (e.g. a hand-built jwk). */
  header?: Record<string, unknown>;
  /** Drop the embedded `jwk` entirely — a proof with nothing to verify against. */
  omitJwk?: boolean;
}

/** base64url(SHA-256(access token)) — RFC 9449 `ath`. */
export function accessTokenHash(token: string): string {
  return createHash('sha256').update(token, 'ascii').digest('base64url');
}

export async function makeProof(key: DeviceKey, fields: ProofFields): Promise<string> {
  const claims: Record<string, unknown> = {
    htm: fields.htm,
    htu: fields.htu,
    jti: fields.jti ?? randomUUID(),
  };
  if (fields.ath !== null) {
    const ath = fields.ath ?? (fields.accessToken ? accessTokenHash(fields.accessToken) : undefined);
    if (ath !== undefined) claims['ath'] = ath;
  }
  if (fields.nonce !== undefined) claims['nonce'] = fields.nonce;

  const header: Record<string, unknown> = {
    alg: key.alg,
    typ: fields.typ ?? 'dpop+jwt',
    ...(fields.omitJwk ? {} : { jwk: key.publicJwk }),
    ...(fields.header ?? {}),
  };

  return new SignJWT(claims)
    .setProtectedHeader(header as never)
    .setIssuedAt(fields.iat ?? Math.floor(Date.now() / 1000))
    .sign(key.privateKey);
}

export interface TestIssuer {
  /** A key resolver to inject where production would use createRemoteJWKSet. */
  jwks: JWTVerifyGetKey;
  jwksBody: JSONWebKeySet;
  issuer: string;
  audience: string;
  kid: string;
  mint(claims?: Record<string, unknown>, options?: { expiresIn?: string; kid?: string }): Promise<string>;
}

/** An in-memory OIDC issuer: RS256 like Authentik's default provider. */
export async function makeIssuer(options: { issuer?: string; audience?: string; kid?: string } = {}): Promise<TestIssuer> {
  const issuer = options.issuer ?? TEST_ISSUER;
  const audience = options.audience ?? TEST_AUDIENCE;
  const kid = options.kid ?? 'test-key-1';
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const jwksBody: JSONWebKeySet = { keys: [publicJwk] };

  return {
    jwks: createLocalJWKSet(jwksBody),
    jwksBody,
    issuer,
    audience,
    kid,
    async mint(claims = {}, opts = {}) {
      return new SignJWT({ ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? kid })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject((claims['sub'] as string) ?? randomUUID())
        .setIssuedAt()
        .setExpirationTime(opts.expiresIn ?? '5m')
        .sign(privateKey);
    },
  };
}

/** Serve a JWKS over loopback HTTP so createRemoteJWKSet's real fetch path is exercised. */
export async function serveJwks(body: JSONWebKeySet): Promise<{ url: URL; requests: number; close(): Promise<void>; app: FastifyInstance }> {
  const state = { requests: 0 };
  const app = Fastify({ logger: false });
  app.get('/jwks', async () => {
    state.requests += 1;
    return body;
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.addresses()[0];
  const url = new URL(`http://127.0.0.1:${address?.port}/jwks`);
  return {
    url,
    get requests() {
      return state.requests;
    },
    close: () => app.close(),
    app,
  };
}
