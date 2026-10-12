// MASK-G (Ross 2026-10-11, option b): one store's cut-out masks are revocable, and restorable, by an
// operator with the coordinator migrator's credential (migration 0007's writer): scripts/mask-store.sh
// writes or removes the store's ONE display_restriction row (migration 0008's shape), and the
// coordinator's restriction source reads it into the decision that withholds the store's masks.
// Real Postgres, the real runner, the real script, the real reader.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { ExecResult } from 'testcontainers';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideDisplay, type ImageFacts } from '../../src/display/restrictions.js';
import { createDbDisplayRestrictionSource } from '../../src/display/source.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DB = 'fccoord';
const MIGRATOR = 'fc_coordinator_migrator';
const MIGRATOR_PW = 'migrator-pw';
const APP = 'coordinator';
const APP_PW = 'app-pw';

let container: StartedPostgreSqlContainer;
let app: pg.Pool;

const asMigrator = { PGUSER: MIGRATOR, PGPASSWORD: MIGRATOR_PW, PGDATABASE: DB };
const run = (args: string[], env: Record<string, string> = asMigrator): Promise<ExecResult> =>
  container.exec(['sh', '/repo/scripts/mask-store.sh', ...args], { env });
const sql = (text: string): Promise<ExecResult> =>
  container.exec(['psql', '-U', MIGRATOR, '-d', DB, '-At', '-v', 'ON_ERROR_STOP=1', '-c', text]);
const rows = async (): Promise<string[]> =>
  (await sql("SELECT rule_id || '|' || level || '|' || subject || '|' || scope || '|' || reason FROM display_restriction ORDER BY rule_id"))
    .stdout.trim().split('\n').filter(Boolean);

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
  const su = (text: string) => container.exec(['psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', text]);
  await su(`CREATE ROLE ${MIGRATOR} LOGIN PASSWORD '${MIGRATOR_PW}' NOSUPERUSER`);
  await su(`CREATE ROLE ${APP} LOGIN PASSWORD '${APP_PW}' NOSUPERUSER`);
  await su(`CREATE DATABASE ${DB} OWNER ${MIGRATOR}`);
  const migrated = await container.exec(['sh', '/repo/scripts/migrate.sh', '/repo/migrations'], { env: asMigrator });
  if (migrated.exitCode !== 0) throw new Error(migrated.output);
  app = new pg.Pool({ host: container.getHost(), port: container.getMappedPort(5432), user: APP, password: APP_PW, database: DB, max: 1 });
}, 240_000);

afterAll(async () => {
  await app?.end();
  await container?.stop();
});

describe('scripts/mask-store.sh revoke', () => {
  it('only says what it would write without --apply', async () => {
    const dry = await run(['revoke', 'shop-a']);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain('shop-a: not revoked');
    expect(dry.stdout).toContain('DRY RUN: --apply would add rule mask-store:shop-a (level source, scope no_mask)');
    expect(await rows()).toEqual([]);
  });

  it('writes the store\'s one row with --apply, its site key trimmed and folded, and says how soon it takes', async () => {
    const done = await run(['revoke', '  Shop-A\t', '--apply']);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('REVOKED shop-a: rule mask-store:shop-a written');
    expect(done.stdout).toMatch(/within the coordinator's restriction cache period \(30 s\)/);
    expect(await rows()).toEqual(['mask-store:shop-a|source|shop-a|no_mask|a store asked for its cut-outs to be removed (MASK-G)']);
  });

  it('writes nothing more when the store is already revoked, and says since when', async () => {
    const again = await run(['revoke', 'shop-a', '--apply', '--reason', 'second ask']);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/shop-a was already revoked \(since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\): nothing written/);
    expect(await rows()).toHaveLength(1);
    const dry = await run(['revoke', 'SHOP-A']);
    expect(dry.stdout).toMatch(/shop-a: revoked since \d{4}-\d\d-\d\dT/);
    expect(dry.stdout).toContain('DRY RUN: already revoked, --apply would write nothing');
  });

  it('records the reason it is given, quotes and all', async () => {
    const done = await run(['revoke', 'shop-b', '--reason', "store's letter, ref 42; see desk", '--apply']);
    expect(done.exitCode).toBe(0);
    expect(await rows()).toContain("mask-store:shop-b|source|shop-b|no_mask|store's letter, ref 42; see desk");
  });
});

