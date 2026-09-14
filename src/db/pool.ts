// ============================================================================
// The ONE place Postgres connections are configured (mirrors fc-aggregation's
// createSpinePool). Production sets DATABASE_URL plus PGSSLMODE=verify-full and
// PGSSLROOTCERT (the mounted CNPG CA); development uses the discrete PG*
// variables. TLS is a DEPLOYMENT setting, never a code change.
// ============================================================================
import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import pg from 'pg';

export type Env = Record<string, string | undefined>;

const DEFAULT_POOL_MAX = 10;

/**
 * PGSSLMODE -> node-postgres ssl. verify-full reads the CA file CONTENTS: the
 * driver wants PEM bytes, and handing it a path silently produces an
 * unverifiable session.
 */
export function sslFromEnv(env: Env = process.env): ConnectionOptions | undefined {
  const mode = env['PGSSLMODE'];
  if (mode === undefined || mode === '' || mode === 'disable') return undefined;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') {
    const caPath = env['PGSSLROOTCERT'];
    return {
      rejectUnauthorized: true,
      ...(caPath !== undefined ? { ca: readFileSync(caPath, 'utf8') } : {}),
    };
  }
  throw new Error(`unsupported PGSSLMODE '${mode}' (supported: disable | require | verify-full)`);
}

export function poolConfigFromEnv(env: Env = process.env): pg.PoolConfig {
  const url = env['DATABASE_URL'];
  const ssl = sslFromEnv(env);
  const poolMax = Number(env['PG_POOL_MAX']);

  return {
    ...(url !== undefined
      ? { connectionString: url }
      : {
          host: env['PGHOST'] ?? '127.0.0.1',
          port: Number(env['PGPORT'] ?? '5432'),
          user: env['PGUSER'] ?? 'postgres',
          password: env['PGPASSWORD'] ?? '',
          database: env['PGDATABASE'] ?? 'postgres',
        }),
    // Spread AFTER the URL so PGSSLMODE beats any in-URI sslmode.
    ...(ssl !== undefined ? { ssl } : {}),
    max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : DEFAULT_POOL_MAX,
  };
}

/**
 * A host:port/database label safe to put in a /healthz body. The userinfo is
 * dropped entirely — a DATABASE_URL carries the password in it.
 */
export function describeTarget(env: Env = process.env): string {
  const url = env['DATABASE_URL'];
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname}`;
    } catch {
      return '<unparseable>';
    }
  }
  const host = env['PGHOST'];
  if (host === undefined) return 'unknown';
  return `${host}:${env['PGPORT'] ?? '5432'}/${env['PGDATABASE'] ?? 'postgres'}`;
}

export function createCoordinatorPool(overrides: pg.PoolConfig = {}, env: Env = process.env): pg.Pool {
  const pool = new pg.Pool({ ...poolConfigFromEnv(env), ...overrides });
  // An IDLE pooled connection dropping emits 'error' on the pool; absorb it so
  // it cannot crash the process. Checked-out clients surface per query.
  pool.on('error', () => {});
  return pool;
}

/** The slice of pg.Pool /healthz needs. Keeps the route testable without a database. */
export interface QueryableDb {
  query(text: string): Promise<unknown>;
}

export interface DatabaseProbe {
  reachable: boolean;
  latencyMs: number;
  /** The driver's error CODE only. The MESSAGE routinely echoes the DSN. */
  code?: string;
}

export async function probeDatabase(db: QueryableDb): Promise<DatabaseProbe> {
  const started = process.hrtime.bigint();
  const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e6;
  try {
    await db.query('SELECT 1');
    return { reachable: true, latencyMs: elapsed() };
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : 'UNKNOWN';
    return { reachable: false, latencyMs: elapsed(), code };
  }
}
