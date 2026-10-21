import { SyncOp, parseUserFacetKey } from '@figurecollecting/fc-api-contract';
import { describe, expect, it } from 'vitest';
import { buildBatches, type BuildOptions } from '../../scripts/gk2-import/build.js';
import { uuidV5 } from '../../scripts/gk2-import/ids.js';
import { parsePlan, type Entry } from '../../scripts/gk2-import/plan.js';
import { validateEvent } from '../../src/sync/validate.js';

const NS = '7d0c1d9e-5a43-4c52-9d4f-6f2a4b8f1c07';
const HEAD = '3907070b-50f1-4f99-b912-6d63db4bf805';
const DEVICE = '0f3a5c7e9b1d2f4a6c8e0b2d4f6a8c0e';
const AT = new Date('2026-10-21T20:00:00.000Z');
const OPTS: BuildOptions = { deviceHex: DEVICE, at: AT, tz: 'America/Chicago', clientPrefix: 'gk2-import-1' };

const entry = (over: Partial<Entry> & { line: string }): Entry => ({ kind: 'matched', status: 'owned', headId: HEAD, copies: 1, links: [], tags: [], ...over });
const build = (...entries: Entry[]) => buildBatches(parsePlan({ namespace: NS, entries }), OPTS);
const events = (...entries: Entry[]) => build(...entries).batches.flatMap((b) => b.events);
const byFamily = (list: ReturnType<typeof events>, family: string) => list.filter((e) => parseUserFacetKey(e.facetKey)?.family === family);
const body = (e: { payload: string }) => JSON.parse(e.payload) as Record<string, unknown>;

describe('buildBatches: a matched entry', () => {
  const [head, status, ...rest] = events(entry({ line: 'owned-3' }));
  const occ = uuidV5(NS, 'gk2:occ:owned-3:1');

  it('is one copy: its head and its status, nothing else', () => {
    expect(rest).toEqual([]);
    expect(head!.facetKey).toBe(`occ/${occ}/head`);
    expect(body(head!)).toEqual({ head_id: HEAD, edited_at: AT.toISOString(), tz: 'America/Chicago' });
    expect(status!.facetKey).toBe(`occ/${occ}/status`);
    expect(body(status!)).toEqual({ status: 'owned', edited_at: AT.toISOString(), tz: 'America/Chicago' });
  });

  it('is UPSERT with an empty basis and ascending versions on the importing device', () => {
    expect([head!.op, status!.op]).toEqual([SyncOp.UPSERT, SyncOp.UPSERT]);
    expect([head!.basis, status!.basis]).toEqual(['', '']);
    expect(head!.version).toBe('2026-10-21T20:00:00.000000Z#0000000001#' + DEVICE);
    expect(status!.version).toBe('2026-10-21T20:00:00.000000Z#0000000002#' + DEVICE);
  });

  it('writes one copy per count, each on its own occurrence id', () => {
    const two = events(entry({ line: 'owned-68', copies: 2 }));
    expect(byFamily(two, 'occ/head').map((e) => e.facetKey)).toEqual([`occ/${uuidV5(NS, 'gk2:occ:owned-68:1')}/head`, `occ/${uuidV5(NS, 'gk2:occ:owned-68:2')}/head`]);
    expect(byFamily(two, 'occ/status')).toHaveLength(2);
  });
});

describe('buildBatches: a text entry', () => {
  const label = { name: 'Katfight', maker: 'CBS Labs', scale: '1/4', edition: 'Jamie Tyndall' };
  const list = events(entry({ line: 'owned-8', kind: 'text', headId: undefined, label }));
  const head = uuidV5(NS, 'gk2:head:owned-8');

  it('holds its copy on a head minted from the line, and writes its label on that head', () => {
    expect(body(byFamily(list, 'occ/head')[0]!)).toMatchObject({ head_id: head });
    const [written] = byFamily(list, 'uf/label');
    expect(written!.facetKey).toBe(`uf/${head}/label`);
    expect(body(written!)).toEqual({ ...label, edited_at: AT.toISOString(), tz: 'America/Chicago' });
  });

  it('mints the same head on every run', () => {
    expect(events(entry({ line: 'owned-8', kind: 'text', headId: undefined, label }))).toEqual(list);
  });
});

