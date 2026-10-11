// ADDR-1: display restrictions are DATA (catalog.proto DISPLAY RESTRICTIONS): rows of the coordinator's
// display_restriction table (migration 0007), read through a short cache, with every product subject
// resolved to the head it names today so a restriction on a merged id covers the survivor's images.
import { describe, expect, it, vi } from 'vitest';
import { restrictionApplies } from '../../src/display/restrictions.js';
import { createDbDisplayRestrictionSource, NO_DISPLAY_RESTRICTIONS, type HeadResolver } from '../../src/display/source.js';

const HEAD = '11111111-1111-4111-8111-111111111111';
const MERGED = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

type Row = { rule_id: string; level: string; subject: string; scope: string };

const dbOf = (rows: Row[] | (() => Row[])) => {
  const query = vi.fn(async (_text: string) => ({ rows: typeof rows === 'function' ? rows() : rows }));
  return { query };
};

const resolverOf = (map: Record<string, string>): HeadResolver & ReturnType<typeof vi.fn> =>
  vi.fn(async (ids: readonly string[]) => new Map(ids.filter((id) => id in map).map((id) => [id, map[id]!]))) as never;

describe('createDbDisplayRestrictionSource', () => {
  it('reads every row of display_restriction as a restriction, verbatim', async () => {
    const db = dbOf([
      { rule_id: 'r1', level: 'image', subject: 'A'.repeat(64), scope: 'no_display' },
      { rule_id: 'r2', level: 'Image', subject: 'x', scope: 'no-share' },
    ]);
    const set = await createDbDisplayRestrictionSource({ db, resolveHeads: resolverOf({}) }).current();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]![0]).toMatch(/FROM display_restriction/);
    expect(set.restrictions).toEqual([
      { rule: 'r1', level: 'image', subject: 'A'.repeat(64), scope: 'no_display' },
      { rule: 'r2', level: 'Image', subject: 'x', scope: 'no-share' },
    ]);
  });

  it('names a head by itself and by every product subject that resolves to it, merged ids included', async () => {
    const resolveHeads = resolverOf({ [MERGED]: HEAD, [HEAD]: HEAD, [OTHER]: OTHER });
    const db = dbOf([
      { rule_id: 'r1', level: 'product', subject: MERGED.toUpperCase(), scope: 'no_share' },
      { rule_id: 'r2', level: 'product', subject: OTHER, scope: 'no_share' },
      { rule_id: 'r3', level: 'productx', subject: HEAD, scope: 'no_share' },
      { rule_id: 'r4', level: 'source', subject: 'amiami', scope: 'no_share' },
      { rule_id: 'r5', level: 'image', subject: 'c'.repeat(64), scope: 'no_share' },
      { rule_id: 'r6', level: 'product', subject: 'not-a-uuid', scope: 'no_share' },
    ]);
    const set = await createDbDisplayRestrictionSource({ db, resolveHeads }).current();
    // Only product and unrecognised-level subjects shaped like a product id are resolved, folded, once each.
    expect(resolveHeads).toHaveBeenCalledTimes(1);
    expect([...resolveHeads.mock.calls[0]![0]].sort()).toEqual([HEAD, MERGED, OTHER].sort());
    expect(set.productIdsFor(HEAD)).toEqual([HEAD, MERGED]);
    expect(set.productIdsFor(HEAD.toUpperCase())).toEqual([HEAD.toUpperCase(), MERGED]);
    expect(set.productIdsFor(OTHER)).toEqual([OTHER]);
    expect(set.productIdsFor('44444444-4444-4444-8444-444444444444')).toEqual(['44444444-4444-4444-8444-444444444444']);
  });

  it('asks the spine nothing when no subject needs resolving', async () => {
    const resolveHeads = resolverOf({});
    await createDbDisplayRestrictionSource({ db: dbOf([{ rule_id: 'r1', level: 'source', subject: 'hlj', scope: 'no_mask' }]), resolveHeads }).current();
    await createDbDisplayRestrictionSource({ db: dbOf([]), resolveHeads }).current();
    expect(resolveHeads).not.toHaveBeenCalled();
  });

  it('serves one read for the cache period, and reads again after it', async () => {
    let t = 1_000;
    const db = dbOf([]);
    const source = createDbDisplayRestrictionSource({ db, resolveHeads: resolverOf({}), ttlMs: 30_000, now: () => t });
    await Promise.all([source.current(), source.current()]);
    t += 29_999;
    await source.current();
    expect(db.query).toHaveBeenCalledTimes(1);
    t += 1;
    await source.current();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('defaults the cache period to 30 s', async () => {
    let t = 0;
    const db = dbOf([]);
    const source = createDbDisplayRestrictionSource({ db, resolveHeads: resolverOf({}), now: () => t });
    await source.current();
    t = 29_999;
    await source.current();
    expect(db.query).toHaveBeenCalledTimes(1);
    t = 30_000;
    await source.current();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('rejects when the table cannot be read, and does not cache the failure', async () => {
    let fail = true;
    const db = { query: vi.fn(async () => { if (fail) throw new Error('db down'); return { rows: [] }; }) };
    const source = createDbDisplayRestrictionSource({ db, resolveHeads: resolverOf({}) });
    await expect(source.current()).rejects.toThrow('db down');
    fail = false;
    await expect(source.current()).resolves.toMatchObject({ restrictions: [] });
  });

  it('rejects when a product subject cannot be resolved', async () => {
    const resolveHeads = vi.fn(async () => { throw new Error('spine down'); });
    const db = dbOf([{ rule_id: 'r1', level: 'product', subject: HEAD, scope: 'no_display' }]);
    await expect(createDbDisplayRestrictionSource({ db, resolveHeads }).current()).rejects.toThrow('spine down');
  });
});

describe('ids are matched without regard to ASCII case, on every side', () => {
  // Spine ids carry hex letters; ids of digits only would read the same in either case and prove nothing.
  const HEAD_AF = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const MERGED_AF = 'ffffffff-eeee-4ddd-8ccc-bbbbbbbbbbbb';

  it('resolves a product subject written in upper case, so a restriction on a merged id still covers the survivor', async () => {
    const resolveHeads = resolverOf({ [MERGED_AF]: HEAD_AF });
    const db = dbOf([{ rule_id: 'r1', level: 'product', subject: MERGED_AF.toUpperCase(), scope: 'no_display' }]);
    const set = await createDbDisplayRestrictionSource({ db, resolveHeads }).current();
    expect(resolveHeads.mock.calls[0]![0]).toEqual([MERGED_AF]);
    expect(set.productIdsFor(HEAD_AF)).toEqual([HEAD_AF, MERGED_AF]);
    // The evaluator then matches the rule's own (upper-case) subject against the folded alias.
    expect(restrictionApplies(set.restrictions[0]!, { imageId: 'c'.repeat(64), productIds: set.productIdsFor(HEAD_AF), sources: [], hasMask: false, hasOwnAlpha: false })).toBe(true);
  });

  it('finds the aliases of a head asked for, or resolved to, in upper case', async () => {
    const resolveHeads = resolverOf({ [MERGED_AF]: HEAD_AF.toUpperCase() });
    const db = dbOf([{ rule_id: 'r1', level: 'product', subject: MERGED_AF, scope: 'no_display' }]);
    const set = await createDbDisplayRestrictionSource({ db, resolveHeads }).current();
    expect(set.productIdsFor(HEAD_AF)).toEqual([HEAD_AF, MERGED_AF]);
    expect(set.productIdsFor(HEAD_AF.toUpperCase())).toEqual([HEAD_AF.toUpperCase(), MERGED_AF]);
  });
});

describe('NO_DISPLAY_RESTRICTIONS', () => {
  it('withholds nothing and names a head by itself', async () => {
    const set = await NO_DISPLAY_RESTRICTIONS.current();
    expect(set.restrictions).toEqual([]);
    expect(set.productIdsFor(HEAD)).toEqual([HEAD]);
  });
});
