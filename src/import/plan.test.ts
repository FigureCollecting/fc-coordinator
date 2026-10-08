// The 14a figure decision (import.proto THE SERVER DECIDES, for figures with no row base yet, and
// a re-import that finds a settled figure unchanged), as a pure function of the server's state.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import type { Facet } from '../sync/store.js';
import { importOccId } from './occ.js';
import { planImport, type ImportState, type PlanInput, type Row } from './plan.js';

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ strict: false, allErrors: true });
const figureSchema = ajv.compile(
  JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/schemas/imp-figure.schema.json'), 'utf8')) as object,
);

const USER = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const KEY = Buffer.alloc(32, 9);
const occ = (id: string, n: number) => importOccId(KEY, USER, id, n);
const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '20000000-0000-4000-8000-000000000002';
const S3 = '30000000-0000-4000-8000-000000000003';
const APP_A = 'a0000000-0000-4000-8000-00000000000a';
const APP_B = 'b0000000-0000-4000-8000-00000000000b';
const V = '2026-10-01T10:00:00.000000Z#0000000001#0123456789abcdef0123456789abcdef';
const SHOWN = { edited_at: '2026-10-01T05:00:00-05:00', tz: 'America/Chicago' };
const AT = { edited_at: '2026-09-09T00:00:00Z', tz: 'UTC' };

const up = (facetKey: string, payload: object): Facet => ({ facetKey, version: V, op: 'upsert', payload: JSON.stringify(payload) });
const gone = (facetKey: string): Facet => ({ facetKey, version: V, op: 'delete', payload: '' });

/** A copy the app made: its head and status, and optionally an origin. */
function appCopy(id: string, head: string, status: string | null, origin?: { native_id: string; ordinal: number }): Facet[] {
  return [
    up(`occ/${id}/head`, { head_id: head, ...SHOWN }),
    status === null ? gone(`occ/${id}/status`) : up(`occ/${id}/status`, { status, ...SHOWN }),
    ...(origin !== undefined ? [up(`occ/${id}/origin`, { site: 'mfc', ...origin })] : []),
  ];
}

function state(facets: Facet[] = [], extra: Partial<ImportState> = {}): ImportState {
  return {
    facets: new Map(facets.map((f) => [f.facetKey, f])),
    rowBases: new Map(),
    copyBases: new Map(),
    fieldBases: new Map(),
    items: new Map(),
    ...extra,
  };
}

const row = (id: string, head: string, kind: Row['kind'], count = 1, fields: Row['fields'] = {}): Row => ({ id, head, kind, count, fields });

function plan(st: ImportState, rows: Row[], over: Partial<PlanInput> = {}) {
  return planImport({ state: st, rows, keepIds: [], importNumber: 1, exportDate: '2026-09-09', occId: occ, ...over });
}

function sortedJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const keys = (p: ReturnType<typeof plan>) => p.writes.map((w) => `${w.op === 'delete' ? '-' : ''}${w.facetKey}`);