describe('buildBatches: the figure facets', () => {
  it('writes the note and the links on the figure, links in the order given', () => {
    const list = events(entry({ line: 'ordered-17', status: 'ordered', note: 'Eyes Closed + Black Silk variant', links: ['https://a.example/1', 'https://b.example/2?x=1&y=2'] }));
    expect(body(byFamily(list, 'uf/note')[0]!)).toMatchObject({ note: 'Eyes Closed + Black Silk variant' });
    const [refs] = byFamily(list, 'uf/refs');
    expect(refs!.facetKey).toBe(`uf/${HEAD}/refs`);
    expect(body(refs!)).toMatchObject({ links: [{ url: 'https://a.example/1' }, { url: 'https://b.example/2?x=1&y=2' }] });
  });

  it('writes neither when the entry has neither', () => {
    const list = events(entry({ line: 'owned-3' }));
    expect(byFamily(list, 'uf/note')).toEqual([]);
    expect(byFamily(list, 'uf/refs')).toEqual([]);
  });

  it('writes the figure facets once however many copies there are', () => {
    const list = events(entry({ line: 'owned-68', copies: 2, note: 'and I have 2 of this one', links: ['https://a.example/1'] }));
    expect(byFamily(list, 'uf/note')).toHaveLength(1);
    expect(byFamily(list, 'uf/refs')).toHaveLength(1);
  });
});

describe('buildBatches: a former entry', () => {
  it('writes the status former and its disposal on each copy', () => {
    const list = events(entry({ line: 'scammed-3', status: 'former', disposal: { reason: 'other', counterparty: 'WK World', note: 'paid, never received' } }));
    expect(body(byFamily(list, 'occ/status')[0]!)).toMatchObject({ status: 'former' });
    const [disposal] = byFamily(list, 'occ/disposal');
    expect(disposal!.facetKey).toBe(`occ/${uuidV5(NS, 'gk2:occ:scammed-3:1')}/disposal`);
    expect(body(disposal!)).toMatchObject({ reason: 'other', counterparty: 'WK World', note: 'paid, never received' });
  });

  it('writes no disposal when the reason is unknown', () => {
    expect(byFamily(events(entry({ line: 'sold-2', status: 'former' })), 'occ/disposal')).toEqual([]);
  });
});

describe('buildBatches: collections and tags', () => {
  it('names each collection once, in the first batch, and files every copy of it there', () => {
    const built = build(
      entry({ line: 'ordered-2', status: 'ordered', collection: 'GKLoot' }),
      entry({ line: 'ordered-3', status: 'ordered', collection: 'GKLoot' }),
      entry({ line: 'owned-3', collection: 'Licensed PVCs' }),
    );
    const all = built.batches.flatMap((b) => b.events);
    const names = byFamily(all, 'coll/name');
    expect(names.map((e) => body(e).name).sort()).toEqual(['GKLoot', 'Licensed PVCs']);
    expect(byFamily(built.batches[0]!.events, 'coll/name')).toHaveLength(2);
    const gk = uuidV5(NS, 'gk2:coll:ordered:GKLoot');
    expect(names.map((e) => e.facetKey)).toContain(`coll/ordered/${gk}/name`);
    expect(byFamily(all, 'occ/collection').map((e) => body(e).collection)).toEqual([`ordered/${gk}`, `ordered/${gk}`, `owned/${uuidV5(NS, 'gk2:coll:owned:Licensed PVCs')}`]);
  });

  it('names each tag once and puts every copy of the entry in it', () => {
    const list = events(
      entry({ line: 'scammed-3', status: 'former', tags: ['scammed'] }),
      entry({ line: 'scammed-5', status: 'former', tags: ['scammed'], copies: 2 }),
    );
    const tag = uuidV5(NS, 'gk2:tag:scammed');
    expect(byFamily(list, 'tag/name').map((e) => [e.facetKey, body(e).name])).toEqual([[`tag/${tag}/name`, 'scammed']]);
    expect(byFamily(list, 'occ/tag').map((e) => e.facetKey)).toEqual([
      `occ/${uuidV5(NS, 'gk2:occ:scammed-3:1')}/tag/${tag}`,
      `occ/${uuidV5(NS, 'gk2:occ:scammed-5:1')}/tag/${tag}`,
      `occ/${uuidV5(NS, 'gk2:occ:scammed-5:2')}/tag/${tag}`,
    ]);
  });
});

