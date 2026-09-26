// The real Fastify app with the OIDC + DPoP edge and SyncService on a real database, plus a
// caller that signs every request the way fc-mobile will: a fresh proof per call, the latest
// DPoP-Nonce, and one retry when the server asks for a nonce.
import { randomUUID } from 'node:crypto';
import {
  create,
  fromBinary,
  fromJsonString,
  toBinary,
  toJsonString,
  type DescMessage,
  type MessageInitShape,
  type MessageShape,
} from '@bufbuild/protobuf';
import {
  DeltaRequestSchema,
  DeltaResponseSchema,
  PushRequestSchema,
  PushResponseSchema,
  StatusRequestSchema,
  StatusResponseSchema,
  type DeltaResponse,
  type PushResponse,
  type StatusResponse,
} from '@figurecollecting/fc-api-contract';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../../src/app.js';
import { resolveAuthConfig } from '../../src/auth/config.js';
import { createAccessTokenVerifier } from '../../src/auth/oidc.js';
import { createDeviceStore } from '../../src/auth/plugin.js';
import { productionConnectOptions } from '../../src/connect/register.js';
import type { KeyedSerialiser } from '../../src/sync/serialise.js';
import { makeDeviceKey, makeIssuer, makeProof, TEST_ORIGIN, type DeviceKey, type TestIssuer } from './auth.js';

export const SYNC_SERVICE_PATH = '/coordinator.v1.SyncService';

export interface SyncApp {
  app: FastifyInstance;
  issuer: TestIssuer;
  close(): Promise<void>;
}

/**
 * Production wiring, as src/server.ts assembles it, minus the spine. Pass the issuer of a running
 * app to start a second replica on the same database that accepts the same tokens, and a Push
 * queue to watch it.
 */
export async function startSyncApp(db: pg.Pool, sharedIssuer?: TestIssuer, writers?: KeyedSerialiser): Promise<SyncApp> {
  const issuer = sharedIssuer ?? (await makeIssuer());
  const config = resolveAuthConfig({
    OIDC_ISSUER: issuer.issuer,
    OIDC_AUDIENCE: issuer.audience,
    OIDC_JWKS_URI: 'https://auth.test.invalid/jwks',
    COORDINATOR_PUBLIC_ORIGIN: TEST_ORIGIN,
  });
  const app = buildApp({
    db,
    logLevel: 'silent',
    auth: {
      config,
      devices: createDeviceStore(db),
      verifyAccessToken: createAccessTokenVerifier({
        jwks: issuer.jwks,
        issuer: issuer.issuer,
        audience: issuer.audience,
        algorithms: config.oidcAlgorithms,
      }),
    },
    compare: { ...productionConnectOptions(db, {}), ...(writers !== undefined ? { sync: { db, writers } } : {}), initSigning: false },
  });
  await app.ready();
  return { app, issuer, close: () => app.close() };
}

export type SyncMethod = 'Delta' | 'Push' | 'Status';

export type Rpc<T> =
  | { ok: true; message: T; raw: LightMyRequestResponse }
  | { ok: false; status: number; code: string; message: string; raw: LightMyRequestResponse };

/** One enrolled device of one user. */
export class SyncCaller {
  nonce: string | undefined;

  private constructor(
    private readonly app: FastifyInstance,
    readonly key: DeviceKey,
    readonly token: string,
    readonly userId: string,
    readonly deviceId: string,
  ) {}

