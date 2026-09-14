import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createCoordinatorPool,
  describeTarget,
  poolConfigFromEnv,
  probeDatabase,
  sslFromEnv,
} from './pool.js';

const PASSWORD = 'hunter2';
const URL_WITH_SECRET = `postgres://fc_coordinator:${PASSWORD}@pg-coord-rw.fc:5432/fccoord`;

const CA_PEM = '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n';
// A real file, because sslFromEnv reads the CA's CONTENTS rather than its path.
const caDir = mkdtempSync(path.join(tmpdir(), 'fc-coordinator-ca-'));
const caPath = path.join(caDir, 'ca.crt');
writeFileSync(caPath, CA_PEM);

// Without this the suite leaves one temp directory behind on every run.
afterAll(() => {
  rmSync(caDir, { recursive: true, force: true });
});

describe('db/pool — configuration from the environment', () => {
  it('prefers DATABASE_URL when it is set', () => {
    const cfg = poolConfigFromEnv({ DATABASE_URL: URL_WITH_SECRET });
    expect(cfg.connectionString).toBe(URL_WITH_SECRET);
    expect(cfg.host).toBeUndefined();
  });

  it('falls back to discrete PG* variables', () => {
    const cfg = poolConfigFromEnv({
      PGHOST: 'pg.internal',
      PGPORT: '5433',
      PGUSER: 'fc_coordinator',
      PGPASSWORD: PASSWORD,
      PGDATABASE: 'fccoord',
    });
    expect(cfg.host).toBe('pg.internal');
    expect(cfg.port).toBe(5433);
    expect(cfg.user).toBe('fc_coordinator');
    expect(cfg.database).toBe('fccoord');
    expect(cfg.connectionString).toBeUndefined();
  });

  it('defaults PG_POOL_MAX to 10 and honours an override', () => {
    expect(poolConfigFromEnv({}).max).toBe(10);
    expect(poolConfigFromEnv({ PG_POOL_MAX: '25' }).max).toBe(25);
  });

  it('ignores a non-numeric PG_POOL_MAX rather than configuring NaN connections', () => {
    expect(poolConfigFromEnv({ PG_POOL_MAX: 'lots' }).max).toBe(10);
  });
});

describe('db/pool — TLS comes from the environment, never from a code change', () => {
  it('leaves ssl unset when PGSSLMODE is absent or disabled', () => {
    expect(sslFromEnv({})).toBeUndefined();
    expect(sslFromEnv({ PGSSLMODE: '' })).toBeUndefined();
    expect(sslFromEnv({ PGSSLMODE: 'disable' })).toBeUndefined();
  });

  it('maps require to an unverified session', () => {
    expect(sslFromEnv({ PGSSLMODE: 'require' })).toEqual({ rejectUnauthorized: false });
  });

  it('reads the CA file CONTENTS for verify-full, not its path', () => {
    expect(sslFromEnv({ PGSSLMODE: 'verify-full' })).toEqual({ rejectUnauthorized: true });
    const verified = sslFromEnv({ PGSSLMODE: 'verify-full', PGSSLROOTCERT: caPath });
    expect(verified).toEqual({ rejectUnauthorized: true, ca: CA_PEM });
  });

  it('throws on an unsupported PGSSLMODE rather than silently downgrading TLS', () => {
    expect(() => sslFromEnv({ PGSSLMODE: 'prefer' })).toThrow(/unsupported PGSSLMODE/i);
  });

  it('lets PGSSLMODE beat any sslmode already inside DATABASE_URL', () => {
    const cfg = poolConfigFromEnv({
      DATABASE_URL: `${URL_WITH_SECRET}?sslmode=disable`,
      PGSSLMODE: 'verify-full',
    });
    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });
});

describe('db/pool — describeTarget never reveals a credential', () => {
  it('strips the userinfo out of DATABASE_URL', () => {
    const described = describeTarget({ DATABASE_URL: URL_WITH_SECRET });
    expect(described).toBe('pg-coord-rw.fc:5432/fccoord');
    expect(described).not.toContain(PASSWORD);
    expect(described).not.toContain('fc_coordinator');
  });

  it('describes the discrete PG* form without the password', () => {
    const described = describeTarget({
      PGHOST: 'pg.internal',
      PGPORT: '5433',
      PGDATABASE: 'fccoord',
      PGPASSWORD: PASSWORD,
    });
    expect(described).toBe('pg.internal:5433/fccoord');
    expect(described).not.toContain(PASSWORD);
  });

  it('defaults the port and database when only PGHOST is set', () => {
    expect(describeTarget({ PGHOST: 'pg.internal' })).toBe('pg.internal:5432/postgres');
  });

  it('degrades instead of throwing on an unparseable DATABASE_URL', () => {
    expect(describeTarget({ DATABASE_URL: 'not a url' })).toBe('<unparseable>');
  });

  it('reports unknown when nothing at all is configured', () => {
    expect(describeTarget({})).toBe('unknown');
  });
});

describe('db/pool — probeDatabase', () => {
  it('reports reachable with a latency when the query succeeds', async () => {
    const result = await probeDatabase({ query: async () => ({ rows: [{ ok: 1 }] }) });
    expect(result.reachable).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result).not.toHaveProperty('code');
  });

  it('reports the driver error CODE only, never the message, when the query fails', async () => {
    const err = Object.assign(new Error(`connect ECONNREFUSED password=${PASSWORD}`), {
      code: 'ECONNREFUSED',
    });
    const result = await probeDatabase({
      query: async () => {
        throw err;
      },
    });
    expect(result.reachable).toBe(false);
    expect(result.code).toBe('ECONNREFUSED');
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it('falls back to a generic code when the driver error carries none', async () => {
    const result = await probeDatabase({
      query: async () => {
        throw new Error(`boom ${PASSWORD}`);
      },
    });
    expect(result.reachable).toBe(false);
    expect(result.code).toBe('UNKNOWN');
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it('survives a non-Error rejection', async () => {
    const result = await probeDatabase({
      query: async () => {
        throw 'a bare string';
      },
    });
    expect(result.reachable).toBe(false);
    expect(result.code).toBe('UNKNOWN');
  });
});

describe('db/pool — createCoordinatorPool', () => {
  it('builds a pool from the environment without connecting', async () => {
    const pool = createCoordinatorPool({}, { PGHOST: 'pg.internal', PG_POOL_MAX: '7' });
    try {
      expect(pool.options.max).toBe(7);
      expect(pool.options.host).toBe('pg.internal');
    } finally {
      await pool.end();
    }
  });

  it('lets an explicit override beat the environment', async () => {
    const pool = createCoordinatorPool({ max: 3 }, { PG_POOL_MAX: '7' });
    try {
      expect(pool.options.max).toBe(3);
    } finally {
      await pool.end();
    }
  });

  it('absorbs an idle-connection error instead of crashing the process', async () => {
    const pool = createCoordinatorPool({}, {});
    try {
      // An unhandled 'error' on an EventEmitter throws. The pool attaches an
      // absorber precisely so a dropped IDLE connection cannot kill the server.
      expect(() => pool.emit('error', new Error('idle client dropped'))).not.toThrow();
    } finally {
      await pool.end();
    }
  });
});
