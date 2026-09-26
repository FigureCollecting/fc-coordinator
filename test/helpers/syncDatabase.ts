// A migrated coordinator database for the sync suites, on a deliberately hostile locale.
// glibc en_US ignores punctuation and folds case, so a version comparison made under the
// database default collation would misorder the golden collationTraps; C or musl would hide that.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SYNC_PG_IMAGE = 'postgres:17-bookworm';
export const SYNC_PG_LOCALE = 'en_US.utf8';
export const SYNC_DB = 'fccoord';
const MIGRATOR = 'fc_coordinator_migrator';
const APP = 'coordinator';

export interface SyncDatabase {
  container: StartedPostgreSqlContainer;
  /** The application role the service runs as. */
  app: pg.Pool;
  /** Superuser on the same database: inspection and fault injection only. */
  admin: pg.Pool;
  close(): Promise<void>;
}

export async function startSyncDatabase(): Promise<SyncDatabase> {
  const container = await new PostgreSqlContainer(SYNC_PG_IMAGE)
    .withDatabase('bootstrap')
    .withUsername('postgres')
    .withPassword('postgres')
    .withEnvironment({ POSTGRES_INITDB_ARGS: `--locale-provider=libc --locale=${SYNC_PG_LOCALE}` })
    .withCopyDirectoriesToContainer([
      { source: path.join(REPO, 'migrations'), target: '/repo/migrations' },
      { source: path.join(REPO, 'scripts'), target: '/repo/scripts' },
    ])
    .start();

  const asSuper = async (sql: string): Promise<void> => {
    const run = await container.exec(['psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
    if (run.exitCode !== 0) throw new Error(`bootstrap failed: ${run.output}`);
  };
  await asSuper(`CREATE ROLE ${MIGRATOR} LOGIN PASSWORD 'migrator-pw' NOSUPERUSER`);
  await asSuper(`CREATE ROLE ${APP} LOGIN PASSWORD 'app-pw' NOSUPERUSER`);
  await asSuper(`CREATE DATABASE ${SYNC_DB} OWNER ${MIGRATOR}`);

  const migrate = await container.exec(['sh', '/repo/scripts/migrate.sh', '/repo/migrations'], {
    env: { PGUSER: MIGRATOR, PGPASSWORD: 'migrator-pw', PGDATABASE: SYNC_DB },
  });
  if (migrate.exitCode !== 0) throw new Error(`migrate.sh failed: ${migrate.output}`);

  const pool = (user: string, password: string): pg.Pool => {
    const p = new pg.Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user,
      password,
      database: SYNC_DB,
      max: 12,
    });
    p.on('error', () => {});
    return p;
  };
  const app = pool(APP, 'app-pw');
  const admin = pool('postgres', 'postgres');

  return {
    container,
    app,
    admin,
    async close() {
      await app.end();
      await admin.end();
      await container.stop();
    },
  };
}
