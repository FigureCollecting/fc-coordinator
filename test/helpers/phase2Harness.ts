// The coordinator the Phase-2 client is tested against: the REAL buildApp with the real OIDC +
// DPoP edge, the test issuer, and either the in-memory device table below or the Postgres one.
// Plus transports for the client: one over app.inject (no socket) and a wrapper that lets a test
// play a misbehaving edge by rewriting one labelled response.
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { buildApp } from '../../src/app.js';
import { resolveAuthConfig } from '../../src/auth/config.js';
import { createAccessTokenVerifier } from '../../src/auth/oidc.js';
import type { DeviceStore } from '../../src/auth/plugin.js';
import type { AppUserState, EnrolledDevice, LiveDevice, RevokedDevice } from '../../src/db/devices.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import type { HttpRequest, HttpResponse, Transport } from '../../scripts/phase2-client/transport.js';
import type { TestIssuer } from './auth.js';

export const CLIENT_ID = 'fc-coordinator';

export interface CoordinatorOptions {
  issuer: TestIssuer;
  /** COORDINATOR_PUBLIC_ORIGIN: the left-hand side of every htu check. */
  origin: string;
  prefix?: string;
  noncePeriodSeconds?: number;
  requireNonce?: boolean;
  devices: DeviceStore;
  /** Serve SyncService on this pool. */
  sync?: pg.Pool;
  spineUrl?: string;
  /** Every structured log line, for the `auth_outcome` reasons the client cannot see. */
  logLines: string[];
}

const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

export function buildCoordinator(options: CoordinatorOptions): FastifyInstance {
  const config = resolveAuthConfig({
    OIDC_ISSUER: options.issuer.issuer,
    OIDC_AUDIENCE: options.issuer.audience,
    OIDC_JWKS_URI: 'https://auth.test.invalid/jwks',
    COORDINATOR_PUBLIC_ORIGIN: options.origin,
    DPOP_NONCE_PERIOD_SECONDS: String(options.noncePeriodSeconds ?? 300),
    DPOP_REQUIRE_NONCE: String(options.requireNonce ?? true),
  });
  return buildApp({
    db: options.sync ?? stubDb,
    logLevel: 'warn',
    logSink: (line) => options.logLines.push(line),
    routePrefix: options.prefix ?? '/api',
    auth: {
      config,
      devices: options.devices,
      verifyAccessToken: createAccessTokenVerifier({
        jwks: options.issuer.jwks,
        issuer: options.issuer.issuer,
        audience: options.issuer.audience,
        algorithms: config.oidcAlgorithms,
      }),
    },
    compare: {
      spineRead: options.spineUrl === undefined ? null : new SpineReadClient(options.spineUrl, 5_000, []),
      ...(options.sync !== undefined ? { sync: { db: options.sync } } : {}),
      initSigning: false,
    },
  });
}

/** The device table as a Map, revocation included. */
export function memoryDevices(): DeviceStore {
  const rows: { userId: string; deviceId: string; jkt: string; revokedAt: Date | null }[] = [];
  return {
    ensureAppUser: async (): Promise<AppUserState> => 'existing',
    findLiveDevice: async (userId, jkt): Promise<LiveDevice | undefined> => {
      const row = rows.find((r) => r.userId === userId && r.jkt === jkt && r.revokedAt === null);
      return row ? { deviceId: row.deviceId, jkt: row.jkt } : undefined;
    },
    enroll: async (input): Promise<EnrolledDevice> => {
      const existing = rows.find((r) => r.userId === input.userId && r.jkt === input.jkt && r.revokedAt === null);
      if (existing) return { deviceId: existing.deviceId, jkt: existing.jkt, enrolledAt: new Date(), created: false };
      const row = { userId: input.userId, deviceId: randomUUID(), jkt: input.jkt, revokedAt: null };
      rows.push(row);
      return { deviceId: row.deviceId, jkt: row.jkt, enrolledAt: new Date(), created: true };
    },
    revoke: async ({ userId, deviceId }): Promise<RevokedDevice | undefined> => {
      const row = rows.find((r) => r.userId === userId && r.deviceId === deviceId);
      if (row === undefined) return undefined;
      const changed = row.revokedAt === null;
      row.revokedAt ??= new Date();
      return { deviceId: row.deviceId, jkt: row.jkt, revokedAt: row.revokedAt, changed };
    },
  };
}

function toHeaders(raw: Record<string, string | string[] | number | undefined>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [String(value)]) headers.append(name, v);
  }
  return headers;
}

/** The client's transport over app.inject: the full Fastify lifecycle without a socket. */
export function injectTransport(app: () => FastifyInstance): Transport {
  let count = 0;
  return {
    get count() {
      return count;
    },
    async request(req: HttpRequest): Promise<HttpResponse> {
      count += 1;
      const url = new URL(req.url);
      const res = await app().inject({
        method: req.method as 'GET' | 'POST',
        url: `${url.pathname}${url.search}`,
        headers: req.headers,
        ...(req.body !== undefined ? { payload: typeof req.body === 'string' ? req.body : Buffer.from(req.body) } : {}),
      });
      return { status: res.statusCode, headers: toHeaders(res.headers), body: new Uint8Array(res.rawPayload) };
    },
  };
}

export interface Exchanged {
  request: HttpRequest;
  response?: HttpResponse;
  /** The `auth_outcome` reasons the coordinator logged while answering this request. */
  reasons: string[];
}

/**
 * Record every exchange, attribute the coordinator's log reasons to the request that caused them
 * (requests are sequential), and optionally rewrite a response: a test's misbehaving edge.
 */
export function recording(
  inner: Transport,
  logLines: string[],
  rewrite?: (req: HttpRequest, res: HttpResponse) => HttpResponse,
): Transport & { log: Exchanged[] } {
  const log: Exchanged[] = [];
  return {
    log,
    get count() {
      return inner.count;
    },
    async request(req) {
      const before = logLines.length;
      const entry: Exchanged = { request: req, reasons: [] };
      log.push(entry);
      try {
        const res = await inner.request(req);
        entry.response = rewrite ? rewrite(req, res) : res;
        return entry.response;
      } finally {
        entry.reasons = logLines
          .slice(before)
          .map((line) => (JSON.parse(line) as { auth_outcome?: string }).auth_outcome)
          .filter((r): r is string => r !== undefined);
      }
    },
  };
}

/** The reasons logged for the requests whose label is exactly `label`. */
export function reasonsFor(log: Exchanged[], label: string): string[] {
  return log.filter((e) => e.request.label === label).flatMap((e) => e.reasons);
}

/** A loopback port nobody holds right now, so the origin can be configured before listen. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** A response with its body replaced, for a test's lying edge. */
export function withStatus(res: HttpResponse, status: number, body = '{}'): HttpResponse {
  return { status, headers: res.headers, body: new TextEncoder().encode(body) };
}
