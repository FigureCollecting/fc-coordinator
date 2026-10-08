// WK-14b: the re-import diff (import.proto THE FIGURE DECISION, MATCHING, MATERIALIZE, FILING) as a
// pure function, against the contract's own golden cases (golden/import-vectors.json `reimports`):
// one import onto a seeded server, and the copies, figure values, keys written, figures carded and
// unresolved rows after it. A spine merge or a row the spine moved to another figure is not decided
// here: the plan names those figures in `beyond` and the import refuses them before it writes.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { Facet } from '../sync/store.js';
import { planImport, type CopyBase, type ImportState, type Row } from './plan.js';
import { readExport, type Field } from './rows.js';

const require = createRequire(import.meta.url);

interface VCopy {
  occ: string;
  origin?: { id: string; ordinal: number };
  head: string;
  status: string | null;
  filing?: string;
  base?: { head: string; status: string | null };
}
interface VField {
  value: number | string | null;
  base: number | string | null;
}
interface Vector {
  name: string;
  survivors?: Record<string, string>;
  copies: VCopy[];
  figures?: Record<string, Partial<Record<Field, VField>>>;
  export: { line: number; id: string; head: string | null; status: string; count: string; score?: number; note?: string; wishability?: number }[];
  expect: {
    copies: VCopy[];
    figures: Record<string, Partial<Record<Field, VField>>>;
    writes: string[];
    conflicts: string[];
    unresolved: { line: number; reason: string }[];
  };
}

const vectors = (
  JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/golden/import-vectors.json'), 'utf8')) as { reimports: Vector[] }
).reimports;