describe('planImport: a figure new to the import', () => {
  it('creates each copy MFC counts: origin, head and status, ordinals from 1, and writes the figure values', () => {
    const p = plan(state(), [row('119', S1, 'owned', 2, { score: 8, note: 'boxed' }), row('120', S2, 'wished', 1, { wishability: 4 })]);
    const [a, b, c] = [occ('119', 1), occ('119', 2), occ('120', 1)];
    expect(keys(p)).toEqual([
      `occ/${a}/origin`, `occ/${a}/head`, `occ/${a}/status`,
      `occ/${b}/origin`, `occ/${b}/head`, `occ/${b}/status`,
      `uf/${S1}/score`, `uf/${S1}/note`,
      `occ/${c}/origin`, `occ/${c}/head`, `occ/${c}/status`,
      `uf/${S2}/wishability`,
    ]);
    const payloads = new Map(p.writes.map((w) => [w.facetKey, w.payload]));
    expect(payloads.get(`occ/${b}/origin`)).toBe('{"site":"mfc","native_id":"119","ordinal":2}');
    expect(payloads.get(`occ/${a}/head`)).toBe(JSON.stringify({ head_id: S1, ...AT }));
    expect(payloads.get(`occ/${a}/status`)).toBe(JSON.stringify({ status: 'owned', ...AT }));
    expect(payloads.get(`uf/${S1}/score`)).toBe(JSON.stringify({ score: 8, ...AT }));
    expect(payloads.get(`uf/${S1}/note`)).toBe(JSON.stringify({ note: 'boxed', ...AT }));
    expect(payloads.get(`uf/${S2}/wishability`)).toBe(JSON.stringify({ wishability: 4, ...AT }));

    expect(p.stats).toEqual({ added: 2, unchanged: 0, occurrencesAdded: 3, conflictsRaised: 0 });
    expect(p.beyond).toEqual([]);
    expect(p.conflicted).toEqual([]);
    expect(p.figures).toEqual([S1, S2]);
    expect(p.rowBases).toEqual([row('119', S1, 'owned', 2, { score: 8, note: 'boxed' }), row('120', S2, 'wished', 1, { wishability: 4 })]);
    expect([...p.copyBases]).toEqual([
      [a, { head: S1, kind: 'owned' }],
      [b, { head: S1, kind: 'owned' }],
      [c, { head: S2, kind: 'wished' }],
    ]);
    expect(p.fieldBases).toEqual([
      { head: S1, field: 'score', value: 8 },
      { head: S1, field: 'note', value: 'boxed' },
      { head: S2, field: 'wishability', value: 4 },
    ]);
    expect(p.items).toEqual({ set: [], end: [] });
  });

  it('sums the rows of one figure, and gives each row its own copies', () => {
    const p = plan(state(), [row('9', S1, 'owned', 1, { score: 7 }), row('10', S1, 'owned', 1, { score: 7 }), row('11', S1, 'ordered')]);
    expect(keys(p).filter((k) => k.endsWith('/origin'))).toEqual([`occ/${occ('9', 1)}/origin`, `occ/${occ('10', 1)}/origin`, `occ/${occ('11', 1)}/origin`]);
    expect(keys(p).filter((k) => k.startsWith('uf/'))).toEqual([`uf/${S1}/score`]);
    expect(p.stats).toMatchObject({ added: 3, occurrencesAdded: 3 });
  });

  it('writes nothing for copies the app already has at MFC\'s counts, and takes them as MFC\'s', () => {
    const p = plan(state([...appCopy(APP_A, S1, 'owned'), ...appCopy(APP_B, S1, 'former')]), [row('119', S1, 'owned')]);
    expect(p.writes).toEqual([]);
    expect([...p.copyBases]).toEqual([
      [APP_A, { head: S1, kind: 'owned' }],
      [APP_B, { head: S1, kind: 'out' }],
    ]);
    expect(p.rowBases).toEqual([row('119', S1, 'owned')]);
    expect(p.stats).toEqual({ added: 1, unchanged: 0, occurrencesAdded: 0, conflictsRaised: 0 });
  });

  it('pairs the app\'s copies first and creates only the rest', () => {
    const p = plan(state(appCopy(APP_B, S1, 'owned')), [row('119', S1, 'owned', 2)]);
    expect(keys(p)).toEqual([`occ/${occ('119', 1)}/origin`, `occ/${occ('119', 1)}/head`, `occ/${occ('119', 1)}/status`]);
    expect([...p.copyBases]).toEqual([
      [APP_B, { head: S1, kind: 'owned' }],
      [occ('119', 1), { head: S1, kind: 'owned' }],
    ]);
  });

  it('leaves the app\'s extra copies alone and without a base', () => {
    const p = plan(state([...appCopy(APP_B, S1, 'owned'), ...appCopy(APP_A, S1, 'owned')]), [row('119', S1, 'owned')]);
    expect(p.writes).toEqual([]);
    expect([...p.copyBases]).toEqual([[APP_A, { head: S1, kind: 'owned' }]]);
  });

  it('counts a copy whose head was tombstoned as no copy of any figure', () => {
    const p = plan(state([gone(`occ/${APP_A}/head`), up(`occ/${APP_A}/status`, { status: 'owned', ...SHOWN })]), [row('119', S1, 'owned')]);
    expect(keys(p)).toEqual([`occ/${occ('119', 1)}/origin`, `occ/${occ('119', 1)}/head`, `occ/${occ('119', 1)}/status`]);
  });

  it('creates MFC\'s kind beside a copy of another kind, which it never touches', () => {
    const p = plan(state(appCopy(APP_A, S1, 'wished')), [row('119', S1, 'owned')]);
    expect(keys(p)).toEqual([`occ/${occ('119', 1)}/origin`, `occ/${occ('119', 1)}/head`, `occ/${occ('119', 1)}/status`]);
    expect(p.copyBases.has(APP_A)).toBe(false);
  });

  it('creates at the row\'s lowest unused ordinal, and counts the row\'s live copies of the kind', () => {
    const removed = appCopy(occ('119', 1), S1, null, { native_id: '119', ordinal: 1 });
    const kept = appCopy(occ('119', 3), S1, 'owned', { native_id: '119', ordinal: 3 });
    const p = plan(state([...removed, ...kept]), [row('119', S1, 'owned', 3)]);
    expect(keys(p).filter((k) => k.endsWith('/origin'))).toEqual([`occ/${occ('119', 2)}/origin`, `occ/${occ('119', 4)}/origin`]);
  });

  it('creates for the lowest-numbered row of the kind whose Count its copies do not fill', () => {
    const p = plan(state(appCopy(occ('9', 1), S1, 'owned', { native_id: '9', ordinal: 1 })), [row('10', S1, 'owned'), row('9', S1, 'owned')]);
    expect(keys(p).filter((k) => k.endsWith('/origin'))).toEqual([`occ/${occ('10', 1)}/origin`]);
  });

  it('does not count a row\'s copy of another kind against its Count', () => {
    const p = plan(state(appCopy(occ('5', 1), S1, 'wished', { native_id: '5', ordinal: 1 })), [row('5', S1, 'owned'), row('6', S1, 'wished')]);
    // M: owned 1, wished 1; A: wished 1 (a copy of row 5). Owned is created for row 5, at its next ordinal.
    expect(keys(p).filter((k) => k.endsWith('/origin'))).toEqual([`occ/${occ('5', 2)}/origin`]);
  });

  it('states a Count 0 row\'s figure values, and creates no copy for it', () => {
    const p = plan(state(), [row('119', S1, 'owned', 0, { score: 6 })]);
    expect(keys(p)).toEqual([`uf/${S1}/score`]);
    expect(p.rowBases).toEqual([row('119', S1, 'owned', 0, { score: 6 })]);
  });

  it('settles a row that states nothing new as nochange: nothing written, no copy base moved', () => {
    const p = plan(state(appCopy(APP_B, S1, 'former')), [row('119', S1, 'owned', 0)]);
    expect(p.writes).toEqual([]);
    expect(p.copyBases.size).toBe(0);
    expect(p.rowBases).toEqual([row('119', S1, 'owned', 0)]);
  });

  it('moves only the base when the app already shows MFC\'s value, and writes over a value the app removed', () => {
    const p = plan(state([up(`uf/${S1}/score`, { score: 7, ...SHOWN }), gone(`uf/${S1}/note`)]), [row('119', S1, 'owned', 0, { score: 7, note: 'n' })]);
    expect(keys(p)).toEqual([`uf/${S1}/note`]);
    expect(p.fieldBases).toEqual([
      { head: S1, field: 'score', value: 7 },
      { head: S1, field: 'note', value: 'n' },
    ]);
  });
});

