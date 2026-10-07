// ImportService's defensive branch, without a database: a context with no caller.
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import type { SyncPool } from '../../src/sync/store.js';
import { IMPORT_PATH } from '../helpers/syncClient.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const DEVICE = '0f3a5c7e-9b1d-2f4a-6c8e-0b2d4f6a8c0e';
const stubDb = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;
const neverPool: SyncPool = {
  query: async () => {
    throw new Error('the pool must not be reached');
  },
  connect: async () => {
    throw new Error('the pool must not be reached');
  },
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function build(identity: { sub: string | null; device: string | null }): FastifyInstance {
  app = buildApp({
    db: stubDb,
    logLevel: 'silent',
    compare: {
      spineRead: null,
      initSigning: false,
      import: { db: neverPool, spineRead: null, occIdKey: new Uint8Array(32) },
      resolveIdentity: () => (identity.sub === null ? null : { sub: identity.sub }),
      resolveDevice: () => identity.device,
    },
  });
  return app;
}

describe('an ImportMfcExport call with no established caller', () => {
  it.each([
    ['no subject', { sub: null, device: DEVICE }],
    ['no bound device', { sub: SUB, device: null }],
  ])('answers UNAUTHENTICATED with %s, before reading anything', async (_name, identity) => {
    const res = await build(identity).inject({
      method: 'POST',
      url: IMPORT_PATH,
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      payload: JSON.stringify({ csvText: 'ID,Status\n1,Owned\n', exportDate: '2026-09-09' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'unauthenticated' });
  });
});
