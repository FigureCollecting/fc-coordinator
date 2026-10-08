// The pure half of import.proto LATE EDITS AND REPLAY: the figure as it stood before an import, the
// import's decision taken again with late edits placed before it, and HELD (ii)'s reaction to a
// revision.
import { describe, expect, it } from 'vitest';
import type { Facet } from '../sync/store.js';
import type { ImportState, Row } from './plan.js';
import type { Field } from './rows.js';
import {
  decideAgain,
  figureKeys,
  frameBefores,
  isServerVersion,
  keptEndedBy,
  placeEdits,
  reacts,
  sameDecision,
  summarize,
  type Frame,
  type Revision,
} from './replay.js';

const S = '10000000-0000-4000-8000-000000000001';
const T = '20000000-0000-4000-8000-000000000002';
const O1 = '01000000-0000-4000-8000-000000000001';
const O2 = '02000000-0000-4000-8000-000000000002';
const O3 = '03000000-0000-4000-8000-000000000003';
const V1 = '2026-10-01T10:00:00.000000Z#0000000001#0123456789abcdef0123456789abcdef';
const V2 = '2026-10-01T11:00:00.000000Z#0000000001#0123456789abcdef0123456789abcdef';
const SERVER = '2026-10-01T10:30:00.000000Z#0000000002#00000000000000000000000000000000';
const SHOWN = { edited_at: '2026-10-01T05:00:00-05:00', tz: 'America/Chicago' };
const occId = (id: string, n: number) => `0${n}${id.padStart(6, '0')}-0000-4000-8000-0000000000aa`.slice(0, 36);

const up = (facetKey: string, payload: object, version = V1): Facet => ({ facetKey, version, op: 'upsert', payload: JSON.stringify(payload) });
const facets = (...fs: Facet[]) => new Map(fs.map((f) => [f.facetKey, f]));
const copy = (occ: string, status: string, origin?: number, head = S): Facet[] => [
  up(`occ/${occ}/head`, { head_id: head, ...SHOWN }),
  up(`occ/${occ}/status`, { status, ...SHOWN }),
  ...(origin !== undefined ? [up(`occ/${occ}/origin`, { site: 'mfc', native_id: '119', ordinal: origin })] : []),
];
const row = (count: number, kind: Row['kind'] = 'owned', fields: Row['fields'] = {}, id = '119', head = S): Row => ({ id, head, kind, count, fields });

/** S as an import found it: one owned copy MFC counts, note "first". */
function frame(rows: Row[], copies: Facet[] = copy(O1, 'owned', 1)): { frame: Frame; pre: Map<string, Facet> } {
  const st: ImportState = {
    facets: facets(...copies, up(`uf/${S}/note`, { note: 'first', ...SHOWN })),
    rowBases: new Map([['119', row(1, 'owned', { note: 'first' })]]),
    copyBases: new Map([[O1, { head: S, kind: 'owned', removed: false }]]),
    fieldBases: new Map([[S, new Map([['note', 'first']])]]),
    items: new Map(),
    kept: new Map(),
  };
  return { frame: { importNumber: 2, exportDate: '2026-09-20', before: frameBefores(st, [S], rows).get(S)! }, pre: new Map(st.facets) };
}

describe('frameBefores: S as it stood just before the import', () => {
  it("keeps S's rows, bases, item and keeps, and every copy of S or of one of its rows, and nothing of another figure", () => {
    const st: ImportState = {
      facets: facets(...copy(O1, 'owned', 1), ...copy(O2, 'owned', 2, T), ...copy(O3, 'wished', undefined, T)),
      rowBases: new Map([
        ['119', row(1)],
        ['120', row(1, 'wished', {}, '120', T)],
      ]),
      copyBases: new Map([
        [O1, { head: S, kind: 'owned', removed: false }],
        [O3, { head: T, kind: 'wished', removed: false }],
      ]),
      fieldBases: new Map<string, Map<Field, number | string | null>>([
        [S, new Map([['score', 7]])],
        [T, new Map([['note', 'n']])],
      ]),
      items: new Map([[T, { head: T, rev: 'i1.x', raised: 1, side: '{}', comps: { counts: 'conflict', score: 'nochange', note: 'nochange', wishability: 'nochange', details: {} } }]]),
      kept: new Map([
        [O1, { head: S, kind: 'owned' }],
        [O3, { head: T, kind: 'wished' }],
      ]),
    };
    const before = frameBefores(st, [S, T], [row(2), row(1, 'wished', {}, '120', T)]);
    // O2's head is T, but its origin is S's row 119: an ordinal of S's row is never reused.
    expect(before.get(S)).toEqual({
      rows: [row(2)],
      rowBases: [row(1)],
      copyBases: [[O1, { head: S, kind: 'owned', removed: false }]],
      fieldBases: [['score', 7]],
      item: null,
      kept: [[O1, { head: S, kind: 'owned' }]],
      occs: [O1, O2],
    });
    expect(before.get(T)).toMatchObject({ item: { rev: 'i1.x' }, occs: [O2, O3], kept: [[O3, { head: T, kind: 'wished' }]] });
  });
});

