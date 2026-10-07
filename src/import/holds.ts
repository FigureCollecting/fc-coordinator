// import.proto HELD, as WK-14a can honour it. A LATE EDIT is a pushed edit to a copy or a figure
// value of a figure S whose basis is before the marker of an import that decided S: its device
// made it without having seen that import. The contract replays such an edit before the import
// and holds it only in the cases HELD (i) to (iv) list; 14a has no replay, so it holds every late
// edit instead of letting LWW drop it as STALE or write it over the import's decision. A held
// edit is kept with its basis (held_edit) and answered HELD with `current`; the held-edit card,
// its answers and the replay are WK-14b's. An edit to a figure no import decided, or one made
// after its device applied the import (basis at or past the marker), is placed by LWW as ever.
//
// Held per UNIT: one push's edits to one copy's head, status, collection and disposal are one
// unit; every other edit is a unit with the push's other edits of its key.
import { parseUserFacetKey } from '@figurecollecting/fc-api-contract';
import type { HoldPolicy } from '../sync/service.js';

const COPY_UNIT = new Set(['occ/head', 'occ/status', 'occ/collection', 'occ/disposal']);

/** A head payload's head_id: every one stored or pushed has passed occ-head.schema.json. */
const headOf = (payload: string): string => (JSON.parse(payload) as { head_id: string }).head_id;

export const holdLateForImport: HoldPolicy = async (tx, userId, edits) => {
  const held = new Set<number>();
  const { rows: last } = await tx.query<{ seq: string | null }>('SELECT max(marker_seq) AS seq FROM import_run WHERE user_id = $1', [userId]);
  if (last[0]!.seq === null) return held;
  const lastMarker = BigInt(last[0]!.seq);

  // What each edit touches: its unit, and the figure (a copy's head: as this push writes it, else as stored).
  const touched = edits.map((e) => {
    const key = parseUserFacetKey(e.facetKey)!;
    if (key.family.startsWith('uf/')) return { e, unit: e.facetKey, head: (key as { headId: string }).headId, occ: null };
    if (key.family.startsWith('occ/')) {
      const occ = (key as { occId: string }).occId;
      return { e, unit: COPY_UNIT.has(key.family) ? `occ/${occ}` : e.facetKey, head: null as string | null, occ };
    }
    return { e, unit: e.facetKey, head: null as string | null, occ: null };
  });
  const candidates = touched.filter((t) => (t.head !== null || t.occ !== null) && t.e.basisSeq < lastMarker);
  if (candidates.length === 0) return held;

  // A copy's head as this push writes it, else as stored; a copy with neither belongs to no figure.
  const copyHeads = new Map<string, string>();
  for (const e of edits) {
    const m = /^occ\/([^/]+)\/head$/.exec(e.facetKey);
    if (m !== null && e.op === 'upsert') copyHeads.set(m[1]!, headOf(e.payload));
  }
  const { rows: stored } = await tx.query<{ facet_key: string; payload: string }>(
    "SELECT facet_key, payload FROM facet_state WHERE user_id = $1 AND facet_key = ANY($2::text[]) AND op = 'upsert'",
    [userId, candidates.flatMap((t) => (t.occ !== null && !copyHeads.has(t.occ) ? [`occ/${t.occ}/head`] : []))],
  );
  for (const r of stored) copyHeads.set(r.facet_key.split('/')[1]!, headOf(r.payload));
  const placed = candidates.flatMap((t) => {
    const head = t.head ?? copyHeads.get(t.occ!);
    return head === undefined ? [] : [{ ...t, head }];
  });
  const heads = [...new Set(placed.map((t) => t.head))];

  const { rows: frames } = await tx.query<{ head_id: string; seq: string }>(
    `SELECT f.head_id, max(r.marker_seq) AS seq FROM import_frame f
       JOIN import_run r ON r.user_id = f.user_id AND r.import_number = f.import_number
      WHERE f.user_id = $1 AND f.head_id = ANY($2::uuid[]) GROUP BY f.head_id`,
    [userId, heads],
  );
  const framedAt = new Map(frames.map((f) => [f.head_id, BigInt(f.seq)]));
  const lateUnits = new Set<string>();
  for (const t of placed) {
    const marker = framedAt.get(t.head);
    if (marker !== undefined && t.e.basisSeq < marker) lateUnits.add(t.unit);
  }
  for (const t of touched) if (lateUnits.has(t.unit)) held.add(t.e.index);
  return held;
};

