// import.proto FULL DISCREPANCY REPORT, as a pure function: per figure and kind, the live copies
// beyond the latest export's Counts, those whose row the export lacks or lists at Count 0 first.
import { describe, expect, it } from 'vitest';
import type { Facet } from '../sync/store.js';
import { View, type Row } from './figure.js';
import { discrepancies } from './report.js';

const S1 = '10000000-0000-4000-8000-000000000001';
const S2 = '20000000-0000-4000-8000-000000000002';
const [A, B, C, D, E] = ['0a', '0b', '0c', '0d', '0e'].map((p) => `${p}000000-0000-4000-8000-000000000000`) as [string, string, string, string, string];
const V = '2026-10-01T10:00:00.000000Z#0000000001#0123456789abcdef0123456789abcdef';
const SHOWN = { edited_at: '2026-10-01T05:00:00-05:00', tz: 'America/Chicago' };
const up = (facetKey: string, payload: object): Facet => ({ facetKey, version: V, op: 'upsert', payload: JSON.stringify(payload) });

function copy(occ: string, head: string | null, status: string, origin?: string): Facet[] {
  return [
    ...(head !== null ? [up(`occ/${occ}/head`, { head_id: head, ...SHOWN })] : []),
    up(`occ/${occ}/status`, { status, ...SHOWN }),
    ...(origin !== undefined ? [up(`occ/${occ}/origin`, { site: 'mfc', native_id: origin, ordinal: 1 })] : []),
  ];
}
const view = (facets: Facet[]) => new View({ facets: new Map(facets.map((f) => [f.facetKey, f])), rowBases: new Map(), copyBases: new Map(), fieldBases: new Map() });
const row = (id: string, head: string, kind: Row['kind'], count: number): Row => ({ id, head, kind, count, fields: {} });

describe('discrepancies', () => {
  it('lists, per figure and kind, as many copies as the export cannot account for, a copy whose row it lacks or lists at 0 first', () => {
    const v = view([
      ...copy(A, S1, 'owned', '1'),
      ...copy(B, S1, 'owned', '2'),
      ...copy(C, S1, 'owned', '3'),
      ...copy(D, S1, 'wished'),
      ...copy(E, S2, 'owned'),
    ]);
    const rows = [row('1', S1, 'owned', 1), row('2', S1, 'owned', 0)];
    expect(discrepancies(v, rows, new Map([[C, { head: S1, kind: 'owned' }]]))).toEqual([
      // Row 2 is at Count 0 and row 3 is not in the export: their copies are named first.
      { head: S1, kind: 'owned', app: 3, mfc: 1, copies: [B, C], kept: [C] },
      { head: S1, kind: 'wished', app: 1, mfc: 0, copies: [D], kept: [] },
      { head: S2, kind: 'owned', app: 1, mfc: 0, copies: [E], kept: [] },
    ]);
  });

  it('counts a copy MFC has come to count on another row, and lists nothing for a figure the export accounts for', () => {
    const v = view([...copy(A, S1, 'owned', '1'), ...copy(B, S1, 'owned', '2'), ...copy(C, null, 'owned')]);
    expect(discrepancies(v, [row('1', S1, 'owned', 0), row('3', S1, 'owned', 2)], new Map([[B, { head: S1, kind: 'owned' }]]))).toEqual([]);
  });

  it('names the copies beyond the Counts by occ id when every row is listed', () => {
    const v = view([...copy(B, S1, 'owned', '1'), ...copy(A, S1, 'owned', '1')]);
    expect(discrepancies(v, [row('1', S1, 'owned', 1)], new Map([[B, { head: S1, kind: 'wished' }]]))).toEqual([
      { head: S1, kind: 'owned', app: 2, mfc: 1, copies: [A], kept: [] },
    ]);
  });
});