describe('buildBatches: parked entries and batching', () => {
  it('writes nothing for a parked entry and lists its line', () => {
    const built = build(entry({ line: 'owned-19', kind: 'parked' }), entry({ line: 'owned-3' }));
    expect(built.parked).toEqual(['owned-19']);
    expect(built.batches.flatMap((b) => b.events).every((e) => !e.facetKey.includes(uuidV5(NS, 'gk2:occ:owned-19:1')))).toBe(true);
  });

  it('builds no batch at all for a plan of parked entries only', () => {
    const built = build(entry({ line: 'owned-19', kind: 'parked' }));
    expect(built).toEqual({ batches: [], parked: ['owned-19'], counts: {} });
  });

  it('never splits an entry across batches, and never sends more than 200 events at once', () => {
    const entries = Array.from({ length: 90 }, (_, i) => entry({ line: `owned-${i}`, copies: 1, note: 'n', links: ['https://a.example/1'] }));
    const built = build(...entries);
    expect(built.batches.length).toBeGreaterThan(1);
    for (const b of built.batches) expect(b.events.length).toBeLessThanOrEqual(200);
    for (const e of entries) {
      const occ = uuidV5(NS, `gk2:occ:${e.line}:1`);
      const holding = built.batches.filter((b) => b.events.some((x) => x.facetKey.startsWith(`occ/${occ}/`)));
      expect(holding).toHaveLength(1);
      expect(holding[0]!.events.some((x) => x.facetKey === `occ/${occ}/head`) && holding[0]!.events.some((x) => x.facetKey === `occ/${occ}/status`)).toBe(true);
    }
  });

  it('names batches by prefix and index, and counts what it wrote', () => {
    const built = build(entry({ line: 'owned-3' }));
    expect(built.batches.map((b) => b.clientId)).toEqual(['gk2-import-1-0001']);
    expect(built.counts).toEqual({ 'occ/head': 1, 'occ/status': 1 });
  });

  it('gives every event a distinct, ascending version', () => {
    const versions = events(entry({ line: 'a-1', note: 'n' }), entry({ line: 'a-2' })).map((e) => e.version);
    expect([...versions].sort()).toEqual(versions);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('refuses a plan whose collection and tag names alone are too many for one batch', () => {
    const entries = Array.from({ length: 21 }, (_, i) => entry({ line: `owned-${i}`, tags: Array.from({ length: 10 }, (_, j) => `tag-${i}-${j}`) }));
    expect(() => build(...entries)).toThrow(/names are 210 events/);
  });

  it('refuses a single entry too big for one batch', () => {
    expect(() => build(entry({ line: 'owned-1', copies: 99, status: 'former', disposal: { reason: 'sold' }, tags: ['a'], collection: undefined }))).toThrow(/200/);
  });
});

describe('buildBatches: what the coordinator would say', () => {
  it('every event of a plan with every part is accepted by the coordinator\'s own Push validation', () => {
    const list = events(
      entry({ line: 'owned-3', collection: 'Licensed PVCs', note: 'n', links: ['https://www.anitoysgk.com/%E3%80%90Pre-order%E3%80%91-p27998671.html?variant=104606213'] }),
      entry({ line: 'owned-8', kind: 'text', headId: undefined, label: { name: 'Katfight', maker: 'CBS Labs', series: 'S', scale: '1/4', edition: 'e' }, links: ['http://a.example/x'] }),
      entry({ line: 'scammed-3', status: 'former', tags: ['scammed'], disposal: { reason: 'other', counterparty: 'WK World', note: 'x' } }),
    );
    const ctx = { deviceHex: DEVICE, nowMicros: BigInt(AT.getTime()) * 1000n };
    const verdicts = list.map((e) => [e.facetKey, validateEvent(e, ctx)] as const);
    expect(verdicts.filter(([, v]) => !v.ok)).toEqual([]);
    expect(list).toHaveLength(15); // 2 names + 5 + 4 + 4
  });
});
