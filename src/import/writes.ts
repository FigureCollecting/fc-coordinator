// An Effect on figure S as the facet writes that carry it (sync.proto rule 6), in the order they
// land, and as the copies and fields a change entry, its undo, and an item's preview list
// (schemas/imp-change.schema.json, imp-figure.schema.json `preview`). FILING: whenever a status is
// upserted to a kind its filing is not of, the filing is written {status}/default beside it.
import { bytewise, FIELDS, type Effect, type Value, type View } from './figure.js';
import type { Field } from './rows.js';

export interface Write {
  facetKey: string;
  op: 'upsert' | 'delete';
  /** JSON text; '' for a tombstone. */
  payload: string;
}

export interface CopyEntry {
  occ: string;
  /** The kind, former, or "removed" for a tombstone. */
  status?: string;
  head_id?: string;
  collection?: string;
  origin?: { site: 'mfc'; native_id: string; ordinal: number };
}

export type FieldEntry = { head_id: string; field: Field } & Partial<Record<Field, Value>>;

export interface Listed {
  copies: CopyEntry[];
  fields: FieldEntry[];
}

export interface Rendered {
  writes: Write[];
  /** What the writes are, as a change entry lists them. */
  done: Listed;
  /** What undo would write: each facet back at its value before. */
  undo: Listed;
  counts: { added: number; statusChanged: number; removed: number };
}

/** The display stamp a user-facet write carries. */
export interface Shown {
  edited_at: string;
  tz: string;
}

const kindOf = (collection: string): string => collection.slice(0, collection.indexOf('/'));
const fieldEntry = (S: string, f: Field, value: Value | null): FieldEntry => ({ head_id: S, field: f, ...(value !== null ? { [f]: value } : {}) });

export function render(v: View, S: string, e: Effect, shown: Shown): Rendered {
  const out: Rendered = { writes: [], done: { copies: [], fields: [] }, undo: { copies: [], fields: [] }, counts: { added: 0, statusChanged: 0, removed: 0 } };
  const upsert = (facetKey: string, body: object) => out.writes.push({ facetKey, op: 'upsert', payload: JSON.stringify({ ...body, ...shown }) });

  for (const occ of [...e.statuses.keys()].sort(bytewise)) {
    const status = e.statuses.get(occ)!;
    const copy = v.copies.get(occ)!;
    const before = copy.status ?? 'removed';
    if (status === null) {
      out.writes.push({ facetKey: `occ/${occ}/status`, op: 'delete', payload: '' });
      out.done.copies.push({ occ, status: 'removed' });
      out.undo.copies.push({ occ, status: before });
      out.counts.removed += 1;
      continue;
    }
    const refile = copy.collection !== null && kindOf(copy.collection) !== status;
    if (refile) upsert(`occ/${occ}/collection`, { collection: `${status}/default` });
    upsert(`occ/${occ}/status`, { status });
    out.done.copies.push({ occ, status, ...(refile ? { collection: `${status}/default` } : {}) });
    out.undo.copies.push({ occ, status: before, ...(refile ? { collection: copy.collection! } : {}) });
    if (copy.status === null) out.counts.added += 1;
    else out.counts.statusChanged += 1;
  }
  for (const c of e.created) {
    const origin = { site: 'mfc' as const, native_id: c.id, ordinal: c.ordinal };
    // The origin is server-owned and carries no display time.
    out.writes.push({ facetKey: `occ/${c.occ}/origin`, op: 'upsert', payload: JSON.stringify(origin) });
    upsert(`occ/${c.occ}/head`, { head_id: c.head });
    upsert(`occ/${c.occ}/status`, { status: c.kind });
    out.done.copies.push({ occ: c.occ, status: c.kind, head_id: c.head, origin });
    // A copy the import created keeps its origin and head on undo; only its status goes.
    out.undo.copies.push({ occ: c.occ, status: 'removed' });
    out.counts.added += 1;
  }
  for (const f of FIELDS) {
    if (!e.fields.has(f)) continue;
    const value = e.fields.get(f)!;
    if (value === null) out.writes.push({ facetKey: `uf/${S}/${f}`, op: 'delete', payload: '' });
    else upsert(`uf/${S}/${f}`, { [f]: value });
    out.done.fields.push(fieldEntry(S, f, value));
    out.undo.fields.push(fieldEntry(S, f, v.field(S, f)));
  }
  out.done.copies.sort((a, b) => bytewise(a.occ, b.occ));
  out.undo.copies.sort((a, b) => bytewise(a.occ, b.occ));
  return out;
}