describe('placeEdits: device edits merge by LWW', () => {
  it('places a newer edit, keeps a newer stored value, and adds a facet the figure had none of', () => {
    const base = facets(up('uf/s/note', { note: 'stored' }, V2), up('uf/s/score', { score: 1 }, V1));
    const placed = placeEdits(base, [up('uf/s/note', { note: 'older' }, V1), up('uf/s/score', { score: 2 }, V2), up('uf/s/wishability', { wishability: 3 }, V1)]);
    expect([...placed.values()].map((f) => [f.facetKey, JSON.parse(f.payload)])).toEqual([
      ['uf/s/note', { note: 'stored' }],
      ['uf/s/score', { score: 2 }],
      ['uf/s/wishability', { wishability: 3 }],
    ]);
    expect(base.get('uf/s/score')!.version).toBe(V1);
  });
});

describe('decideAgain and sameDecision', () => {
  it('a sale placed before an import that changed only the note leaves its decision as it was', () => {
    const { frame: f, pre } = frame([row(1, 'owned', { note: 'second' })]);
    const as = decideAgain(f, S, pre, [], occId);
    const replayed = decideAgain(f, S, pre, [up(`occ/${O1}/status`, { status: 'former', ...SHOWN }, V2)], occId);
    expect(as.writes.map((w) => w.facetKey)).toEqual([`uf/${S}/note`, `imp/mfc/change/${S}`]);
    expect(sameDecision(as, replayed)).toBe(true);
  });

  it('a sale placed before an import that dropped the row turns the removal into agreement', () => {
    const { frame: f, pre } = frame([]);
    const as = decideAgain(f, S, pre, [], occId);
    const replayed = decideAgain(f, S, pre, [up(`occ/${O1}/status`, { status: 'former', ...SHOWN }, V2)], occId);
    // The dropped row states no note either: both decisions tombstone it.
    expect(as.writes.map((w) => [w.facetKey, w.op])).toEqual([
      [`occ/${O1}/status`, 'delete'],
      [`uf/${S}/note`, 'delete'],
      [`imp/mfc/change/${S}`, 'upsert'],
    ]);
    expect(replayed.writes.map((w) => [w.facetKey, w.op])).toEqual([
      [`uf/${S}/note`, 'delete'],
      [`imp/mfc/change/${S}`, 'upsert'],
    ]);
    expect(replayed.copyBases.get(O1)).toEqual({ head: S, kind: 'out', removed: false });
    expect(sameDecision(as, replayed)).toBe(false);
  });

  it('a late edit that ends a knowing keep is placed before the import that reads the keep', () => {
    const { frame: f, pre } = frame([row(1, 'owned', { note: 'first' })]);
    const kept: Frame = { ...f, before: { ...f.before, kept: [[O1, { head: S, kind: 'owned' }]] } };
    // MFC still counts the copy: the counts are equal, so the import ends the keep either way.
    expect(decideAgain(kept, S, pre, [], occId).keptGone).toEqual([O1]);
    expect(decideAgain(kept, S, pre, [up(`occ/${O1}/status`, { status: 'former', ...SHOWN }, V2)], occId).keptGone).toEqual([]);
  });

  it('reads an item that only shows the app anew as the same, and one with a new rev as another', () => {
    const { frame: f, pre } = frame([row(1, 'owned', { note: 'second' })]);
    const as = decideAgain(f, S, pre, [], occId);
    const item = { head: S, rev: 'i2.a', raised: 2, side: '{}', comps: { counts: 'nochange', score: 'nochange', note: 'nochange', wishability: 'nochange', details: {} } };
    const shown = { ...as, writes: [...as.writes, { facetKey: `imp/mfc/figure/${S}`, op: 'upsert' as const, payload: '{"a":1}' }], items: { set: [item], end: [] } };
    const anew = { ...shown, writes: [...as.writes, { facetKey: `imp/mfc/figure/${S}`, op: 'upsert' as const, payload: '{"a":2}' }] };
    expect(sameDecision(shown, anew)).toBe(true);
    expect(sameDecision(shown, { ...anew, items: { set: [{ ...item, rev: 'i2.b' }], end: [] } })).toBe(false);
  });
});