describe('scripts/mask-store.sh restore', () => {
  it('names the other restrictions on the store, which it never touches', async () => {
    expect((await sql("INSERT INTO display_restriction (rule_id, level, subject, scope) VALUES ('takedown-7', 'source', 'Shop-A', 'no_display')")).exitCode).toBe(0);
    const dry = await run(['restore', 'shop-a']);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain('other restrictions naming shop-a stay: takedown-7 (source, no_display)');
    expect(dry.stdout).toContain('DRY RUN: --apply would remove rule mask-store:shop-a');
    expect(await rows()).toHaveLength(3);
  });

  it('removes only the store\'s revocation with --apply', async () => {
    const done = await run(['restore', 'Shop-A', '--apply']);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain('RESTORED shop-a: rule mask-store:shop-a removed');
    expect(await rows()).toEqual([
      "mask-store:shop-b|source|shop-b|no_mask|store's letter, ref 42; see desk",
      'takedown-7|source|Shop-A|no_display|',
    ]);
  });

  it('removes nothing from a store that is not revoked', async () => {
    const again = await run(['restore', 'shop-a', '--apply']);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('shop-a was not revoked: nothing removed');
    const dry = await run(['restore', 'shop-a']);
    expect(dry.stdout).toContain('DRY RUN: not revoked, --apply would remove nothing');
    expect(await rows()).toHaveLength(2);
  });
});

describe('scripts/mask-store.sh refuses', () => {
  it.each([
    ['no action', []],
    ['an unknown action', ['revoke-store', 'shop-c']],
    ['no source', ['revoke']],
    ['a blank source', ['revoke', ' \t ']],
    ['a source with white space inside', ['revoke', 'shop c']],
    ['a source with a control character', ['revoke', 'shop\u0001c']],
    ['a source too long for its rule id', ['revoke', 'x'.repeat(118)]],
    ['an unknown option', ['revoke', 'shop-c', '--force']],
    ['a reason with no text', ['revoke', 'shop-c', '--reason']],
    ['an empty reason', ['revoke', 'shop-c', '--reason', '']],
    ['a reason on a restore', ['restore', 'shop-c', '--reason', 'x']],
  ])('%s, writing nothing', async (_label, args) => {
    const before = await rows();
    const refused = await run(args, { ...asMigrator });
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toMatch(/^mask-store: ERROR: /);
    expect(await rows()).toEqual(before);
  });

  it('takes a source of exactly 117 characters, the most a rule id holds', async () => {
    const done = await run(['revoke', 'y'.repeat(117), '--apply']);
    expect(done.exitCode).toBe(0);
    expect(await run(['restore', 'y'.repeat(117), '--apply'])).toMatchObject({ exitCode: 0 });
  });

  it.each([
    ['PGDATABASE', { PGUSER: MIGRATOR, PGPASSWORD: MIGRATOR_PW }],
    ['PGUSER', { PGDATABASE: DB, PGPASSWORD: MIGRATOR_PW }],
  ])('to run without %s', async (_name, env) => {
    const refused = await run(['revoke', 'shop-c', '--apply'], env);
    expect(refused.exitCode).toBe(2);
    expect(await rows()).not.toContainEqual(expect.stringMatching(/^mask-store:shop-c/));
  });

  it('to write as the application role, which may only read restrictions', async () => {
    const refused = await run(['revoke', 'shop-c', '--apply'], { PGUSER: APP, PGPASSWORD: APP_PW, PGDATABASE: DB });
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr).toMatch(/permission denied|42501/);
    expect(await rows()).not.toContainEqual(expect.stringMatching(/^mask-store:shop-c/));
  });

  it('to go on when the database cannot be reached', async () => {
    const refused = await run(['revoke', 'shop-c'], { ...asMigrator, PGPORT: '1' });
    expect(refused.exitCode).toBe(3);
    expect(refused.stderr).toMatch(/^mask-store: ERROR: cannot connect/m);
  });
});

describe('a revocation, from the script to the decision', () => {
  const image = (sources: string[]): ImageFacts => ({ imageId: 'f'.repeat(64), productIds: ['p'], sources, hasMask: true, hasOwnAlpha: false });
  const decide = async (sources: string[]) => {
    const set = await createDbDisplayRestrictionSource({ db: app, resolveHeads: async () => new Map(), ttlMs: 0 }).current();
    return decideDisplay(image(sources), set.restrictions, 'owner');
  };

  it('withholds the revoked store\'s masks and no other store\'s, through the app role\'s read', async () => {
    expect((await run(['revoke', 'Shop-D', '--apply'])).exitCode).toBe(0);
    expect(await decide(['shop-d'])).toMatchObject({ image: true, mask: false, groundingFrom: 'unset', appearanceMasked: false, denials: [{ rule: 'mask-store:shop-d', scope: 'no_mask' }] });
    expect(await decide(['hlj', 'SHOP-D'])).toMatchObject({ image: true, mask: false });
    expect(await decide(['hlj'])).toMatchObject({ image: true, mask: true, groundingFrom: 'mask', denials: [] });
  });

  it('sends the masks again once the store is restored', async () => {
    expect((await run(['restore', 'shop-d', '--apply'])).exitCode).toBe(0);
    expect(await decide(['shop-d'])).toMatchObject({ image: true, mask: true, groundingFrom: 'mask', appearanceMasked: true, denials: [] });
  });
});