describe('planImport: conflicts (GR-Q1: surfaced, never written over)', () => {
  it('writes nothing of a figure whose app value differs, raises one figure item, and leaves the bases', () => {
    const st = state([...appCopy(APP_A, S1, 'owned'), up(`uf/${S1}/score`, { score: 9, ...SHOWN })]);
    const p = plan(st, [row('119', S1, 'owned', 2, { score: 7, note: 'mfc' }), row('120', S2, 'owned')]);
    expect(keys(p)).toEqual([`imp/mfc/figure/${S1}`, `occ/${occ('120', 1)}/origin`, `occ/${occ('120', 1)}/head`, `occ/${occ('120', 1)}/status`]);
    expect(p.conflicted).toEqual([S1]);
    expect(p.rowBases.map((r) => r.id)).toEqual(['120']);
    expect([...p.copyBases.keys()]).toEqual([occ('120', 1)]);
    expect(p.fieldBases).toEqual([]);
    expect(p.stats).toEqual({ added: 2, unchanged: 0, occurrencesAdded: 1, conflictsRaised: 1 });

    const item = JSON.parse(p.writes[0]!.payload) as Record<string, unknown>;
    expect(figureSchema(item)).toBe(true);
    expect(item).toMatchObject({
      kind: 'conflict',
      import: 1,
      counts: { owned: { base: 0, app: 1, mfc: 2 }, ordered: { base: 0, app: 0, mfc: 0 }, wished: { base: 0, app: 0, mfc: 0 } },
      fields: { score: { status: 'conflict', app: 9, mfc: 7 }, note: { status: 'apply', mfc: 'mfc' }, wishability: { status: 'nochange' } },
      copies: [{ occ: APP_A, status: 'owned', tracked: false }],
      mfc_rows: [{ mfc_id: '119', kind: 'owned', count: 2 }],
    });
    expect(item['rev']).toMatch(/^i1\.[0-9a-f]{32}$/);
    const created = { occ: occ('119', 1), status: 'owned', head_id: S1, origin: { site: 'mfc', native_id: '119', ordinal: 1 } };
    const second = { ...created, occ: occ('119', 2), origin: { ...created.origin, ordinal: 2 } };
    // Each list in facet-key order, as the server would write it.
    expect(item['preview']).toEqual({
      keep: { copies: [created], fields: [{ head_id: S1, field: 'note', note: 'mfc' }] },
      take: {
        copies: [created, second].sort((a, b) => (a.occ < b.occ ? -1 : 1)),
        fields: [
          { head_id: S1, field: 'note', note: 'mfc' },
          { head_id: S1, field: 'score', score: 7 },
        ],
      },
    });
    expect(p.items.set).toEqual([{ head: S1, rev: item['rev'], raised: 1, side: expect.any(String), comps: expect.objectContaining({ score: 'conflict', note: 'apply' }) }]);
    // The payload is written with its keys sorted at every level, so an unchanged item is byte-identical.
    expect(p.writes[0]!.payload).toBe(sortedJson(item));
  });

  it('lists every pending item after the import, earlier ones of figures it did not decide included, in head order', () => {
    const earlier = plan(state([up(`uf/${S2}/score`, { score: 9, ...SHOWN })]), [row('120', S2, 'owned', 0, { score: 7 })]);
    const standing = earlier.items.set[0]!;
    const st = state(
      [up(`uf/${S1}/score`, { score: 9, ...SHOWN }), { facetKey: `imp/mfc/figure/${S2}`, version: V, op: 'upsert', payload: earlier.writes[0]!.payload }],
      { items: new Map([[S2, standing]]) },
    );
    const p = plan(st, [row('119', S1, 'owned', 0, { score: 7 })], { importNumber: 2 });
    expect(p.pending.map((i) => [i.head, i.rev])).toEqual([
      [S1, p.items.set[0]!.rev],
      [S2, standing.rev],
    ]);
    expect(p.pending[0]!.payload).toBe(p.writes[0]!.payload);
    expect(p.pending[1]!.payload).toBe(earlier.writes[0]!.payload);
  });

  it('lists no item whose answer naming it (res/mfc/{head}: figure, its rev) has synced, decided now or standing', () => {
    const earlier = plan(state([up(`uf/${S2}/score`, { score: 9, ...SHOWN })]), [row('120', S2, 'owned', 0, { score: 7 })]);
    const standing = earlier.items.set[0]!;
    const first = plan(state([up(`uf/${S1}/score`, { score: 9, ...SHOWN })]), [row('119', S1, 'owned', 0, { score: 7 })]);
    const raised = first.items.set[0]!;
    const items = new Map([
      [S1, raised],
      [S2, standing],
    ]);
    const facets = [
      up(`uf/${S1}/score`, { score: 9, ...SHOWN }),
      { facetKey: `imp/mfc/figure/${S1}`, version: V, op: 'upsert' as const, payload: first.writes[0]!.payload },
      { facetKey: `imp/mfc/figure/${S2}`, version: V, op: 'upsert' as const, payload: earlier.writes[0]!.payload },
    ];
    const answer = (head: string, item: string, rev: string) => up(`res/mfc/${head}`, { item, rev, choice: 'keep', ...SHOWN });
    const pendingWith = (answers: Facet[]) =>
      plan(state([...facets, ...answers], { items }), [row('119', S1, 'owned', 0, { score: 7 })], { importNumber: 2 }).pending.map((i) => i.head);

    expect(pendingWith([])).toEqual([S1, S2]);
    expect(pendingWith([answer(S1, 'figure', raised.rev), answer(S2, 'figure', standing.rev)])).toEqual([]);
    // Not an answer to the pending item: another rev, another item of the figure, or one taken back.
    expect(pendingWith([answer(S1, 'figure', 'i9.other'), answer(S2, 'held', standing.rev)])).toEqual([S1, S2]);
    expect(pendingWith([gone(`res/mfc/${S1}`), answer(`${S2}x`, 'figure', standing.rev)])).toEqual([S1, S2]);
  });

  it('counts an answer of any choice, and one naming the same MFC side from another import is not an answer to this rev', () => {
    const earlier = plan(state([up(`uf/${S2}/score`, { score: 9, ...SHOWN })]), [row('120', S2, 'owned', 0, { score: 7 })]);
    const standing = earlier.items.set[0]!;
    const first = plan(state([up(`uf/${S1}/score`, { score: 9, ...SHOWN })]), [row('119', S1, 'owned', 0, { score: 7 })]);
    const raised = first.items.set[0]!;
    const facets = [
      up(`uf/${S1}/score`, { score: 9, ...SHOWN }),
      { facetKey: `imp/mfc/figure/${S1}`, version: V, op: 'upsert' as const, payload: first.writes[0]!.payload },
      { facetKey: `imp/mfc/figure/${S2}`, version: V, op: 'upsert' as const, payload: earlier.writes[0]!.payload },
    ];
    const items = new Map([
      [S1, raised],
      [S2, standing],
    ]);
    const pendingWith = (answers: Facet[]) =>
      plan(state([...facets, ...answers], { items }), [row('119', S1, 'owned', 0, { score: 7 })], { importNumber: 2 }).pending.map((i) => i.head);
    const answer = (head: string, rev: string, body: object) => up(`res/mfc/${head}`, { item: 'figure', rev, ...body, ...SHOWN });

    expect(pendingWith([answer(S1, raised.rev, { choice: 'take' }), answer(S2, standing.rev, { choice: 'per_copy', copies: [] })])).toEqual([]);
    // The same MFC side raised by another import is another rev: the answer to it does not cover this one.
    const sameSide = (rev: string) => `i9.${rev.split('.')[1]}`;
    expect(pendingWith([answer(S1, sameSide(raised.rev), { choice: 'keep' }), answer(S2, sameSide(standing.rev), { choice: 'take' })])).toEqual([S1, S2]);
  });

  it('records with a conflict what it found of the counts: alike, matched with app-only copies, or MFC\'s alone', () => {
    const disputed = (copies: Facet[], count: number) =>
      plan(state([...copies, up(`uf/${S1}/score`, { score: 9, ...SHOWN })]), [row('119', S1, 'owned', count, { score: 7 })]).items.set[0]!.comps.counts;
    expect(disputed(appCopy(APP_A, S1, 'owned'), 1)).toBe('alike');
    expect(disputed([...appCopy(APP_A, S1, 'owned'), ...appCopy(APP_B, S1, 'owned')], 1)).toBe('matched+app-only');
    expect(disputed(appCopy(APP_A, S1, 'owned'), 2)).toBe('apply');
    expect(disputed([], 0)).toBe('nochange');
  });

  it('calls rows of one figure stating different values a conflict', () => {
    const p = plan(state(), [row('9', S1, 'owned', 1, { score: 7 }), row('10', S1, 'owned', 1, { score: 8 })]);
    expect(p.conflicted).toEqual([S1]);
    const item = JSON.parse(p.writes[0]!.payload) as { fields: { score: object }; preview: object };
    expect(figureSchema(item)).toBe(true);
    expect(item.fields.score).toEqual({ status: 'conflict', mfc: 7 });
    expect(keys(p)).toEqual([`imp/mfc/figure/${S1}`]);
  });

  it('keeps the rev and writes nothing when a later import finds the same conflict', () => {
    const rows = [row('119', S1, 'owned', 1, { score: 7 })];
    const st = state([up(`uf/${S1}/score`, { score: 9, ...SHOWN })]);
    const first = plan(st, rows);
    const raised = first.items.set[0]!;
    const again = plan(
      state([...st.facets.values(), { facetKey: `imp/mfc/figure/${S1}`, version: V, op: 'upsert', payload: first.writes[0]!.payload }], { items: new Map([[S1, raised]]) }),
      rows,
      { importNumber: 2 },
    );
    expect(again.writes).toEqual([]);
    expect(again.items).toEqual({ set: [raised], end: [] });
    expect(again.stats.conflictsRaised).toBe(0);
    expect(again.conflicted).toEqual([S1]);
  });

  it('gives a new rev when MFC\'s side changed, and rewrites the item', () => {
    const st = state([up(`uf/${S1}/score`, { score: 9, ...SHOWN })]);
    const first = plan(st, [row('119', S1, 'owned', 1, { score: 7 })]);
    const raised = first.items.set[0]!;
    const again = plan(
      state([...st.facets.values(), { facetKey: `imp/mfc/figure/${S1}`, version: V, op: 'upsert', payload: first.writes[0]!.payload }], { items: new Map([[S1, raised]]) }),
      [row('119', S1, 'owned', 1, { score: 6 })],
      { importNumber: 2 },
    );
    expect(keys(again)).toEqual([`imp/mfc/figure/${S1}`]);
    expect(again.items.set[0]!.rev).toMatch(/^i2\./);
    expect(again.stats.conflictsRaised).toBe(1);
  });

  it('keeps what the raising import found, and rewrites the item when the app\'s copies it shows have moved', () => {
    const rows = [row('119', S1, 'owned', 1, { score: 7 })];
    const st = state([up(`uf/${S1}/score`, { score: 9, ...SHOWN })]);
    const first = plan(st, rows);
    const raised = first.items.set[0]!;
    const stored = { facetKey: `imp/mfc/figure/${S1}`, version: V, op: 'upsert' as const, payload: first.writes[0]!.payload };
    // The app's score moved to 8: the rev carries the app's side as the raising import found it, so nothing changes.
    const moved = plan(state([up(`uf/${S1}/score`, { score: 8, ...SHOWN }), stored], { items: new Map([[S1, raised]]) }), rows, { importNumber: 2 });
    expect(moved.writes).toEqual([]);
    // The app filed the copy MFC counts: the counts and copies it shows, and the keep it previews, change; the rev stands.
    const filed = plan(state([...st.facets.values(), ...appCopy(APP_A, S1, 'owned'), stored], { items: new Map([[S1, raised]]) }), rows, { importNumber: 2 });
    expect(keys(filed)).toEqual([`imp/mfc/figure/${S1}`]);
    expect(filed.items.set[0]!.rev).toBe(raised.rev);
    const item = JSON.parse(filed.writes[0]!.payload) as Record<string, unknown>;
    expect(figureSchema(item)).toBe(true);
    expect(item).toMatchObject({
      import: 1,
      counts: { owned: { base: 0, app: 1, mfc: 1 } },
      fields: { score: { status: 'conflict', app: 9, mfc: 7 } },
      copies: [{ occ: APP_A, status: 'owned', tracked: false }],
      preview: { keep: { copies: [], fields: [] } },
    });
    expect(filed.stats.conflictsRaised).toBe(0);
  });

  it('previews keep from what the raising import found: no copy it did not find MFC\'s alone, no value it found disputed', () => {
    // Raised with the app's copy matching MFC's Count, and both values disputed.
    const rows = [row('119', S1, 'owned', 1, { score: 7, note: 'mfc' })];
    const raisedState = state([...appCopy(APP_A, S1, 'owned'), up(`uf/${S1}/score`, { score: 9, ...SHOWN }), up(`uf/${S1}/note`, { note: 'app', ...SHOWN })]);
    const first = plan(raisedState, rows);
    const raised = first.items.set[0]!;
    expect(raised.comps).toMatchObject({ counts: 'alike', score: 'conflict', note: 'conflict' });
    // Since: the app removed its copy and its score, so decided again both look like MFC's alone.
    const since = state(
      [...appCopy(APP_A, S1, null), gone(`uf/${S1}/score`), up(`uf/${S1}/note`, { note: 'app', ...SHOWN }), { facetKey: `imp/mfc/figure/${S1}`, version: V, op: 'upsert', payload: first.writes[0]!.payload }],
      { items: new Map([[S1, raised]]) },
    );
    const again = plan(since, rows, { importNumber: 2 });
    const item = JSON.parse(again.writes[0]!.payload) as { preview: { keep: object; take: { copies: unknown[]; fields: unknown[] } } };
    expect(item.preview.keep).toEqual({ copies: [], fields: [] });
    expect(item.preview.take.copies).toHaveLength(1);
    expect(item.preview.take.fields).toHaveLength(2);
  });

  it('ends the item when a later import finds the sides agreeing, and settles the figure', () => {
    const rows = [row('119', S1, 'owned', 0, { score: 7 })];
    const first = plan(state([up(`uf/${S1}/score`, { score: 9, ...SHOWN })]), rows);
    const raised = first.items.set[0]!;
    const again = plan(
      state([up(`uf/${S1}/score`, { score: 7, ...SHOWN }), { facetKey: `imp/mfc/figure/${S1}`, version: V, op: 'upsert', payload: first.writes[0]!.payload }], { items: new Map([[S1, raised]]) }),
      rows,
      { importNumber: 2 },
    );
    expect(keys(again)).toEqual([`-imp/mfc/figure/${S1}`]);
    expect(again.items).toEqual({ set: [], end: [S1] });
    expect(again.fieldBases).toEqual([{ head: S1, field: 'score', value: 7 }]);
  });

  it('shows a former copy by its status, and leaves out one that is removed or moved away', () => {
    const st = state([
      ...appCopy(APP_A, S1, 'former'),
      ...appCopy(APP_B, S1, null),
      up(`uf/${S1}/score`, { score: 9, ...SHOWN }),
    ], { copyBases: new Map([[occ('1', 1), { head: S1, kind: 'out' as const }]]) });
    const p = plan({ ...st, facets: new Map([...st.facets, [`occ/${occ('1', 1)}/head`, up(`occ/${occ('1', 1)}/head`, { head_id: S2, ...SHOWN })]]) }, [row('119', S1, 'wished', 1, { score: 7 })]);
    const item = JSON.parse(p.writes.find((w) => w.facetKey === `imp/mfc/figure/${S1}`)!.payload) as { copies: object[] };
    expect(item.copies).toEqual(
      [
        { occ: APP_A, status: 'former', tracked: false },
        { occ: APP_B, tracked: false },
        { occ: occ('1', 1), tracked: false },
      ].sort((a, b) => (a.occ < b.occ ? -1 : 1)),
    );
  });
});

