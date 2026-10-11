// The figure decision's edges the contract's vectors do not reach: placeholders, the dry run a
// conflict's keep reads, a field one side holds no value of, and what take and REALIGN make of a
// figure (import.proto MATERIALIZE, ITEMS AND ANSWERS).
import { describe, expect, it } from 'vitest';
import type { Facet } from '../sync/store.js';
import { decide, emptyEffect, finalKinds, keepEffect, keptByAnswer, keptEndedByRealign, realign, takeEffect, transitionsOf, View, type Comps, type CopyBase, type FigureState, type Row } from './figure.js';

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
    // A wished copy goes to ordered before one goes to owned.
    expect(transitionsOf({ owned: 1, ordered: 1, wished: 0 }, { owned: 0, ordered: 0, wished: 1 })).toEqual([
      ['wished', 'ordered'],
      ['out', 'owned'],
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
    const v = view([...copy(O1, 'ordered', 1), ...copy(O2, 'ordered')], [[O1, based('ordered')]], [row(1, 'ordered')]);
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

const comps = (counts: string, fields: Partial<Comps> = {}): Comps => ({ counts, score: 'nochange', note: 'nochange', wishability: 'nochange', details: {}, ...fields });
const O4 = '04000000-0000-4000-8000-000000000004';

describe('decide: which copy MATERIALIZE takes', () => {
  it('removes a copy with an origin before a higher one without', () => {
    const v = view([...copy(O1, 'owned', 1), ...copy(O3, 'owned')], [[O1, based('owned')], [O3, based('owned')]], [row(2)]);
    expect([...decide(v, S, [row(1)], [row(2)], occId).counts.statuses]).toEqual([[O1, null]]);
  });

  it('pairs an app change only with an MFC change of the same from and to: a wished copy sold is no owned one removed', () => {
    const v = view([...copy(O1, 'owned', 1), ...copy(O2, null)], [[O1, based('owned')], [O2, based('wished')]], [row(1), row(1, 'wished', {}, '120')]);
    const d = decide(v, S, [row(0), row(1, 'wished', {}, '120')], [row(1), row(1, 'wished', {}, '120')], occId);
    expect(d.comps.counts).toBe('apply');
    expect([...d.counts.statuses]).toEqual([[O1, null]]);
  });

  it('restores no copy an import removed that the app has changed since, nor one the app moved to another figure', () => {
    const elsewhere = '20000000-0000-4000-8000-000000000002';
    // O1: removed by an import, re-added and removed again by the app (its base is wished now);
    // O2: removed by an import, then moved by the app to another figure. MFC raises the Count.
    const v = view([...copy(O1, null, 1), ...copy(O2, null, 2, elsewhere)], [[O1, based('wished', true)], [O2, based('out', true)]], [row(0), row(1, 'wished', {}, '120')]);
    const d = decide(v, S, [row(1), row(1, 'wished', {}, '120')], [row(0), row(1, 'wished', {}, '120')], occId);
    expect(d.comps.counts).toBe('apply');
    expect([...d.counts.statuses]).toEqual([]);
    expect(d.counts.created.map((c) => c.ordinal)).toEqual([3]);
  });

  it('names for a keep only the removals to out, not a copy the same decision would restore at another kind', () => {
    // MFC moved its row from owned to wished; the app added an owned copy of its own: a conflict.
    const v = view([...copy(O1, 'owned', 1), ...copy(O4, 'owned')], [[O1, based('owned')]], [row(1)]);
    const d = decide(v, S, [row(1, 'wished')], [row(1)], occId);
    expect(d.comps.counts).toBe('conflict');
    expect(d.removals).toEqual([O1]);
  });
});

describe('takeEffect: which copies it changes', () => {
  it('converts no copy into a kind MFC already has enough of: it removes the extra one instead', () => {
    const v = view([...copy(O1, 'ordered', 1), ...copy(O2, 'owned', 2)], [[O1, based('ordered')], [O2, based('owned')]], [row(1, 'ordered'), row(1, 'owned', {}, '120')]);
    expect([...takeEffect(v, S, [row(0, 'ordered'), row(1, 'owned', {}, '120')], comps('conflict'), occId).statuses]).toEqual([[O1, null]]);
  });

  it('removes the highest tracked copy with an origin', () => {
    const v = view([...copy(O1, 'owned', 1), ...copy(O2, 'owned', 2)], [[O1, based('owned')], [O2, based('owned')]], [row(2)]);
    expect([...takeEffect(v, S, [row(1)], comps('conflict'), occId).statuses]).toEqual([[O2, null]]);
  });

  it('restores a tracked copy whose base is another kind before it makes a new one', () => {
    const v = view(copy(O1, 'former', 1), [[O1, based('ordered')]], [row(1, 'ordered')]);
    const e = takeEffect(v, S, [row(1)], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([[O1, 'owned']]);
    expect(e.created).toEqual([]);
  });

  it('restores first the tracked out copy whose base is the kind, over a lower-id one based at another kind', () => {
    const v = view([...copy(O1, 'former', 1), ...copy(O2, 'former', 2)], [[O1, based('wished')], [O2, based('owned')]], [row(1, 'owned'), row(1, 'wished', {}, '120')]);
    const e = takeEffect(v, S, [row(1, 'owned')], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([[O2, 'owned']]);
    expect(e.created).toEqual([]);
  });

  it('never changes a copy with no base that no import removed: a hand copy the app sold stays sold', () => {
    const v = view(copy(O1, 'former'));
    const e = takeEffect(v, S, [row(1)], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([]);
    expect(e.created.map((c) => c.ordinal)).toEqual([1]);
  });
});

describe('takeEffect: the user\'s own copy of the figure counts before any copy is made (WK-14d)', () => {
  const elsewhere = '20000000-0000-4000-8000-000000000002';

  it('binds a hand copy live at the kind: no copy is made and none is changed', () => {
    const e = takeEffect(view(copy(O1, 'owned')), S, [row(1)], comps('alike'), occId);
    expect([...e.statuses]).toEqual([]);
    expect(e.created).toEqual([]);
  });

  it('binds only as many as MFC lacks: Count 2 beside one hand copy makes one, at the row\'s first ordinal', () => {
    const e = takeEffect(view(copy(O1, 'owned')), S, [row(2)], comps('apply'), occId);
    expect(e.created.map((c) => [c.kind, c.ordinal])).toEqual([['owned', 1]]);
    // Two hand copies beside a Count of 1: the second is the user's own and stays.
    const two = takeEffect(view([...copy(O1, 'owned'), ...copy(O2, 'owned')]), S, [row(1)], comps('matched+app-only'), occId);
    expect([...two.statuses]).toEqual([]);
    expect(two.created).toEqual([]);
  });

  it('binds every one of the user\'s own copies of the kind, not one per kind: two hand copies beside Count 2 make no copy, and beside Count 3 make one', () => {
    const v = view([...copy(O1, 'owned'), ...copy(O2, 'owned')]);
    const e = takeEffect(v, S, [row(2)], comps('conflict', { score: 'conflict' }), occId);
    expect([...e.statuses]).toEqual([]);
    expect(e.created).toEqual([]);
    const three = takeEffect(v, S, [row(3)], comps('conflict'), occId);
    expect([...three.statuses]).toEqual([]);
    expect(three.created.map((c) => [c.kind, c.ordinal])).toEqual([['owned', 1]]);
  });

  it('makes every copy MFC\'s Count lacks beside the user\'s own, not one: Count 3 beside one hand copy makes two, at the row\'s first two ordinals', () => {
    const e = takeEffect(view(copy(O1, 'owned')), S, [row(3)], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([]);
    expect(e.created.map((c) => [c.kind, c.ordinal])).toEqual([['owned', 1], ['owned', 2]]);
  });

  it('binds a hand copy that is wished or ordered as it binds an owned one: take writes only MFC\'s value of the disputed field', () => {
    const wished = view([...copy(O1, 'wished'), up(`uf/${S}/wishability`, { wishability: 2, ...SHOWN })]);
    const w = takeEffect(wished, S, [row(1, 'wished', { wishability: 4 })], comps('alike', { wishability: 'conflict' }), occId);
    expect([...w.statuses]).toEqual([]);
    expect(w.created).toEqual([]);
    expect([...w.fields]).toEqual([['wishability', 4]]);
    const ordered = view([...copy(O1, 'ordered'), up(`uf/${S}/note`, { note: 'mine', ...SHOWN })]);
    const o = takeEffect(ordered, S, [row(1, 'ordered', { note: 'mfc' })], comps('alike', { note: 'conflict' }), occId);
    expect([...o.statuses]).toEqual([]);
    expect(o.created).toEqual([]);
    expect([...o.fields]).toEqual([['note', 'mfc']]);
  });

  it('binds a live copy whose base is out, the one REALIGN left beyond an earlier Count', () => {
    const e = takeEffect(view(copy(O1, 'owned', 1), [[O1, based('out')]]), S, [row(1)], comps('apply'), occId);
    expect([...e.statuses]).toEqual([]);
    expect(e.created).toEqual([]);
  });

  it('binds a copy an import removed that the user brought back by hand: it is the user\'s own, and take neither restores it nor makes a second copy', () => {
    const e = takeEffect(view(copy(O1, 'owned', 1), [[O1, based('out', true)]], [row(0)]), S, [row(1)], comps('conflict', { score: 'conflict' }), occId);
    expect([...e.statuses]).toEqual([]);
    expect(e.created).toEqual([]);
  });

  it('binds a live hand copy before it restores a tracked copy the app sold', () => {
    const e = takeEffect(view([...copy(O1, 'former', 1), ...copy(O2, 'owned')], [[O1, based('owned')]], [row(1)]), S, [row(1)], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([]);
    expect(e.created).toEqual([]);
  });

  it('converts no tracked copy into a kind the user\'s own copies already fill: MFC\'s arrival beside a hand copy removes the tracked one', () => {
    for (const was of ['ordered', 'wished'] as const) {
      const v = view([...copy(O1, was, 1), ...copy(O2, 'owned')], [[O1, based(was)]], [row(1, was)]);
      const e = takeEffect(v, S, [row(1)], comps('conflict'), occId);
      expect([...e.statuses], was).toEqual([[O1, null]]);
      expect(e.created, was).toEqual([]);
    }
  });

  it('converts no tracked copy where two of the user\'s own fill MFC\'s Count 2: beside two hand owned copies the tracked ordered one is removed and none is made', () => {
    const v = view([...copy(O1, 'ordered', 1), ...copy(O2, 'owned'), ...copy(O3, 'owned')], [[O1, based('ordered')]], [row(1, 'ordered')]);
    const e = takeEffect(v, S, [row(2)], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([[O1, null]]);
    expect(e.created).toEqual([]);
  });

  it('still converts a tracked copy for the part of MFC\'s Count the user\'s own copies leave unfilled', () => {
    const v = view([...copy(O1, 'ordered', 1), ...copy(O2, 'owned')], [[O1, based('ordered')]], [row(1, 'ordered')]);
    const e = takeEffect(v, S, [row(2)], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([[O1, 'owned']]);
    expect(e.created).toEqual([]);
  });

  it('converts only as many tracked copies as the user\'s own leave MFC\'s Count short, the lowest first, and removes none: one hand owned, MFC owned 2 and ordered 1, two tracked ordered', () => {
    const v = view([...copy(O1, 'ordered', 1), ...copy(O2, 'ordered', 2), ...copy(O3, 'owned')], [[O1, based('ordered')], [O2, based('ordered')]], [row(2, 'ordered')]);
    const e = takeEffect(v, S, [row(1, 'ordered'), row(2, 'owned', {}, '120')], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([[O1, 'owned']]);
    expect(e.created).toEqual([]);
  });

  it('removes no tracked copy for the user\'s own: beside the copy MFC tracks at its Count, a hand copy of the kind leaves both', () => {
    const v = view([...copy(O1, 'owned', 1), ...copy(O2, 'owned')], [[O1, based('owned')]], [row(1)]);
    const e = takeEffect(v, S, [row(1)], comps('matched+app-only', { score: 'conflict' }), occId);
    expect([...e.statuses]).toEqual([]);
    expect(e.created).toEqual([]);
    // Nor converts it: MFC's new wished row is a new copy, not the tracked owned one moved.
    const w = takeEffect(v, S, [row(1), row(1, 'wished', {}, '120')], comps('conflict'), occId);
    expect([...w.statuses]).toEqual([]);
    expect(w.created.map((c) => [c.id, c.kind])).toEqual([['120', 'wished']]);
  });

  it('removes exactly the tracked copies over MFC\'s Count, and the user\'s own of the kind shield none and are never touched: Count 2 to 1 beside a hand copy removes the higher tracked one', () => {
    const v = view([...copy(O1, 'owned', 1), ...copy(O2, 'owned', 2), ...copy(O3, 'owned')], [[O1, based('owned')], [O2, based('owned')]], [row(2)]);
    const e = takeEffect(v, S, [row(1)], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([[O2, null]]);
    expect(e.created).toEqual([]);
    // Three tracked beside a copy REALIGN left the user's own (base out, the highest occ id with an
    // origin), MFC now Count 1: the two tracked over it go, and the user's own stays.
    const w = view(
      [...copy(O1, 'owned', 1), ...copy(O2, 'owned', 2), ...copy(O3, 'owned', 3), ...copy(O4, 'owned', 4)],
      [[O1, based('owned')], [O2, based('owned')], [O3, based('owned')], [O4, based('out')]],
      [row(3)],
    );
    const two = takeEffect(w, S, [row(1)], comps('conflict'), occId);
    expect(new Map(two.statuses)).toEqual(new Map([[O2, null], [O3, null]]));
    expect(two.created).toEqual([]);
  });

  it('counts a copy an import removed once, when take restores it: Count 2 restores it and makes one more', () => {
    const v = view(copy(O1, null, 1), [[O1, based('out', true)]], [row(0)]);
    const e = takeEffect(v, S, [row(2)], comps('conflict'), occId);
    expect([...e.statuses]).toEqual([[O1, 'owned']]);
    expect(e.created.map((c) => [c.kind, c.ordinal])).toEqual([['owned', 2]]);
  });

  it('never binds a hand copy of another kind, nor one now on another figure: those stay and MFC\'s copy is made', () => {
    const wished = takeEffect(view(copy(O1, 'wished')), S, [row(1)], comps('apply'), occId);
    expect([...wished.statuses]).toEqual([]);
    expect(wished.created.map((c) => c.kind)).toEqual(['owned']);
    const moved = takeEffect(view(copy(O1, 'owned', undefined, elsewhere), [[O1, based('out')]]), S, [row(1)], comps('apply'), occId);
    expect([...moved.statuses]).toEqual([]);
    expect(moved.created.map((c) => c.kind)).toEqual(['owned']);
  });

  it('binds a copy the user moved onto the figure from another: a base on the other figure leaves it the user\'s own here, and take makes no copy', () => {
    const e = takeEffect(view(copy(O1, 'owned'), [[O1, { head: elsewhere, kind: 'owned', removed: false }]]), S, [row(1)], comps('alike', { score: 'conflict' }), occId);
    expect([...e.statuses]).toEqual([]);
    expect(e.created).toEqual([]);
  });
});

describe('the knowing keeps an answer adds and ends', () => {
  const final = new Map<string, 'owned' | 'out'>([
    [O1, 'owned'],
    [O2, 'out'],
  ]);

  it('keep and per_copy on a rev that found the counts disputed or MFC\'s alone keep each removal they leave live; take keeps none', () => {
    expect([...keptByAnswer('keep', comps('conflict'), [O1, O2], final)]).toEqual([[O1, 'owned']]);
    expect([...keptByAnswer('per_copy', comps('apply'), [O1], final)]).toEqual([[O1, 'owned']]);
    expect([...keptByAnswer('take', comps('conflict'), [O1], final)]).toEqual([]);
    expect([...keptByAnswer('keep', comps('nochange'), [O1], final)]).toEqual([]);
    expect([...keptByAnswer('keep', comps('alike'), [O1], final)]).toEqual([]);
  });

  it('ends a keep whose copy left its kind, or that REALIGN gives a live base', () => {
    const kept = new Map([
      [O1, { kind: 'owned' as const }],
      [O2, { kind: 'owned' as const }],
      [O3, { kind: 'owned' as const }],
    ]);
    const bases = new Map([
      [O1, based('out')],
      [O3, based('owned')],
    ]);
    expect(keptEndedByRealign(kept, new Map([...final, [O3, 'owned']]), bases)).toEqual([O2, O3]);
  });
});
