// recordCursor (C-7): a Delta that moves neither of a device's cursors writes nothing. updated_at is
// then "when the cursor last moved"; nothing in src reads feed_cursor, so no reader changes meaning.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordCursor } from '../../src/sync/store.js';
import { startSyncDatabase, type SyncDatabase } from '../helpers/syncDatabase.js';

let db: SyncDatabase;
const user = randomUUID();
const device = randomUUID();

beforeAll(async () => {
  db = await startSyncDatabase();
  await db.admin.query('INSERT INTO app_user (id) VALUES ($1)', [user]);
  await db.admin.query("INSERT INTO device (id, user_id, jkt, jwk) VALUES ($1, $2, 'jkt', '{}')", [device, user]);
}, 240_000);

afterAll(async () => {
  await db?.close();
});

const row = async () =>
  (
    await db.admin.query<{ acked_seq: string; delivered_seq: string; updated_at: Date; xmin: string }>(
      'SELECT acked_seq, delivered_seq, updated_at, xmin::text AS xmin FROM feed_cursor WHERE user_id = $1 AND device_id = $2',
      [user, device],
    )
  ).rows[0]!;

describe('recordCursor', () => {
  it('records the first cursor, and moves both on a Delta that moves either', async () => {
    await recordCursor(db.app, user, device, 0n, 5n);
    expect(await row()).toMatchObject({ acked_seq: '0', delivered_seq: '5' });
    const first = await row();
    await recordCursor(db.app, user, device, 5n, 5n);
    const acked = await row();
    expect(acked).toMatchObject({ acked_seq: '5', delivered_seq: '5' });
    expect(acked.xmin).not.toBe(first.xmin);
    await recordCursor(db.app, user, device, 5n, 9n);
    const delivered = await row();
    expect(delivered).toMatchObject({ acked_seq: '5', delivered_seq: '9' });
    expect(delivered.xmin).not.toBe(acked.xmin);
    expect(delivered.updated_at.getTime()).toBeGreaterThanOrEqual(acked.updated_at.getTime());
  });

  it('writes nothing for a Delta that moves neither: the same row version, the same updated_at', async () => {
    const before = await row();
    await recordCursor(db.app, user, device, 5n, 9n);
    await recordCursor(db.app, user, device, 5n, 9n);
    const after = await row();
    expect(after).toEqual(before);
  });
});
