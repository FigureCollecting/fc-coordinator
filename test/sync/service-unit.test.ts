// SyncService's defensive branches, without a database: a context with no caller, and a Push
// whose transaction fails part-way.
import { randomUUID } from 'node:crypto';
import { SyncOp, canonicalVersion, userFacetKey } from '@figurecollecting/fc-api-contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { productionConnectOptions } from '../../src/connect/register.js';
import { SpineReadClient } from '../../src/spine/spineReadClient.js';
import type { SyncPool, TxClient } from '../../src/sync/store.js';
import { SYNC_SERVICE_PATH } from '../helpers/syncClient.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const DEVICE = '0f3a5c7e-9b1d-2f4a-6c8e-0b2d4f6a8c0e';
const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(pool: SyncPool, identity: { sub: string | null; device: string | null }): FastifyInstance {
  app = buildApp({
    db: stubDb,
    logLevel: 'silent',
    compare: {
      spineRead: null,
      initSigning: false,
      sync: { db: pool },
      resolveIdentity: () => (identity.sub === null ? null : { sub: identity.sub }),
      resolveDevice: () => identity.device,
    },
  });
  return app;
}

const call = (a: FastifyInstance, method: string, body: object = {}) =>
  a.inject({
    method: 'POST',
    url: `${SYNC_SERVICE_PATH}/${method}`,
    headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
    payload: JSON.stringify(body),
  });

const neverPool: SyncPool = {
  query: async () => {
    throw new Error('the pool must not be reached');
  },
  connect: async () => {
    throw new Error('the pool must not be reached');
  },
};

describe('a Sync call with no established caller', () => {
  it.each(['Delta', 'Push', 'Status'])('%s answers UNAUTHENTICATED when there is no subject', async (method) => {
    const res = await call(build(neverPool, { sub: null, device: DEVICE }), method, method === 'Push' ? { clientId: 'c' } : {});
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it.each(['Delta', 'Push', 'Status'])('%s answers UNAUTHENTICATED when no device is bound', async (method) => {
    const res = await call(build(neverPool, { sub: SUB, device: null }), method, method === 'Push' ? { clientId: 'c' } : {});
    expect(res.statusCode).toBe(401);
  });
});

describe('a Push whose transaction fails', () => {
  const batch = {
    clientId: randomUUID(),
    events: [
      {
        facetKey: userFacetKey(randomUUID(), 'status'),
        version: canonicalVersion({ instant: new Date(Date.now() - 1000), counter: 0, deviceId: DEVICE }),
        op: SyncOp.UPSERT,
        payload: '{}',
      },
    ],
  };

  function failingPool(failRollback: boolean): { pool: SyncPool; seen: string[]; release: ReturnType<typeof vi.fn> } {
    const seen: string[] = [];
    const release = vi.fn();
    const client: TxClient = {
      query: async (text: string) => {
        const lock = text.startsWith('SELECT pg_advisory_xact_lock');
        seen.push(lock ? 'lock' : text);
        if (lock) throw new Error('connection reset');
        if (text === 'ROLLBACK' && failRollback) throw new Error('connection gone');
        return { rows: [] };
      },
      release,
    } as unknown as TxClient;
    return { pool: { query: neverPool.query, connect: async () => client }, seen, release };
  }

  it('rolls back, releases the client, and answers INTERNAL', async () => {
    const { pool, seen, release } = failingPool(false);
    const res = await call(build(pool, { sub: SUB, device: DEVICE }), 'Push', batch);
    expect(res.statusCode).toBe(500);
    expect(seen).toEqual(['BEGIN', 'lock', 'ROLLBACK']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeUndefined();
  });

  it('discards the connection when the rollback itself fails', async () => {
    const { pool, release } = failingPool(true);
    const res = await call(build(pool, { sub: SUB, device: DEVICE }), 'Push', batch);
    expect(res.statusCode).toBe(500);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeInstanceOf(Error);
  });
});

describe('the Connect options the process serves', () => {
  it('mount SyncService beside Compare', async () => {
    app = buildApp({ db: stubDb, logLevel: 'silent', compare: { ...productionConnectOptions(neverPool, {}), initSigning: false } });
    await app.ready();
    for (const method of ['Delta', 'Push', 'Status']) {
      expect(app.hasRoute({ method: 'POST', url: `${SYNC_SERVICE_PATH}/${method}` })).toBe(true);
    }
    expect(app.hasRoute({ method: 'POST', url: '/coordinator.v1.CompareService/Compare' })).toBe(true);
  });

  it('take the spine from SPINE_READ_URL and run degraded without it', () => {
    expect(productionConnectOptions(neverPool, {}).spineRead).toBeNull();
    expect(productionConnectOptions(neverPool, { SPINE_READ_URL: 'http://spine.test.invalid' }).spineRead).toBeInstanceOf(SpineReadClient);
  });
});
