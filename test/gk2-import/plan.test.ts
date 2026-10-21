import { describe, expect, it } from 'vitest';
import { PlanError, parsePlan } from '../../scripts/gk2-import/plan.js';

const NS = '7d0c1d9e-5a43-4c52-9d4f-6f2a4b8f1c07';
const HEAD = '3907070b-50f1-4f99-b912-6d63db4bf805';
const matched = { line: 'owned-3', kind: 'matched', status: 'owned', headId: HEAD, copies: 1, links: [], tags: [] };
const text = { line: 'owned-8', kind: 'text', status: 'owned', copies: 1, label: { name: 'Katfight' }, links: [], tags: [] };
const plan = (...entries: unknown[]) => ({ namespace: NS, entries });

describe('parsePlan', () => {
  it('reads a matched, a text and a parked entry', () => {
    const parked = { line: 'owned-19', kind: 'parked', status: 'owned', headId: HEAD, copies: 1, links: [], tags: [] };
    const read = parsePlan(plan(matched, text, parked));
    expect(read.namespace).toBe(NS);
    expect(read.entries.map((e) => [e.line, e.kind])).toEqual([['owned-3', 'matched'], ['owned-8', 'text'], ['owned-19', 'parked']]);
  });

  it('reads every optional part: a note, links, a collection, a disposal, tags, a full label', () => {
    const full = {
      ...text,
      status: 'former',
      label: { name: 'Katfight', maker: 'CBS Labs', series: 'x', scale: '1/4', edition: 'Silver Ed' },
      note: 'a note',
      links: ['https://a.example/1'],
      disposal: { reason: 'other', note: 'never received', counterparty: 'WK World' },
      tags: ['scammed'],
    };
    const [entry] = parsePlan(plan(full)).entries;
    expect(entry).toMatchObject({ note: 'a note', links: ['https://a.example/1'], tags: ['scammed'], disposal: { reason: 'other', counterparty: 'WK World' } });
    expect(entry!.label).toEqual({ name: 'Katfight', maker: 'CBS Labs', series: 'x', scale: '1/4', edition: 'Silver Ed' });
  });

  it.each([
    ['a plan that is not an object', 'x'],
    ['no namespace', { entries: [] }],
    ['a namespace that is not a uuid', { namespace: 'x', entries: [] }],
    ['an uppercase namespace', { namespace: NS.toUpperCase(), entries: [] }],
    ['entries that are not a list', { namespace: NS, entries: {} }],
    ['an unknown plan key', { namespace: NS, entries: [], extra: 1 }],
    ['an entry that is not an object', plan('x')],
    ['an unknown entry key', plan({ ...matched, extra: 1 })],
    ['a repeated line', plan(matched, matched)],
    ['a line with a space', plan({ ...matched, line: 'owned 3' })],
    ['an unknown kind', plan({ ...matched, kind: 'set' })],
    ['an unknown status', plan({ ...matched, status: 'wished' })],
    ['copies of 0', plan({ ...matched, copies: 0 })],
    ['copies of 100', plan({ ...matched, copies: 100 })],
    ['copies that are a fraction', plan({ ...matched, copies: 1.5 })],
    ['a matched entry with no head', plan({ ...matched, headId: undefined })],
    ['a matched entry with an uppercase head', plan({ ...matched, headId: HEAD.toUpperCase() })],
    ['a matched entry with a label', plan({ ...matched, label: { name: 'x' } })],
    ['a text entry with no label', plan({ ...text, label: undefined })],
    ['a text entry with a head', plan({ ...text, headId: HEAD })],
    ['a label with no name', plan({ ...text, label: { maker: 'x' } })],
    ['a label with an empty name', plan({ ...text, label: { name: '' } })],
    ['a label with an unknown key', plan({ ...text, label: { name: 'x', height_mm: 1 } })],
    ['a note that is not text', plan({ ...matched, note: 5 })],
    ['links that are not a list', plan({ ...matched, links: 'https://a.example' })],
    ['a link that is not text', plan({ ...matched, links: [5] })],
    ['eleven links', plan({ ...matched, links: Array.from({ length: 11 }, (_, i) => `https://a.example/${i}`) })],
    ['a collection on a former entry', plan({ ...matched, status: 'former', collection: 'Licensed PVCs' })],
    ['an empty collection name', plan({ ...matched, collection: '' })],
    ['a disposal on an owned entry', plan({ ...matched, disposal: { reason: 'sold' } })],
    ['a disposal with an unknown reason', plan({ ...matched, status: 'former', disposal: { reason: 'lent' } })],
    ['a disposal with an unknown key', plan({ ...matched, status: 'former', disposal: { reason: 'sold', price: 5 } })],
    ['tags that are not a list', plan({ ...matched, tags: 'x' })],
    ['an empty tag', plan({ ...matched, tags: [''] })],
  ])('refuses %s', (_why, value) => {
    expect(() => parsePlan(value)).toThrow(PlanError);
  });

  it('says which entry is wrong', () => {
    expect(() => parsePlan(plan(matched, { ...text, copies: 0 }))).toThrow(/owned-8/);
  });
});