describe('planImport: what an earlier import settled', () => {
  const settled = (rows: Row[], facets: Facet[] = []): ImportState => state(facets, { rowBases: new Map(rows.map((r) => [r.id, r])) });

  it('writes nothing and counts the rows unchanged when the export matches the row bases', () => {
    const rows = [row('119', S1, 'owned', 2, { score: 8 }), row('120', S1, 'wished')];
    const p = plan(settled(rows), rows, { importNumber: 2 });
    expect(p.writes).toEqual([]);
    expect(p.stats).toEqual({ added: 0, unchanged: 2, occurrencesAdded: 0, conflictsRaised: 0 });
    expect(p.figures).toEqual([S1]);
    expect(p.rowBases).toEqual([]);
    expect(p.beyond).toEqual([]);
  });

  it('lets a row unresolved for its Count or product stand on its row base', () => {
    const rows = [row('119', S1, 'owned'), row('120', S2, 'owned')];
    const p = plan(settled(rows), [rows[0]!], { importNumber: 2, keepIds: ['120', '999'] });
    expect(p.beyond).toEqual([]);
    // Only resolved rows are counted: added + moved + unchanged + kept_newer == resolved.
    expect(p.stats.unchanged).toBe(1);
    expect(p.figures).toEqual([S1, S2]);
  });

  it('names, as beyond 14a, every settled figure the export changes', () => {
    const base = [row('1', S1, 'owned'), row('2', S2, 'owned', 1, { note: 'x' }), row('3', S3, 'owned')];
    const cases: [string, Row[]][] = [
      ['a Count', [row('1', S1, 'owned', 2), base[1]!, base[2]!]],
      ['a kind', [row('1', S1, 'wished'), base[1]!, base[2]!]],
      ['a value', [base[0]!, row('2', S2, 'owned', 1, { note: 'y' }), base[2]!]],
      ['a dropped row', [base[0]!, base[1]!]],
      ['a new row of a settled figure', [...base, row('4', S1, 'owned')]],
    ];
    for (const [, rows] of cases) expect(plan(settled(base), rows).beyond.length).toBeGreaterThan(0);
    expect(plan(settled(base), cases[0]![1]).beyond).toEqual([S1]);
    expect(plan(settled(base), cases[3]![1]).beyond).toEqual([S3]);
    // a row the spine moved to another figure changes both
    expect(plan(settled(base), [base[0]!, base[1]!, row('3', S1, 'owned')]).beyond).toEqual([S1, S3]);
  });

  it('names a new figure whose copies already carry a base as beyond 14a', () => {
    const st = state(appCopy(APP_A, S1, 'owned'), { copyBases: new Map([[APP_A, { head: S1, kind: 'owned' as const }]]) });
    expect(plan(st, [row('119', S1, 'owned')]).beyond).toEqual([S1]);
  });
});

