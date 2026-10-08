// The figure decision's edges the contract's vectors do not reach: placeholders, the dry run a
// conflict's keep reads, a field one side holds no value of, and what take and REALIGN make of a
// figure (import.proto MATERIALIZE, ITEMS AND ANSWERS).
import { describe, expect, it } from 'vitest';
import type { Facet } from '../sync/store.js';
import { decide, emptyEffect, finalKinds, keepEffect, realign, takeEffect, transitionsOf, View, type CopyBase, type FigureState, type Row } from './figure.js';

const S = '10000000-0000-4000-8000-000000000001';
const O1 = '01000000-0000-4000-8000-000000000001';
const O2 = '02000000-0000-4000-8000-000000000002';
const O3 = '03000000-0000-4000-8000-000000000003';
const V = '2026-10-01T10:00:00.000000Z#0000000001#0123456789abcdef0123456789abcdef';
const SHOWN = { edited_at: '2026-10-01T05:00:00-05:00', tz: 'America/Chicago' };
const occId = (id: string, n: number) => `0${n}${id.padStart(6, '0')}-0000-4000-8000-0000000000aa`.slice(0, 36);

const up = (facetKey: string, payload: object): Facet => ({ facetKey, version: V, op: 'upsert', payload: JSON.stringify(payload) });
const gone = (facetKey: string): Facet => ({ facetKey, version: V, op: 'delete', payload: '' });

function copy(occ: string, status: string | null, origin?: number, head = S): Facet[] {
  return [
    up(`occ/${occ}/head`, { head_id: head, ...SHOWN }),
    status === null ? gone(`occ/${occ}/status`) : up(`occ/${occ}/status`, { status, ...SHOWN }),
    ...(origin !== undefined ? [up(`occ/${occ}/origin`, { site: 'mfc', native_id: '119', ordinal: origin })] : []),
  ];
}

function view(facets: Facet[], bases: [string, CopyBase][] = [], rows: Row[] = [], fieldBases: [string, number | string | null][] = []): View {
  const st: FigureState = {
    facets: new Map(facets.map((f) => [f.facetKey, f])),
    rowBases: new Map(rows.map((r) => [r.id, r])),
    copyBases: new Map(bases),
    fieldBases: new Map([[S, new Map(fieldBases as [never, number | string | null][])]]),
  };
  return new View(st);
}

const row = (count: number, kind: Row['kind'] = 'owned', fields: Row['fields'] = {}, id = '119'): Row => ({ id, head: S, kind, count, fields });
const based = (kind: CopyBase['kind'], removed = false): CopyBase => ({ head: S, kind, removed });

describe('transitionsOf', () => {
  it('splits a change into arrivals, then wished to ordered and to owned, then removals and additions', () => {
    expect(transitionsOf({ owned: 2, ordered: 0, wished: 0 }, { owned: 0, ordered: 1, wished: 1 })).toEqual([
      ['ordered', 'owned'],
      ['wished', 'owned'],
    ]);
    expect(transitionsOf({ owned: 0, ordered: 1, wished: 0 }, { owned: 1, ordered: 0, wished: 1 })).toEqual([
      ['wished', 'ordered'],
      ['owned', 'out'],
    ]);
    expect(transitionsOf({ owned: 0, ordered: 0, wished: 2 }, { owned: 1, ordered: 0, wished: 0 })).toEqual([
      ['owned', 'out'],
      ['out', 'wished'],
      ['out', 'wished'],
    ]);
  });
});

describe('decide: MATERIALIZE on placeholders', () => {
  it('turns a placeholder of ordered into one of owned and writes nothing, the arrival of a copy MFC counts and the app does not have', () => {
    // Row base: ordered 2, of which the app has one copy; MFC says one ordered arrived.
    const v = view(copy(O1, 'ordered', 1), [[O1, based('ordered')]], [row(2, 'ordered')]);
    const d = decide(v, S, [row(1, 'ordered'), row(1, 'owned', {}, '120')], [row(2, 'ordered')], occId);
    expect(d.comps.counts).toBe('apply');
    expect(d.conflict).toBe(false);
    expect(d.counts.statuses.size + d.counts.created.length).toBe(0);
  });

  it('consumes a placeholder before removing a copy', () => {
    // Row base 3, the app has two of them: MFC's drop to 1 takes the placeholder, then one copy.
    const v = view([...copy(O1, 'owned', 1), ...copy(O2, 'owned', 2)], [[O1, based('owned')], [O2, based('owned')]], [row(3)]);
    const d = decide(v, S, [row(1)], [row(3)], occId);
    expect(d.comps.counts).toBe('apply');
    expect([...d.counts.statuses]).toEqual([[O2, null]]);
  });
});

describe('decide: the dry run a keep reads (A COPY KEPT AGAINST MFC\'S REMOVAL)', () => {
  it('names the copy MATERIALIZE would remove though the counts conflict', () => {
    // MFC lowered 2 to 1; the app added a hand copy: one removal left unmatched, a conflict.
    const v = view([...copy(O1, 'owned', 1), ...copy(O2, 'owned', 2), ...copy(O3, 'owned')], [[O1, based('owned')], [O2, based('owned')]], [row(2)]);
    const d = decide(v, S, [row(1)], [row(2)], occId);
    expect(d.comps.counts).toBe('conflict');
    expect(d.removals).toEqual([O2]);
  });

  it('names none when the app changed every copy MFC removed', () => {
    const v = view(copy(O1, 'wished', 1), [[O1, based('owned')]], [row(1)]);
    const d = decide(v, S, [row(0)], [row(1)], occId);
    expect(d.comps.counts).toBe('conflict');
    expect(d.removals).toEqual([]);
  });
});

