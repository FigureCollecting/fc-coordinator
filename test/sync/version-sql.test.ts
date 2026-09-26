// The collation BLOCKER, tested where it would bite: every WK-02 golden vector through the
// 0003 CHECK and through the store's apply path, on a database whose default collation is
// glibc en_US. The first describe proves the database really is hostile, so nothing here
// can pass because the locale happened to be C.
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fc from 'fast-check';
import { isCanonicalVersion } from '@figurecollecting/fc-api-contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyEvent, lockUser, serverNow, type Facet } from '../../src/sync/store.js';
import { startSyncDatabase, SYNC_PG_LOCALE, type SyncDatabase } from '../helpers/syncDatabase.js';

interface Golden {
  valid: { version: string }[];
  invalid: { version: string }[];
  order: { a: string; b: string; cmp: -1 | 0 | 1; note: string }[];
  sorted: string[];
  collationTraps: { a: string; b: string; bytewise: number; glibcEnUs: number; note: string }[];
}

const golden = createRequire(import.meta.url)(
  '@figurecollecting/fc-api-contract/golden/version-vectors.json',
) as Golden;

let db: SyncDatabase;

beforeAll(async () => {
  db = await startSyncDatabase();
}, 240_000);

afterAll(async () => {
  await db?.close();
});

async function newUser(): Promise<string> {
  const id = randomUUID();
  await db.admin.query('INSERT INTO app_user (id) VALUES ($1)', [id]);
  return id;
}

const PAYLOAD = '{"status":"owned","edited_at":"2026-09-26T09:15:00-05:00","tz":"America/Chicago"}';
const facet = (facetKey: string, version: string): Facet => ({ facetKey, version, op: 'upsert', payload: PAYLOAD });