describe('planImport: the figures it settles, the only ones a late edit is held for in 14a', () => {
  it('settles a figure it writes to or moves a base of, not one it conflicts on, finds unchanged or leaves as it is', () => {
    const rows = [row('119', S1, 'owned'), row('120', S2, 'owned', 1, { score: 7 }), row('121', S3, 'wished', 0)];
    const first = plan(state([up(`uf/${S2}/score`, { score: 9, ...SHOWN })]), rows);
    expect(first.figures).toEqual([S1, S2, S3]);
    expect(first.conflicted).toEqual([S2]);
    // S3: Count 0 and no value, so nothing is written and no copy or field base moves.
    expect(first.settled).toEqual([S1]);
    const again = plan(state([], { rowBases: new Map(first.rowBases.map((r) => [r.id, r])) }), rows.filter((r) => r.head !== S2), { importNumber: 2 });
    expect(again.figures).toEqual([S1, S3]);
    expect(again.stats.unchanged).toBe(2);
    expect(again.settled).toEqual([]);
  });

  it('settles a figure whose only move is a base: the app already shows what MFC states', () => {
    const p = plan(state([...appCopy(APP_A, S1, 'owned'), up(`uf/${S2}/note`, { note: 'n', ...SHOWN })]), [row('119', S1, 'owned'), row('120', S2, 'wished', 0, { note: 'n' })]);
    expect(p.writes).toEqual([]);
    expect(p.settled).toEqual([S1, S2]);
  });
});