describe('decide: a figure value one side holds none of', () => {
  it('records a conflict where the app removed the value and MFC changed it, with only MFC\'s side', () => {
    const v = view([gone(`uf/${S}/score`)], [], [row(1, 'owned', { score: 8 })], [['score', 8]]);
    const d = decide(v, S, [row(1, 'owned', { score: 9 })], [row(1, 'owned', { score: 8 })], occId);
    expect(d.comps.score).toBe('conflict');
    expect(d.comps.details.score).toEqual({ mfc: 9 });
  });

  it('records a conflict where MFC removed the value and the app changed it, with only the app\'s side', () => {
    const v = view([up(`uf/${S}/score`, { score: 9, ...SHOWN })], [], [row(1, 'owned', { score: 8 })], [['score', 8]]);
    const d = decide(v, S, [row(1)], [row(1, 'owned', { score: 8 })], occId);
    expect(d.comps.details.score).toEqual({ app: 9 });
  });
});

describe('takeEffect', () => {
  it('restores a copy an import removed, which it tracks no more, before it makes a new one', () => {
    const v = view(copy(O1, null, 1), [[O1, based('out', true)]], [row(0)]);
    const e = takeEffect(v, S, [row(1)], { counts: 'conflict', score: 'nochange', note: 'nochange', wishability: 'nochange', details: {} }, occId);
    expect([...e.statuses]).toEqual([[O1, 'owned']]);
    expect(e.created).toEqual([]);
    expect(e.copyBases.get(O1)).toEqual(based('owned'));
  });

  it('converts a tracked copy first: MFC\'s arrival made true on the copy it tracks', () => {
    const v = view([...copy(O1, 'ordered', 1), ...copy(O2, 'owned')], [[O1, based('ordered')]], [row(1, 'ordered')]);
    const e = takeEffect(v, S, [row(1)], { counts: 'conflict', score: 'nochange', note: 'nochange', wishability: 'nochange', details: {} }, occId);
    expect([...e.statuses]).toEqual([[O1, 'owned']]);
    expect(e.created).toEqual([]);
  });

  it('writes no field the app already holds at MFC\'s value', () => {
    const v = view([up(`uf/${S}/note`, { note: 'mfc', ...SHOWN })]);
    const found = { counts: 'nochange', score: 'nochange', note: 'apply', wishability: 'conflict', details: {} };
    const e = takeEffect(v, S, [row(0, 'owned', { note: 'mfc', wishability: 2 })], found, occId);
    expect([...e.fields]).toEqual([['wishability', 2]]);
  });
});

describe('keepEffect', () => {
  it('applies nothing the rev found MFC\'s alone that is no longer MFC\'s alone', () => {
    const v = view([up(`uf/${S}/note`, { note: 'app', ...SHOWN })], [], [row(1, 'owned', { note: 'base' })], [['note', 'base']]);
    const d = decide(v, S, [row(1, 'owned', { note: 'mfc' })], [row(1, 'owned', { note: 'base' })], occId);
    expect(d.comps.note).toBe('conflict');
    expect(keepEffect({ counts: 'nochange', score: 'nochange', note: 'apply', wishability: 'nochange', details: {} }, d).fields.size).toBe(0);
  });
});

describe('View', () => {
  it('reads a tombstoned filing as none', () => {
    const v = view([...copy(O1, 'owned'), up(`occ/${O1}/collection`, { collection: 'owned/default', ...SHOWN })]);
    expect(v.copies.get(O1)!.collection).toBe('owned/default');
    expect(view([...copy(O1, 'owned'), gone(`occ/${O1}/collection`)]).copies.get(O1)!.collection).toBeNull();
  });
});

describe('realign and finalKinds', () => {
  it('bases the lowest live copies up to MFC\'s Count, and every other copy, live or out, out', () => {
    const v = view([...copy(O1, 'owned', 1), ...copy(O2, 'former', 2), ...copy(O3, 'owned')]);
    const effect = emptyEffect();
    effect.statuses.set(O3, 'former');
    const final = finalKinds(v, S, effect);
    expect([...final]).toEqual([
      [O1, 'owned'],
      [O2, 'out'],
      [O3, 'out'],
    ]);
    const bases = realign(S, [row(1, 'owned', { note: 'n' })], new Map([...final, ['04000000-0000-4000-8000-000000000004', 'owned']]), (c) => c === O2);
    expect([...bases.copyBases]).toEqual([
      [O1, based('owned')],
      ['04000000-0000-4000-8000-000000000004', based('out')],
      [O2, based('out', true)],
      [O3, based('out')],
    ]);
    expect([...bases.fieldBases]).toEqual([
      ['score', null],
      ['note', 'n'],
      ['wishability', null],
    ]);
  });
});
