import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ExecResult } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(REPO, 'migrations');

const DB = 'fccoord';
const MIGRATOR = 'fc_coordinator_migrator';
const MIGRATOR_PW = 'migrator-pw';

// ---------------------------------------------------------------------------
// Static suite: doctrine that holds without a database.
// ---------------------------------------------------------------------------
describe('migrations — numbered-SQL doctrine', () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();

  it('ships exactly the slice-1a pair, numbered NNNN_ and gap-free', () => {
    expect(files).toEqual(['0001_identity.sql', '0002_collection.sql']);
  });

  it('contains no transaction control — the runner owns the boundaries (psql -1)', () => {
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
      const stripped = sql.replace(/--[^\n]*/g, '');
      expect(stripped).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|START\s+TRANSACTION)\b/im);
    }
  });

  it('contains no CREATE INDEX CONCURRENTLY, which cannot run inside psql -1', () => {
    for (const file of files) {
      // Comments are stripped first: the ban is on executable SQL, and the
      // files legitimately DOCUMENT the rule in their headers.
      const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
      expect(sql).not.toMatch(/CONCURRENTLY/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Live suite: the real runner against a real Postgres.
// ---------------------------------------------------------------------------
describe('migrations — applied by scripts/migrate.sh against a real Postgres', () => {
  let pg: StartedPostgreSqlContainer;

  const asSuper = (sql: string): Promise<ExecResult> =>
    pg.exec(['psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]);

  const asMigratorDb = (sql: string): Promise<ExecResult> =>
    pg.exec(['psql', '-U', MIGRATOR, '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);

  const migrate = (
    env: Record<string, string> = {},
    dir = '/repo/migrations',
  ): Promise<ExecResult> =>
    pg.exec(['sh', '/repo/scripts/migrate.sh', dir], {
      env: {
        PGUSER: MIGRATOR,
        PGPASSWORD: MIGRATOR_PW,
        PGDATABASE: DB,
        ...env,
      },
    });

  beforeAll(async () => {
    pg = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('bootstrap')
      .withUsername('postgres')
      .withPassword('postgres')
      .withCopyDirectoriesToContainer([
        { source: MIGRATIONS, target: '/repo/migrations' },
        { source: path.join(REPO, 'scripts'), target: '/repo/scripts' },
      ])
      .start();

    // The migrator is a NON-SUPERUSER schema owner — the estate's three-role
    // model. migrate.sh refuses to run as a superuser.
    await asSuper(`CREATE ROLE ${MIGRATOR} LOGIN PASSWORD '${MIGRATOR_PW}' NOSUPERUSER`);
    await asSuper(`CREATE DATABASE ${DB} OWNER ${MIGRATOR}`);
  }, 240_000);

  afterAll(async () => {
    await pg?.stop();
  });

  it('applies both migrations in one run and records them in the ledger', async () => {
    const run = await migrate();
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('applied=2 skipped=0');

    const ledger = await asMigratorDb('SELECT filename FROM schema_migrations ORDER BY filename');
    expect(ledger.stdout.trim().split('\n')).toEqual(['0001_identity.sql', '0002_collection.sql']);
  });

  it('is a no-op on re-run', async () => {
    const run = await migrate();
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('applied=0 skipped=2');
  });

  it('creates app_user keyed by the Authentik uuid with soft delete and no password column', async () => {
    const cols = await asMigratorDb(
      "SELECT column_name || ':' || data_type FROM information_schema.columns WHERE table_name = 'app_user' ORDER BY column_name",
    );
    const listed = cols.stdout.trim().split('\n');
    expect(listed).toContain('id:uuid');
    expect(listed).toContain('deleted_at:timestamp with time zone');
    // Identity is Authentik's: no password, no TOTP, no WebAuthn in this service.
    expect(cols.stdout).not.toMatch(/password|totp|webauthn|mfa/i);
  });

  it('stores only the PUBLIC half of a device key and revokes without deleting', async () => {
    const cols = await asMigratorDb(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'device' ORDER BY column_name",
    );
    const listed = cols.stdout.trim().split('\n');
    expect(listed).toEqual(
      expect.arrayContaining(['id', 'user_id', 'jkt', 'jwk', 'revoked_at', 'last_seen_at']),
    );
    expect(listed).not.toContain('private_key');
  });

  it('allows one LIVE key per (user, jkt) and lets a revoked one be re-enrolled', async () => {
    await asMigratorDb(
      "INSERT INTO app_user (id, display_name) VALUES ('11111111-1111-1111-1111-111111111111', 'ross')",
    );
    const insert = (id: string): Promise<ExecResult> =>
      asMigratorDb(
        `INSERT INTO device (id, user_id, jkt, jwk) VALUES ('${id}', '11111111-1111-1111-1111-111111111111', 'thumb-1', '{}'::jsonb)`,
      );

    expect((await insert('22222222-2222-2222-2222-222222222222')).exitCode).toBe(0);
    const duplicate = await insert('33333333-3333-3333-3333-333333333333');
    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.output).toMatch(/duplicate key|unique/i);

    await asMigratorDb(
      "UPDATE device SET revoked_at = now() WHERE id = '22222222-2222-2222-2222-222222222222'",
    );
    expect((await insert('33333333-3333-3333-3333-333333333333')).exitCode).toBe(0);
  });

  it('constrains collection.kind and holding.status to the documented vocabularies', async () => {
    const badKind = await asMigratorDb(
      "INSERT INTO collection (id, user_id, name, kind) VALUES ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'x', 'borrowed')",
    );
    expect(badKind.exitCode).not.toBe(0);
    expect(badKind.output).toMatch(/check constraint/i);

    const badStatus = await asMigratorDb(
      "INSERT INTO holding (id, user_id, status) VALUES ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'borrowed')",
    );
    expect(badStatus.exitCode).not.toBe(0);
    expect(badStatus.output).toMatch(/check constraint/i);
  });

  it('keeps spine references as TEXT with no foreign key — a different database and lifecycle', async () => {
    const types = await asMigratorDb(
      "SELECT column_name || ':' || data_type FROM information_schema.columns WHERE table_name = 'holding' AND column_name IN ('head_id','gtin14','mfc_id','unit_ref','price_paid_amount') ORDER BY column_name",
    );
    for (const line of types.stdout.trim().split('\n')) {
      expect(line).toMatch(/:text$/);
    }

    const fks = await asMigratorDb(
      "SELECT kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name WHERE tc.table_name = 'holding' AND tc.constraint_type = 'FOREIGN KEY' ORDER BY kcu.column_name",
    );
    expect(fks.stdout.trim().split('\n').filter(Boolean)).toEqual(['collection_id', 'user_id']);
  });

  it('accepts a holding row carrying a string price amount and a soft delete', async () => {
    const ok = await asMigratorDb(
      "INSERT INTO holding (id, user_id, status, head_id, price_paid_amount, price_paid_currency) VALUES ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'owned', 'head-42', '12800', 'JPY')",
    );
    expect(ok.exitCode).toBe(0);
    const read = await asMigratorDb(
      "SELECT price_paid_amount FROM holding WHERE id = '66666666-6666-6666-6666-666666666666'",
    );
    expect(read.stdout.trim()).toBe('12800');
  });

  it('refuses to run as a SUPERUSER', async () => {
    const run = await migrate({ PGUSER: 'postgres', PGPASSWORD: 'postgres' });
    expect(run.exitCode).toBe(2);
    expect(run.output).toMatch(/SUPERUSER/i);
  });

  it('refuses a maintenance database', async () => {
    const run = await migrate({ PGDATABASE: 'postgres' });
    expect(run.exitCode).toBe(2);
    expect(run.output).toMatch(/maintenance database/i);
  });

  it('refuses a directory holding a .sql file the NNNN_ glob would silently ignore', async () => {
    // The enumerate glob is [0-9][0-9][0-9][0-9]_*.sql. Without this refusal a
    // misnamed migration is not an error, it is INVISIBLE: the run reports
    // success while the schema is missing whatever that file created.
    await pg.exec([
      'sh',
      '-c',
      'rm -rf /tmp/misnamed && cp -r /repo/migrations /tmp/misnamed' +
        ' && cp /repo/migrations/0001_identity.sql /tmp/misnamed/0003a_suffix.sql' +
        ' && cp /repo/migrations/0001_identity.sql /tmp/misnamed/003_threedigit.sql',
    ]);

    const run = await migrate({}, '/tmp/misnamed');
    expect(run.exitCode).toBe(2);
    expect(run.output).toMatch(/SILENTLY IGNORED/i);
    expect(run.output).toMatch(/0003a_suffix\.sql|003_threedigit\.sql/);
  });

  it('still exits 0 on a correctly named directory', async () => {
    const run = await migrate();
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain('applied=0 skipped=2');
  });

  it('refuses the whole run when an applied migration has been edited on disk', async () => {
    await pg.exec([
      'sh',
      '-c',
      'rm -rf /tmp/tampered && cp -r /repo/migrations /tmp/tampered && echo -- tampered >> /tmp/tampered/0002_collection.sql',
    ]);
    const run = await migrate({}, '/tmp/tampered');
    expect(run.exitCode).toBe(4);
    expect(run.output).toMatch(/provenance/i);
  });
});