describe('planImport: what a conflict previews and lists, part by part', () => {
  it('previews keep with each field MFC alone changed once, when two fields apply beside a disputed one', () => {
    const p = plan(state([up(`uf/${S1}/score`, { score: 9, ...SHOWN })]), [row('119', S1, 'wished', 0, { score: 7, note: 'mfc', wishability: 3 })]);
    const item = JSON.parse(p.writes[0]!.payload) as { preview: { keep: { fields: unknown[] } } };
    expect(item.preview.keep.fields).toEqual([
      { head_id: S1, field: 'note', note: 'mfc' },
      { head_id: S1, field: 'wishability', wishability: 3 },
    ]);
  });

  it('reads the rows of one figure in numeric id order, however the export orders them', () => {
    const p = plan(state(), [row('20', S1, 'owned', 1, { score: 8 }), row('3', S1, 'owned', 1, { score: 7 })]);
    const item = JSON.parse(p.writes[0]!.payload) as { mfc_rows: { mfc_id: string }[]; preview: { take: { fields: unknown[] } } };
    expect(item.mfc_rows.map((r) => r.mfc_id)).toEqual(['3', '20']);
    // MFC's value is the first row's, in id order, that states one.
    expect(item.preview.take.fields).toEqual([{ head_id: S1, field: 'score', score: 7 }]);
  });
});