/** One store-level write, the way Push makes it: a transaction holding the user lock. */
async function apply(userId: string, event: Facet): Promise<{ applied: boolean; current: Facet }> {
  const client = await db.app.connect();
  try {
    await client.query('BEGIN');
    await lockUser(client, userId);
    const result = await applyEvent(client, userId, event);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function isCanonicalInSql(versions: string[]): Promise<boolean[]> {
  const { rows } = await db.app.query<{ ok: boolean }>(
    'SELECT sync_version_is_canonical(v) AS ok FROM unnest($1::text[]) WITH ORDINALITY AS t(v, i) ORDER BY i',
    [versions],
  );
  return rows.map((r) => r.ok);
}

describe('the test database is hostile to a locale comparison', () => {
  it(`runs on glibc ${SYNC_PG_LOCALE}, not C`, async () => {
    const { rows } = await db.app.query<{ datcollate: string; datlocprovider: string }>(
      'SELECT datcollate, datlocprovider FROM pg_database WHERE datname = current_database()',
    );
    expect(rows[0]).toEqual({ datcollate: SYNC_PG_LOCALE, datlocprovider: 'c' });
  });

  it.each(golden.collationTraps)('orders the trap pair against bytewise under the default collation: $note', async (trap) => {
    const { rows } = await db.app.query<{ lt: boolean }>('SELECT $1::text < $2::text AS lt', [trap.a, trap.b]);
    expect(rows[0]!.lt).toBe(trap.glibcEnUs < 0);
    expect(rows[0]!.lt).not.toBe(trap.bytewise < 0);
  });
});

describe('0003 stores every version COLLATE "C"', () => {
  it.each(['facet_state', 'feed_event'])('%s.version', async (table) => {
    const { rows } = await db.app.query<{ collation_name: string | null }>(
      "SELECT collation_name FROM information_schema.columns WHERE table_name = $1 AND column_name = 'version'",
      [table],
    );
    expect(rows).toEqual([{ collation_name: 'C' }]);
  });
});

describe('the version CHECK is the contract grammar', () => {
  it('accepts every golden valid token', async () => {
    const versions = golden.valid.map((v) => v.version);
    expect(await isCanonicalInSql(versions)).toEqual(versions.map(() => true));
  });

  it('refuses every golden invalid token and every collation-trap token', async () => {
    const versions = [...golden.invalid.map((v) => v.version), ...golden.collationTraps.map((t) => t.b)];
    expect(await isCanonicalInSql(versions)).toEqual(versions.map(() => false));
  });

  it('agrees with the package parser on generated near-grammar tokens', async () => {
    const digits = (lo: number, hi: number) => fc.string({ unit: fc.constantFrom(...'0123456789'.split('')), minLength: lo, maxLength: hi });
    const mostly = <T>(good: fc.Arbitrary<T>, bad: fc.Arbitrary<T>) => fc.oneof({ weight: 4, arbitrary: good }, { weight: 1, arbitrary: bad });
    const two = (lo: number, hi: number) => fc.integer({ min: lo, max: hi }).map((n) => String(n).padStart(2, '0'));
    const device = mostly(
      fc.string({ unit: fc.constantFrom(...'0123456789abcdef'.split('')), minLength: 32, maxLength: 32 }),
      fc.string({ unit: fc.constantFrom(...'0123456789abcdefABCDEF-g'.split('')), minLength: 31, maxLength: 33 }),
    );
    const token = fc.oneof(
      { weight: 5, arbitrary: fc
        .record({
          y: fc.integer({ min: 0, max: 9999 }).map((n) => String(n).padStart(4, '0')),
          mo: two(0, 13),
          d: two(0, 32),
          h: two(0, 24),
          mi: two(0, 60),
          s: two(0, 60),
          frac: mostly(digits(6, 6), digits(5, 7)),
          suffix: fc.option(fc.record({ counter: mostly(digits(10, 10), digits(9, 11)), device })),
        })
        .map(({ y, mo, d, h, mi, s, frac, suffix }) => {
          const base = `${y}-${mo}-${d}T${h}:${mi}:${s}.${frac}Z`;
          return suffix === null ? base : `${base}#${suffix.counter}#${suffix.device}`;
        }) },
      { weight: 1, arbitrary: fc.string({ maxLength: 80 }) },
    );
    const seen = { bare: 0, suffixed: 0, invalid: 0 };
    await fc.assert(
      fc.asyncProperty(fc.array(token, { minLength: 50, maxLength: 200, size: 'max' }), async (versions) => {
        const expected = versions.map((v) => isCanonicalVersion(v));
        versions.forEach((v, i) => {
          if (!expected[i]) seen.invalid += 1;
          else if (v.includes('#')) seen.suffixed += 1;
          else seen.bare += 1;
        });
        expect(await isCanonicalInSql(versions)).toEqual(expected);
      }),
      { numRuns: 40 },
    );
    // Not vacuous: the generator reached all three classes.
    expect(Math.min(seen.bare, seen.suffixed, seen.invalid)).toBeGreaterThan(100);
  });

  it('refuses an out-of-grammar version at INSERT with a check violation', async () => {
    const userId = await newUser();
    const insert = db.app.query(
      "INSERT INTO feed_event (user_id, facet_key, version, op, payload) VALUES ($1, 'k', $2, 'delete', '')",
      [userId, golden.collationTraps[0]!.b],
    );
    await expect(insert).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the server clock is rendered canonical whatever the session settings', () => {
  it('serverNow folds an odd TimeZone and DateStyle to a canonical bare instant', async () => {
    const client = await db.app.connect();
    try {
      await client.query("SET TimeZone = 'Asia/Kathmandu'");
      await client.query("SET DateStyle = 'SQL, DMY'");
      const micros = async () =>
        BigInt((await client.query<{ us: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000000)::bigint AS us')).rows[0]!.us);
      const before = await micros();
      const now = await serverNow(client);
      const after = await micros();
      expect(isCanonicalVersion(now.iso)).toBe(true);
      expect(now.iso.endsWith('Z')).toBe(true);
      expect(now.micros >= before && now.micros <= after).toBe(true);
    } finally {
      client.release();
    }
  });
});

describe('the apply path orders by compareVersion, never by the database collation', () => {
  it.each(golden.order)('$note', async ({ a, b, cmp }) => {
    const forward = await newUser();
    await apply(forward, facet('holding/k/status', a));
    const second = await apply(forward, facet('holding/k/status', b));
    expect(second.applied).toBe(cmp < 0);
    expect(second.current.version).toBe(cmp < 0 ? b : a);

    const reverse = await newUser();
    await apply(reverse, facet('holding/k/status', b));
    const back = await apply(reverse, facet('holding/k/status', a));
    expect(back.applied).toBe(cmp > 0);
    expect(back.current.version).toBe(cmp > 0 ? a : b);
  });

  it('keeps the greatest golden token whatever order the writes arrive in', async () => {
    const greatest = golden.sorted.at(-1)!;
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray(golden.sorted, { minLength: golden.sorted.length }), async (order) => {
        const userId = await newUser();
        const applied: string[] = [];
        for (const version of order) {
          if ((await apply(userId, facet('uf/k/note', version))).applied) applied.push(version);
        }
        const state = await db.app.query<{ version: string }>(
          'SELECT version FROM facet_state WHERE user_id = $1',
          [userId],
        );
        expect(state.rows).toEqual([{ version: greatest }]);
        const feed = await db.app.query<{ version: string }>(
          'SELECT version FROM feed_event WHERE user_id = $1 ORDER BY seq',
          [userId],
        );
        expect(feed.rows.map((r) => r.version)).toEqual(applied);
        expect([...applied].sort()).toEqual(applied);
      }),
      { numRuns: 25 },
    );
  });
});