describe('keptEndedBy: a device edit ends a knowing keep when the copy leaves its kind or figure', () => {
  const kept = new Map([
    [O1, { head: S, kind: 'owned' as const }],
    [O2, { head: S, kind: 'wished' as const }],
    [O3, { head: S, kind: 'owned' as const }],
  ]);
  it('ends a keep moved to another kind, figure or none, and keeps one re-stated as it is', () => {
    expect(
      keptEndedBy(kept, [
        up(`occ/${O1}/status`, { status: 'owned', ...SHOWN }),
        up(`occ/${O1}/head`, { head_id: S, ...SHOWN }),
        up(`occ/${O2}/status`, { status: 'owned', ...SHOWN }),
        { facetKey: `occ/${O3}/head`, version: V1, op: 'delete', payload: '' },
        up(`occ/${O1}/collection`, { collection: 'owned/x', ...SHOWN }),
      ]),
    ).toEqual([O2, O3]);
    expect(keptEndedBy(kept, [up(`occ/${O1}/head`, { head_id: T, ...SHOWN }), up('uf/x/note', { note: 'n' })])).toEqual([O1]);
  });
});

describe('summarize: S\'s live copies and items', () => {
  it('reads each copy as its figure and kind or out, and each item by its rev', () => {
    const s = summarize(
      S,
      facets(
        ...copy(O1, 'owned'),
        ...copy(O2, 'former'),
        ...copy(O3, 'wished', undefined, T),
        // A status pushed before its copy's head: on no figure, so out.
        up('occ/05000000-0000-4000-8000-000000000005/status', { status: 'owned', ...SHOWN }),
        up(`imp/mfc/change/${S}`, { rev: 'i2.c' }),
        { facetKey: `imp/mfc/figure/${S}`, version: V1, op: 'delete', payload: '' },
      ),
      [O1, O2, O3, '04000000-0000-4000-8000-000000000004', '05000000-0000-4000-8000-000000000005'],
    );
    expect(s).toEqual({
      copies: { [O1]: `${S}/owned`, [O2]: 'out', [O3]: `${T}/wished`, '04000000-0000-4000-8000-000000000004': 'out', '05000000-0000-4000-8000-000000000005': 'out' },
      items: { figure: null, change: 'i2.c' },
    });
  });
});

describe('reacts: HELD (ii), an edit made before a revision it had not seen', () => {
  const rev: Revision = {
    head: S,
    marker: 10n,
    seq: 20n,
    before: { copies: { [O1]: `${S}/owned`, [O2]: 'out' }, items: { figure: null, change: 'i2.c' } },
    after: { copies: { [O1]: 'out', [O2]: 'out' }, items: { figure: null, change: null } },
  };
  it('writes a copy whose live state the revision changed, whatever the facet', () => {
    expect(reacts(rev, `occ/${O1}/tag/x`, false, true, [])).toBe(true);
  });
  it('adds a copy to S: the head or status of a copy that had no head when the import ran', () => {
    expect(reacts(rev, `occ/${O3}/head`, true, false, [])).toBe(true);
    expect(reacts(rev, `occ/${O3}/head`, false, false, [])).toBe(false);
    expect(reacts(rev, `occ/${O3}/tag/x`, true, false, [])).toBe(false);
  });
  it('writes the status or head of a copy of S while it saw an item the revision withdrew', () => {
    expect(reacts(rev, `occ/${O2}/status`, true, true, ['i1.f', 'i2.c'])).toBe(true);
    expect(reacts(rev, `occ/${O2}/status`, true, true, [])).toBe(false);
    expect(reacts(rev, `occ/${O2}/status`, true, true, ['i9.z'])).toBe(false);
    expect(reacts({ ...rev, after: { ...rev.after, items: { figure: 'i2.c', change: null } } }, `occ/${O2}/status`, true, true, ['i2.c'])).toBe(false);
    expect(reacts({ ...rev, before: { ...rev.before, items: { figure: 'i2.c', change: null } } }, `occ/${O2}/head`, true, true, ['i2.c'])).toBe(true);
  });
  it('a figure value is never a reaction', () => {
    expect(reacts(rev, `uf/${S}/score`, true, false, ['i2.c'])).toBe(false);
  });
});

describe('the keys of a figure, and the versions the server writes', () => {
  it('lists each copy\'s head, status, origin and filing, the figure values and the items', () => {
    expect(figureKeys(S, [O1])).toEqual([
      `occ/${O1}/head`,
      `occ/${O1}/status`,
      `occ/${O1}/origin`,
      `occ/${O1}/collection`,
      `uf/${S}/score`,
      `uf/${S}/note`,
      `uf/${S}/wishability`,
      `imp/mfc/figure/${S}`,
      `imp/mfc/change/${S}`,
    ]);
  });
  it('tells a server write by its reserved device', () => {
    expect([isServerVersion(SERVER), isServerVersion(V1)]).toEqual([true, false]);
  });
});
