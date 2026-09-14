import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureAppUser, enrollDevice, findLiveDevice, publicJwkParams, revokeDevice } from './devices.js';
import { createDeviceStore } from '../auth/plugin.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = 'fccoord';
const MIGRATOR = 'fc_coordinator_migrator';
const MIGRATOR_PW = 'migrator-pw';

const JWK = { kty: 'EC', crv: 'P-256', x: 'abc', y: 'def' };

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

describe('device queries', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('bootstrap')
      .withUsername('postgres')
      .withPassword('postgres')
      .withCopyDirectoriesToContainer([
        { source: path.join(REPO, 'migrations'), target: '/repo/migrations' },
        { source: path.join(REPO, 'scripts'), target: '/repo/scripts' },
      ])
      .start();

    await container.exec([
      'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-c', `CREATE ROLE ${MIGRATOR} LOGIN PASSWORD '${MIGRATOR_PW}' NOSUPERUSER`,
    ]);
    await container.exec([
      'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1',
      '-c', `CREATE DATABASE ${DB} OWNER ${MIGRATOR}`,
    ]);
    const run = await container.exec(['sh', '/repo/scripts/migrate.sh', '/repo/migrations'], {
      env: { PGUSER: MIGRATOR, PGPASSWORD: MIGRATOR_PW, PGDATABASE: DB },
    });
    expect(run.exitCode).toBe(0);

    pool = new pg.Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: MIGRATOR,
      password: MIGRATOR_PW,
      database: DB,
    });
  }, 240_000);

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM device');
    await pool.query('DELETE FROM app_user');
  });

  describe('ensureAppUser', () => {
    it('creates the Authentik uuid on first sign-in and is idempotent after', async () => {
      const userId = randomUUID();
      expect(await ensureAppUser(pool, userId)).toBe('created');
      expect(await ensureAppUser(pool, userId)).toBe('existing');
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM app_user WHERE id = $1', [userId]);
      expect(rows[0].n).toBe(1);
    });

    it('REFUSES to resurrect a soft-deleted user', async () => {
      const userId = randomUUID();
      await ensureAppUser(pool, userId);
      await pool.query('UPDATE app_user SET deleted_at = now() WHERE id = $1', [userId]);
      expect(await ensureAppUser(pool, userId)).toBe('deleted');
    });
  });

  describe('enrollDevice', () => {
    it('stores the thumbprint and the public JWK, and reports it as created', async () => {
      const userId = randomUUID();
      await ensureAppUser(pool, userId);
      const result = await enrollDevice(pool, { userId, jkt: 'thumb-1', jwk: JWK, label: 'pixel' });

      expect(result.created).toBe(true);
      expect(result.jkt).toBe('thumb-1');
      const { rows } = await pool.query('SELECT jwk, label, revoked_at FROM device WHERE id = $1', [
        result.deviceId,
      ]);
      expect(rows[0].jwk).toEqual(JWK);
      expect(rows[0].label).toBe('pixel');
      expect(rows[0].revoked_at).toBeNull();
    });

    it('is idempotent for the same live (user, thumbprint) and returns the existing device', async () => {
      const userId = randomUUID();
      await ensureAppUser(pool, userId);
      const first = await enrollDevice(pool, { userId, jkt: 'thumb-1', jwk: JWK });
      const again = await enrollDevice(pool, { userId, jkt: 'thumb-1', jwk: JWK });

      expect(again.created).toBe(false);
      expect(again.deviceId).toBe(first.deviceId);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM device');
      expect(rows[0].n).toBe(1);
    });

    it('lets the SAME thumbprint be re-enrolled after revocation, keeping the revoked row', async () => {
      const userId = randomUUID();
      await ensureAppUser(pool, userId);
      const first = await enrollDevice(pool, { userId, jkt: 'thumb-1', jwk: JWK });
      await revokeDevice(pool, { userId, deviceId: first.deviceId });
      const second = await enrollDevice(pool, { userId, jkt: 'thumb-1', jwk: JWK });

      expect(second.deviceId).not.toBe(first.deviceId);
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM device');
      expect(rows[0].n).toBe(2);
    });

    it('keeps two users with the same thumbprint apart', async () => {
      const a = randomUUID();
      const b = randomUUID();
      await ensureAppUser(pool, a);
      await ensureAppUser(pool, b);
      await enrollDevice(pool, { userId: a, jkt: 'shared', jwk: JWK });
      await enrollDevice(pool, { userId: b, jkt: 'shared', jwk: JWK });

      expect(await findLiveDevice(pool, a, 'shared')).toBeDefined();
      expect(await findLiveDevice(pool, b, 'shared')).toBeDefined();
      expect((await findLiveDevice(pool, a, 'shared'))?.deviceId).not.toBe(
        (await findLiveDevice(pool, b, 'shared'))?.deviceId,
      );
    });
  });

  describe('findLiveDevice', () => {
    it('finds a live device and misses a revoked one', async () => {
      const userId = randomUUID();
      await ensureAppUser(pool, userId);
      const device = await enrollDevice(pool, { userId, jkt: 'thumb-1', jwk: JWK });

      expect(await findLiveDevice(pool, userId, 'thumb-1')).toEqual({
        deviceId: device.deviceId,
        jkt: 'thumb-1',
      });

      await revokeDevice(pool, { userId, deviceId: device.deviceId });
      expect(await findLiveDevice(pool, userId, 'thumb-1')).toBeUndefined();
    });

    it('misses a device belonging to another user', async () => {
      const owner = randomUUID();
      const other = randomUUID();
      await ensureAppUser(pool, owner);
      await ensureAppUser(pool, other);
      await enrollDevice(pool, { userId: owner, jkt: 'thumb-1', jwk: JWK });
      expect(await findLiveDevice(pool, other, 'thumb-1')).toBeUndefined();
    });

    it('misses every device of a soft-deleted user', async () => {
      const userId = randomUUID();
      await ensureAppUser(pool, userId);
      await enrollDevice(pool, { userId, jkt: 'thumb-1', jwk: JWK });
      await pool.query('UPDATE app_user SET deleted_at = now() WHERE id = $1', [userId]);
      expect(await findLiveDevice(pool, userId, 'thumb-1')).toBeUndefined();
    });
  });

  describe('revokeDevice', () => {
    it('sets revoked_at and NEVER deletes the row', async () => {
      const userId = randomUUID();
      await ensureAppUser(pool, userId);
      const device = await enrollDevice(pool, { userId, jkt: 'thumb-1', jwk: JWK });

      const revoked = await revokeDevice(pool, { userId, deviceId: device.deviceId });
      expect(revoked).toMatchObject({ deviceId: device.deviceId, jkt: 'thumb-1', changed: true });
      const { rows } = await pool.query('SELECT revoked_at FROM device WHERE id = $1', [device.deviceId]);
      expect(rows).toHaveLength(1);
      expect(rows[0].revoked_at).not.toBeNull();
    });

    it('is idempotent: revoking twice reports the original timestamp and changes nothing', async () => {
      const userId = randomUUID();
      await ensureAppUser(pool, userId);
      const device = await enrollDevice(pool, { userId, jkt: 'thumb-1', jwk: JWK });
      const first = await revokeDevice(pool, { userId, deviceId: device.deviceId });
      const second = await revokeDevice(pool, { userId, deviceId: device.deviceId });

      expect(second).toMatchObject({ deviceId: device.deviceId, changed: false });
      expect(second?.revokedAt.getTime()).toBe(first?.revokedAt.getTime());
    });

    it('refuses to revoke a device that is not this user’s', async () => {
      const owner = randomUUID();
      const attacker = randomUUID();
      await ensureAppUser(pool, owner);
      await ensureAppUser(pool, attacker);
      const device = await enrollDevice(pool, { userId: owner, jkt: 'thumb-1', jwk: JWK });

      expect(await revokeDevice(pool, { userId: attacker, deviceId: device.deviceId })).toBeUndefined();
      expect(await findLiveDevice(pool, owner, 'thumb-1')).toBeDefined();
    });

    it('returns undefined for a device id that does not exist', async () => {
      const userId = randomUUID();
      await ensureAppUser(pool, userId);
      expect(await revokeDevice(pool, { userId, deviceId: randomUUID() })).toBeUndefined();
    });
  });

  describe('createDeviceStore — the port the edge actually calls', () => {
    it('delegates every method to the real SQL against a real Postgres', async () => {
      const store = createDeviceStore(pool);
      const userId = randomUUID();

      expect(await store.ensureAppUser(userId)).toBe('created');
      const device = await store.enroll({ userId, jkt: 'thumb-port', jwk: JWK });
      expect(await store.findLiveDevice(userId, 'thumb-port')).toEqual({
        deviceId: device.deviceId,
        jkt: 'thumb-port',
      });
      expect(await store.revoke({ userId, deviceId: device.deviceId })).toMatchObject({ changed: true });
      expect(await store.findLiveDevice(userId, 'thumb-port')).toBeUndefined();
    });
  });
});

describe('publicJwkParams', () => {
  it('keeps the public members needed to re-derive the thumbprint', () => {
    expect(publicJwkParams({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid: 'k', alg: 'ES256', use: 'sig' })).toEqual(
      { kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid: 'k', alg: 'ES256', use: 'sig' },
    );
    expect(publicJwkParams({ kty: 'RSA', n: 'nn', e: 'AQAB' })).toEqual({ kty: 'RSA', n: 'nn', e: 'AQAB' });
  });

  it('DROPS every private parameter and anything unrecognised', () => {
    expect(
      publicJwkParams({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'PRIVATE', p: 'p', q: 'q', junk: 'x' }),
    ).toEqual({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b' });
  });

  it('drops members whose value is not a string', () => {
    expect(publicJwkParams({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', kid: 42 })).toEqual({
      kty: 'EC',
      crv: 'P-256',
      x: 'a',
      y: 'b',
    });
  });
});
