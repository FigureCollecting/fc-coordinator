// WK-05b: the read-only audit of the retired 0.2.x holding grain (sync.proto rule 6, RETIRED: rows
// already stored stay inert). scripts/holding-audit.sql runs against a local, migrated Postgres
// here and never against prod from a test; it must write nothing.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSyncDatabase, SYNC_DB, type SyncDatabase } from '../helpers/syncDatabase.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const AUDIT = 'scripts/holding-audit.sql';
const V = '2026-09-26T12:00:00.000000Z';

let db: SyncDatabase;

beforeAll(async () => {
  db = await startSyncDatabase();
}, 240_000);

afterAll(async () => {
  await db?.close();
});

/** Run SQL text through psql as the application role, as an operator would run the file. */
async function psql(sql: string): Promise<{ exitCode: number; output: string }> {
  await db.container.copyContentToContainer([{ content: sql, target: '/tmp/audit.sql' }]);
  return db.container.exec(['psql', '-X', '-A', '-t', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-d', SYNC_DB, '-f', '/tmp/audit.sql'], {
    env: { PGUSER: 'coordinator', PGPASSWORD: 'app-pw' },
  });
}

const audit = () => readFileSync(path.join(REPO, AUDIT), 'utf8');
const rows = (output: string) =>
  output
    .split('\n')
    .filter((line) => line.includes('|'))
    .map((line) => line.split('|'));

async function seedUser(id: string): Promise<void> {
  await db.admin.query('INSERT INTO app_user (id) VALUES ($1)', [id]);
}

async function seedFacet(userId: string, key: string, op: 'upsert' | 'delete'): Promise<void> {
  const payload = op === 'upsert' ? '{}' : '';
  await db.admin.query(
    `WITH fed AS (INSERT INTO feed_event (user_id, facet_key, version, op, payload) VALUES ($1, $2, $3, $4, $5) RETURNING seq)
     INSERT INTO facet_state (user_id, facet_key, version, op, payload, seq) SELECT $1, $2, $3, $4, $5, seq FROM fed`,
    [userId, key, V, op, payload],
  );
}

describe('scripts/holding-audit.sql', () => {
  it('reports zero on a freshly migrated database', async () => {
    const run = await psql(audit());
    expect(run.exitCode, run.output).toBe(0);
    expect(rows(run.output)).toEqual([
      ['facet_state', '0', '0', '0'],
      ['feed_event', '0', '0', '0'],
      ['holding_table', '0', '0', '0'],
    ]);
  });

  it('counts holding/* facets and feed events, live and tombstoned, per user, and the unused 0002 table', async () => {
    const [u1, u2] = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    await seedUser(u1);
    await seedUser(u2);
    await seedFacet(u1, 'holding/5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b/status', 'upsert');
    await seedFacet(u1, 'holding/5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b/count', 'delete');
    await seedFacet(u2, 'holding/6c1d8d8f-3a2e-4d2f-8b2c-4d5e6f7a8b9c/status', 'upsert');
    // Not holding/*: a 0.3.0 key, and keys that only look alike.
    await seedFacet(u1, 'occ/5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b/status', 'upsert');
    await seedFacet(u2, 'holdings/x/status', 'upsert');
    await seedFacet(u2, 'HOLDING/x/status', 'upsert');
    await db.admin.query(
      `INSERT INTO holding (id, user_id, status, deleted_at) VALUES
         ('33333333-3333-4333-8333-333333333333', $1, 'owned', NULL),
         ('44444444-4444-4444-8444-444444444444', $1, 'wished', now())`,
      [u1],
    );
    // A second feed event on one key: facet_state keeps one row, the feed keeps both.
    await db.admin.query(
      `INSERT INTO feed_event (user_id, facet_key, version, op, payload) VALUES ($1, 'holding/5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b/status', $2, 'upsert', '{}')`,
      [u1, V],
    );

    const before = await db.admin.query('SELECT (SELECT count(*) FROM facet_state) AS f, (SELECT count(*) FROM feed_event) AS e, (SELECT count(*) FROM holding) AS h');
    const run = await psql(audit());
    expect(run.exitCode, run.output).toBe(0);
    // source | rows | live (upsert, or not soft-deleted) | users
    expect(rows(run.output)).toEqual([
      ['facet_state', '3', '2', '2'],
      ['feed_event', '4', '3', '2'],
      ['holding_table', '2', '1', '1'],
    ]);
    const after = await db.admin.query('SELECT (SELECT count(*) FROM facet_state) AS f, (SELECT count(*) FROM feed_event) AS e, (SELECT count(*) FROM holding) AS h');
    expect(after.rows).toEqual(before.rows);
  });

  it('runs in a transaction PostgreSQL holds read-only: a write slipped inside it is refused', async () => {
    const text = audit();
    expect(text.match(/^ROLLBACK;$/gm)).toHaveLength(1);
    const tampered = text.replace(/^ROLLBACK;$/m, "INSERT INTO app_user (id) VALUES ('55555555-5555-4555-8555-555555555555');\nROLLBACK;");
    const run = await psql(tampered);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toMatch(/cannot execute INSERT in a read-only transaction/);
    const { rows: users } = await db.admin.query("SELECT 1 FROM app_user WHERE id = '55555555-5555-4555-8555-555555555555'");
    expect(users).toEqual([]);
  });

  it('holds only SELECTs between its BEGIN READ ONLY and its ROLLBACK', () => {
    const statements = audit()
      .replace(/--.*$/gm, '')
      .split(';')
      .map((s) => s.trim().replace(/\s+/g, ' '))
      .filter((s) => s !== '');
    expect(statements[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(statements.at(-1)).toBe('ROLLBACK');
    for (const s of statements.slice(1, -1)) expect(s).toMatch(/^(WITH|SELECT) /);
  });
});