  /** Enrol a new device key for `userId` (a fresh uuid by default). */
  static async enrol(harness: SyncApp, userId: string = randomUUID()): Promise<SyncCaller> {
    const key = await makeDeviceKey();
    const token = await harness.issuer.mint({ sub: userId });
    let nonce: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/auth/devices',
        headers: {
          authorization: `DPoP ${token}`,
          dpop: await makeProof(key, {
            htm: 'POST',
            htu: `${TEST_ORIGIN}/auth/devices`,
            accessToken: token,
            ...(nonce !== undefined ? { nonce } : {}),
          }),
        },
        payload: {},
      });
      nonce = res.headers['dpop-nonce'] as string;
      if (res.statusCode === 201 || res.statusCode === 200) {
        const caller = new SyncCaller(harness.app, key, token, userId, (res.json() as { deviceId: string }).deviceId);
        caller.nonce = nonce;
        return caller;
      }
    }
    throw new Error('enrolment failed');
  }

  /** A second device for the same user. */
  static async sibling(harness: SyncApp, of: SyncCaller): Promise<SyncCaller> {
    return SyncCaller.enrol(harness, of.userId);
  }

  /** This device and token, calling through another replica. */
  via(harness: SyncApp): SyncCaller {
    return new SyncCaller(harness.app, this.key, this.token, this.userId, this.deviceId);
  }

  /** Raw signed call. Retries once when the server asks for a nonce. */
  async send(method: SyncMethod, body: string | Buffer, binary = false): Promise<LightMyRequestResponse> {
    const url = `${SYNC_SERVICE_PATH}/${method}`;
    let res: LightMyRequestResponse | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      res = await this.app.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': binary ? 'application/proto' : 'application/json',
          'connect-protocol-version': '1',
          authorization: `DPoP ${this.token}`,
          dpop: await makeProof(this.key, {
            htm: 'POST',
            htu: `${TEST_ORIGIN}${url}`,
            accessToken: this.token,
            ...(this.nonce !== undefined ? { nonce: this.nonce } : {}),
          }),
        },
        payload: body,
      });
      this.nonce = (res.headers['dpop-nonce'] as string | undefined) ?? this.nonce;
      const challenge = String(res.headers['www-authenticate'] ?? '');
      if (!(res.statusCode === 401 && challenge.includes('use_dpop_nonce'))) break;
    }
    return res!;
  }

  private async call<I extends DescMessage, O extends DescMessage>(
    method: SyncMethod,
    input: I,
    output: O,
    init: MessageInitShape<I>,
  ): Promise<Rpc<MessageShape<O>>> {
    const raw = await this.send(method, toJsonString(input, create(input, init)));
    if (raw.statusCode === 200) return { ok: true, message: fromJsonString(output, raw.body), raw };
    const err = (raw.headers['content-type'] ?? '').toString().includes('json')
      ? (raw.json() as { code?: string; message?: string })
      : {};
    return { ok: false, status: raw.statusCode, code: err.code ?? '', message: err.message ?? '', raw };
  }

  delta(init: MessageInitShape<typeof DeltaRequestSchema> = {}): Promise<Rpc<DeltaResponse>> {
    return this.call('Delta', DeltaRequestSchema, DeltaResponseSchema, init);
  }

  push(init: MessageInitShape<typeof PushRequestSchema>): Promise<Rpc<PushResponse>> {
    return this.call('Push', PushRequestSchema, PushResponseSchema, init);
  }

  status(): Promise<Rpc<StatusResponse>> {
    return this.call('Status', StatusRequestSchema, StatusResponseSchema, {});
  }

  /** Push over the binary protocol: the wire bytes are returned untouched. */
  async pushBinary(init: MessageInitShape<typeof PushRequestSchema>): Promise<{ bytes: Buffer; message: PushResponse }> {
    const raw = await this.send('Push', Buffer.from(toBinary(PushRequestSchema, create(PushRequestSchema, init))), true);
    if (raw.statusCode !== 200) throw new Error(`push failed: ${raw.statusCode} ${raw.body}`);
    return { bytes: raw.rawPayload, message: fromBinary(PushResponseSchema, raw.rawPayload) };
  }
}

/** Unwrap an Rpc or fail the test with the server's error. */
export function ok<T>(rpc: Rpc<T>): T {
  if (!rpc.ok) throw new Error(`rpc failed: ${rpc.status} ${rpc.code} ${rpc.message}`);
  return rpc.message;
}

/** A display block every user-facet payload carries. */
export const DISPLAY = { edited_at: '2026-09-26T09:15:00.250-05:00', tz: 'America/Chicago' } as const;
