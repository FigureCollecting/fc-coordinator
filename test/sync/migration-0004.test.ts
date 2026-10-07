// 0004_sync_transactions on a database that already holds a feed: every event written before it
// is marked by the database transaction that wrote it (its created_at, the transaction's start), so
// a Push's events stay one server transaction (sync.proto rule 7) and nothing written earlier is
// left without a commit_cursor.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = 'fccoord';
const MIGRATOR = 'fc_coordinator_migrator';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let pg: StartedPostgreSqlContainer;

const run = async (cmd: string[], env: Record<string, string> = {}): Promise<string> => {
  const result = await pg.exec(cmd, { env });
  if (result.exitCode !== 0) throw new Error(`${cmd.join(' ')} failed: ${result.output}`);
  return result.stdout;
};
const asSuper = (sql: string) => run(['psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
const asMigrator = (sql: string) => run(['psql', '-U', MIGRATOR, '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
const migrate = (dir: string) =>
  run(['sh', '/repo/scripts/migrate.sh', dir], { PGUSER: MIGRATOR, PGPASSWORD: 'migrator-pw', PGDATABASE: DB });

/** One event, written in whatever transaction the surrounding psql -c runs. */
const event = (user: string, key: string) =>
  `INSERT INTO feed_event (user_id, facet_key, version, op, payload) VALUES ('${user}', '${key}', '2026-09-26T00:00:00.000000Z', 'delete', '');`;

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('bootstrap')
    .withUsername('postgres')
    .withPassword('postgres')
    .withCopyDirectoriesToContainer([
      { source: path.join(REPO, 'migrations'), target: '/repo/migrations' },
      { source: path.join(REPO, 'scripts'), target: '/repo/scripts' },
    ])
    .start();
  await asSuper(`CREATE ROLE ${MIGRATOR} LOGIN PASSWORD 'migrator-pw' NOSUPERUSER`);
  await asSuper("CREATE ROLE coordinator LOGIN PASSWORD 'app-pw' NOSUPERUSER");
  await asSuper(`CREATE DATABASE ${DB} OWNER ${MIGRATOR}`);
  await run(['sh', '-c', 'mkdir -p /repo/before && cp /repo/migrations/000[0-3]_*.sql /repo/before/']);
  await migrate('/repo/before');
}, 240_000);

afterAll(async () => {
  await pg?.stop();
});

describe('0004_sync_transactions over an existing feed', () => {
  it('opens a transaction at each database transaction of each user, and nowhere else', async () => {
    await asMigrator(`INSERT INTO app_user (id) VALUES ('${A}'), ('${B}')`);
    // One psql -c is one transaction: a1 and a2 are one Push; a3 another; a4, b1 and a5 one more
    // database transaction that wrote for two users.
    await asMigrator(event(A, 'a1') + event(A, 'a2'));
    await asMigrator(event(A, 'a3'));
    await asMigrator(event(A, 'a4') + event(B, 'b1') + event(A, 'a5'));

    expect(await migrate('/repo/migrations')).toContain('applied=1 skipped=4');

    const rows = await asMigrator("SELECT facet_key || '=' || opens_txn FROM feed_event ORDER BY seq");
    expect(rows.trim().split('\n')).toEqual(['a1=true', 'a2=false', 'a3=true', 'a4=true', 'b1=true', 'a5=false']);
  });
});