/** A name as a uuid that sorts as the name does: "occ ids order by their names". */
const uuidOf = (name: string): string => {
  const hex = Buffer.from(name, 'utf8').toString('hex').padEnd(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
const nameOf = (uuid: string): string => Buffer.from(uuid.replace(/-/g, '').replace(/(00)+$/, ''), 'hex').toString('utf8');
/** The vectors name a copy the import creates new:k for row 1144, new{row}:k for any other. */
const occId = (id: string, ordinal: number): string => uuidOf(id === '1144' ? `new:${ordinal}` : `new${id}:${ordinal}`);
const V = '2026-09-01T00:00:00.000000Z#0000000001#00000000000000000000000000000000';
const SHOWN = { edited_at: '2026-09-01T00:00:00Z', tz: 'UTC' };
const OUT = 'out';

function seed(v: Vector): { state: ImportState; rows: Row[]; keepIds: string[]; unresolved: { line: number; reason: string }[] } {
  const facets = new Map<string, Facet>();
  const put = (facetKey: string, value: object | null) =>
    facets.set(facetKey, value === null ? { facetKey, version: V, op: 'delete', payload: '' } : { facetKey, version: V, op: 'upsert', payload: JSON.stringify(value) });
  const copyBases = new Map<string, CopyBase>();
  const rowBases = new Map<string, Row>();
  for (const c of v.copies) {
    const occ = uuidOf(c.occ);
    put(`occ/${occ}/head`, { head_id: uuidOf(c.head), ...SHOWN });
    put(`occ/${occ}/status`, c.status === null ? null : { status: c.status, ...SHOWN });
    if (c.origin) put(`occ/${occ}/origin`, { site: 'mfc', native_id: c.origin.id, ordinal: c.origin.ordinal });
    if (c.filing) put(`occ/${occ}/collection`, { collection: c.filing, ...SHOWN });
    if (c.base) {
      // A removed copy whose base is out and that has an origin is one an import removed: the
      // only way the import's own bookkeeping leaves a copy so (MATERIALIZE).
      const removed = c.status === null && c.base.status === null && c.origin !== undefined;
      copyBases.set(occ, { head: uuidOf(c.base.head), kind: (c.base.status ?? OUT) as CopyBase['kind'], removed });
      // ROW BASE: what the last import took for the row, its Count the copies it based on it.
      if (c.origin && c.base.status !== null) {
        const r = rowBases.get(c.origin.id);
        rowBases.set(c.origin.id, { id: c.origin.id, head: uuidOf(c.base.head), kind: c.base.status as Row['kind'], count: (r?.count ?? 0) + 1, fields: {} });
      }
    }
  }
  const fieldBases = new Map<string, Map<Field, number | string | null>>();
  for (const [head, fields] of Object.entries(v.figures ?? {})) {
    for (const [f, value] of Object.entries(fields) as [Field, VField][]) {
      put(`uf/${uuidOf(head)}/${f}`, value.value === null ? null : { [f]: value.value, ...SHOWN });
      fieldBases.set(uuidOf(head), (fieldBases.get(uuidOf(head)) ?? new Map()).set(f, value.base));
      // The row base of the figure's row states the value the field base holds.
      for (const r of rowBases.values()) if (r.head === uuidOf(head) && value.base !== null) r.fields = { ...r.fields, [f]: value.base };
    }
  }
  // The export, read as ImportMfcExport reads it, and resolved against the vector's heads.
  const csv = ['ID,Status,Count,Score,Note,Wishability', ...v.export.map((r) => [r.id, r.status, r.count, r.score === undefined ? '' : `${r.score}/10`, r.note ?? '', r.wishability ?? ''].join(','))].join('\n');
  const read = readExport(csv);
  const headOf = new Map(v.export.map((r) => [r.line, r.head]));
  const rows: Row[] = [];
  const unresolved: { line: number; reason: string }[] = [];
  const keepIds: string[] = [];
  for (const r of read) {
    const head = headOf.get(r.line);
    const reason = r.reason ?? (head === null ? 'no_product' : undefined);
    if (reason !== undefined) {
      unresolved.push({ line: r.line, reason });
      if (reason !== 'invalid_id' && reason !== 'duplicate_id') keepIds.push(r.id!);
    } else rows.push({ id: r.id!, head: uuidOf(head!), kind: r.kind, count: r.count!, fields: r.fields });
  }
  return { state: { facets, rowBases, copyBases, fieldBases, items: new Map(), kept: new Map() }, rows, keepIds, unresolved };
}

function run(v: Vector) {
  const { state, rows, keepIds, unresolved } = seed(v);
  const plan = planImport({ state, rows, keepIds, importNumber: 2, exportDate: '2026-09-09', occId });
  const facets = new Map(state.facets);
  for (const w of plan.writes) facets.set(w.facetKey, { facetKey: w.facetKey, version: V, op: w.op, payload: w.payload });
  const bases = new Map(state.copyBases);
  for (const [occ, b] of plan.copyBases) bases.set(occ, b);
  const fieldBases = new Map([...state.fieldBases].map(([h, m]) => [h, new Map(m)]));
  for (const f of plan.fieldBases) fieldBases.set(f.head, (fieldBases.get(f.head) ?? new Map()).set(f.field, f.value));
  const value = (key: string) => {
    const f = facets.get(key);
    return f === undefined || f.op === 'delete' ? null : (JSON.parse(f.payload) as Record<string, unknown>);
  };
  const occs = [...new Set([...facets.keys()].flatMap((k) => /^occ\/([^/]+)\/head$/.exec(k)?.slice(1) ?? []))].sort();
  const copies = occs.map((occ) => {
    const origin = value(`occ/${occ}/origin`) as { native_id: string; ordinal: number } | null;
    const filing = value(`occ/${occ}/collection`)?.['collection'] as string | undefined;
    const base = bases.get(occ);
    return {
      occ: nameOf(occ),
      ...(origin ? { origin: { id: origin.native_id, ordinal: origin.ordinal } } : {}),
      head: nameOf(value(`occ/${occ}/head`)!['head_id'] as string),
      status: (value(`occ/${occ}/status`)?.['status'] as string | undefined) ?? null,
      ...(filing ? { filing } : {}),
      ...(base ? { base: { head: nameOf(base.head), status: base.kind === OUT ? null : base.kind } } : {}),
    };
  });
  const figures = (wanted: Vector['expect']['figures']) =>
    Object.fromEntries(
      Object.entries(wanted).map(([head, fields]) => [
        head,
        Object.fromEntries(
          Object.keys(fields).map((f) => [
            f,
            { value: (value(`uf/${uuidOf(head)}/${f}`)?.[f] as number | string | undefined) ?? null, base: fieldBases.get(uuidOf(head))?.get(f as Field) ?? null },
          ]),
        ),
      ]),
    );
  const written = plan.writes
    .filter((w) => !w.facetKey.startsWith('imp/'))
    .map((w) => w.facetKey.replace(/^(occ|uf)\/([^/]+)/, (_m, family: string, id: string) => `${family}/${nameOf(id)}`))
    .sort();
  return { plan, copies, figures, written, unresolved };
}

const spineMoved = (v: Vector) => v.survivors !== undefined || v.name.startsWith('the spine now resolves the id to another figure');
const decided = vectors.filter((v) => !spineMoved(v));

describe('the contract\'s re-import vectors (golden/import-vectors.json reimports)', () => {
  it('has the 33 cases this build was written against, 25 of them decided here', () => {
    expect(vectors).toHaveLength(33);
    expect(decided).toHaveLength(25);
  });

  it.each(decided.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const r = run(v);
    expect(r.plan.beyond).toEqual([]);
    expect(r.written).toEqual([...v.expect.writes].sort());
    expect(r.plan.items.set.map((i) => nameOf(i.head))).toEqual(v.expect.conflicts);
    expect(r.unresolved).toEqual(v.expect.unresolved);
    expect(r.copies).toEqual([...v.expect.copies].sort((a, b) => Number(uuidOf(a.occ) > uuidOf(b.occ)) - Number(uuidOf(a.occ) < uuidOf(b.occ))));
    expect(r.figures(v.expect.figures)).toEqual(v.expect.figures);
  });

  it.each(vectors.filter(spineMoved).map((v) => [v.name, v] as const))('refuses, as beyond this build, a spine merge or move: %s', (_name, v) => {
    const r = run(v);
    expect(r.plan.beyond.length).toBeGreaterThan(0);
  });
});
