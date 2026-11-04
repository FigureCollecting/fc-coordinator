// The plan guard's registry (PLAN.md U12c): one entry per statement shape the service sends, each
// with the kind that decides how it is explained and, for a read, its buffer bound. A statement with
// no entry fails the guard, so a new query is registered (and so bounded) in the PR that adds it.
// An allowance is a known excess with an owner and an expiry date; it lives here, never in the checker.
import type { GuardEntry } from './helpers/planGuard.js';

const read = (id: string, match: RegExp, buffers?: GuardEntry['buffers'], allow?: GuardEntry['allow']): GuardEntry => ({
  id,
  match,
  kind: 'read',
  ...(buffers !== undefined ? { buffers } : {}),
  ...(allow !== undefined ? { allow } : {}),
});
const write = (id: string, match: RegExp): GuardEntry => ({ id, match, kind: 'write' });

export const REGISTRY: GuardEntry[] = [
  // ── control: transaction boundaries, locks, settings, clocks ────────────────────────────────
  { id: 'tx', match: /^(BEGIN|COMMIT|ROLLBACK)$/, kind: 'control' },
  { id: 'store.boundLockWaits', match: /^SELECT set_config\('lock_timeout', \$1, true\)$/, kind: 'control' },
  { id: 'store.lockUser', match: /^SELECT pg_advisory_xact_lock\(\$1, hashtext\(\$2\)\)$/, kind: 'control' },
  { id: 'store.serverNow', match: /^SELECT to_json\(clock_timestamp\(\)\) #>> '\{\}' AS now$/, kind: 'control' },
  { id: 'pool.probe', match: /^SELECT 1$/, kind: 'control' },

  // ── identity and devices (src/db/devices.ts) ────────────────────────────────────────────────
  write('devices.ensureAppUser.insert', /^INSERT INTO app_user \(id\) VALUES \(\$1\) ON CONFLICT \(id\) DO NOTHING RETURNING id$/),
  read('devices.ensureAppUser.read', /^SELECT deleted_at FROM app_user WHERE id = \$1$/),
  write('devices.enrollDevice.insert', /^INSERT INTO device \(id, user_id, label, jkt, jwk\) VALUES/),
  read('devices.findLiveDevice', /^SELECT d\.id, d\.jkt FROM device d JOIN app_user u ON u\.id = d\.user_id WHERE d\.user_id = \$1 AND d\.jkt = \$2/),

  // ── sync (src/sync/store.ts) ────────────────────────────────────────────────────────────────
  read('store.readFacet', /^SELECT facet_key, version, op, payload FROM facet_state WHERE user_id = \$1 AND facet_key = \$2( FOR UPDATE)?$/),
  write('store.applyEvent', /^WITH fed AS \( INSERT INTO feed_event \(user_id, facet_key, version, op, payload, opens_txn\) VALUES/),
  write('store.keepHeld', /^INSERT INTO held_edit \(user_id, client_id, ordinal, facet_key, version, op, payload, basis_seq\) VALUES/),
  // Delta's page: the deep cursor of a whale reads its own rows only (C-6 is U11's).
  read('store.readFeed', /^SELECT seq, facet_key, version, op, payload, opens_txn FROM feed_event WHERE user_id = \$1 AND seq > \$2 ORDER BY seq LIMIT \$3$/),
  read('store.feedHead', /^SELECT coalesce\(max\(seq\), 0\) AS head FROM feed_event WHERE user_id = \$1$/),
  read('store.issuedHead', /^SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS head FROM feed_event_seq$/),
  write('store.recordCursor', /^INSERT INTO feed_cursor \(user_id, device_id, acked_seq, delivered_seq\) VALUES/),
  read('store.readReceipt', /^SELECT request_sha256, outcomes FROM mutation_receipt WHERE user_id = \$1 AND client_id = \$2$/),
  write('store.writeReceipt', /^INSERT INTO mutation_receipt \(user_id, client_id, request_sha256, outcomes\) VALUES/),

  // ── import state and writes (src/import/store.ts) ───────────────────────────────────────────
  // The import reads the user's whole state: rows returned are the work, a few buffers each.
  read('importStore.readImportState.facets', /^SELECT facet_key, version, op, payload FROM facet_state WHERE user_id = \$1 AND \(facet_key LIKE 'occ\/%' OR/),
  read('importStore.rowBases', /^SELECT mfc_id, head_id, kind, count, fields FROM import_row_base WHERE user_id = \$1( AND head_id = \$2)?$/),
  read('importStore.copyBases', /^SELECT occ_id, head_id, kind, import_removed FROM import_copy_base WHERE user_id = \$1( AND occ_id = ANY\(\$2::uuid\[\]\))?$/),
  read('importStore.fieldBases', /^SELECT head_id, field, value FROM import_field_base WHERE user_id = \$1( AND head_id = \$2)?$/),
  read('importStore.items', /^SELECT head_id, rev, raised_import, side, comps FROM import_figure_item WHERE user_id = \$1( AND head_id = \$2)?$/),
  read('importStore.kept', /^SELECT occ_id, head_id, kind FROM import_kept_copy WHERE user_id = \$1( AND head_id = \$2)?$/),
  read('importStore.readFigureState.facets', /^SELECT facet_key, version, op, payload FROM facet_state WHERE user_id = \$1 AND facet_key = ANY\(\$2::text\[\]\)$/),
  // figureOccs (C-2): the copies of S by head, by origin, by base.
  read('importStore.figureOccs', /^SELECT split_part\(facet_key, '\/', 2\) AS occ FROM facet_state WHERE user_id = \$1 AND /),
  read('importStore.lastImportNumber', /^SELECT coalesce\(max\(import_number\), 0\) AS n FROM import_run WHERE user_id = \$1$/),
  write('importStore.recordRun', /^INSERT INTO import_run \(user_id, import_number, export_date, version, marker_seq\) VALUES/),
  write('importStore.recordFrames', /^INSERT INTO import_frame \(user_id, import_number, head_id, settled, before\) SELECT/),
  write('importStore.saveBases.rows', /^INSERT INTO import_row_base \(user_id, mfc_id, head_id, kind, count, fields, import_number\) SELECT/),
  write('importStore.saveBases.rowsGone', /^DELETE FROM import_row_base WHERE user_id = \$1 AND mfc_id = ANY\(\$2::text\[\]\)$/),
  write('importStore.saveBases.copies', /^INSERT INTO import_copy_base \(user_id, occ_id, head_id, kind, import_removed\) SELECT/),
  write('importStore.saveBases.copiesGone', /^DELETE FROM import_copy_base WHERE user_id = \$1 AND occ_id = ANY\(\$2::uuid\[\]\)$/),
  write('importStore.saveBases.fields', /^INSERT INTO import_field_base \(user_id, head_id, field, value\) SELECT/),
  write('importStore.saveBases.items', /^INSERT INTO import_figure_item \(user_id, head_id, rev, raised_import, side, comps\) VALUES/),
  write('importStore.saveBases.itemsEnd', /^DELETE FROM import_figure_item WHERE user_id = \$1 AND head_id = ANY\(\$2::uuid\[\]\)$/),
  write('importStore.saveKept.add', /^INSERT INTO import_kept_copy \(user_id, occ_id, head_id, kind\)/),
  write('importStore.saveKept.gone', /^DELETE FROM import_kept_copy WHERE user_id = \$1 AND occ_id = ANY\(\$2::uuid\[\]\)$/),
  write('importStore.saveExportRows.clear', /^DELETE FROM import_export_row WHERE user_id = \$1$/),
  write('importStore.saveExportRows.insert', /^INSERT INTO import_export_row \(user_id, mfc_id, head_id, kind, count\) SELECT/),
  // X-2: counts every held edit ever (a product question on the desk, not a DB fix).
  read('importStore.pendingReview', /^SELECT \(SELECT count\(\*\) FROM import_figure_item WHERE user_id = \$1\) \+ \(SELECT count\(\*\) FROM held_edit WHERE user_id = \$1\) AS n$/),

  // ── late edits (src/import/holds.ts) ────────────────────────────────────────────────────────
  read('holds.lastMarker', /^SELECT max\(marker_seq\) AS seq FROM import_run WHERE user_id = \$1$/),
  read('holds.placeOnFigures', /^SELECT facet_key, payload FROM facet_state WHERE user_id = \$1 AND facet_key = ANY\(\$2::text\[\]\) AND op = 'upsert'$/),
  read('holds.readRevisions', /^SELECT v\.head_id, r\.marker_seq AS marker, v\.seq, v\.before, v\.after FROM import_revision v/),
  // readFrames (C-4): the frames after the basis, each with its import's start (seq <= r.marker). The
  // start is one probe per import run, not per frame: a frame costs its own row and no more, so a
  // per-frame probe (the old correlated SubPlan, ~3 buffers a frame) breaks the bound.
  read('holds.readFrames', /^(SELECT f\.head_id, f\.import_number|WITH runs AS MATERIALIZED)/, { base: 60, perRow: 2 }),
  // facetsBefore (C-1): S's keys as the feed had them just below an import's start (seq < f.start).
  read('holds.facetsBefore', /^SELECT DISTINCT ON \(facet_key\) facet_key, version, op, payload FROM feed_event WHERE user_id = \$1 AND facet_key = ANY\(\$2::text\[\]\) AND seq < \$3/),
  read('holds.hadHeadBy', /^SELECT 1 FROM feed_event WHERE user_id = \$1 AND facet_key = \$2 AND op = 'upsert' AND seq <= \$3 LIMIT 1$/),
  read('holds.answerSince', /^SELECT 1 FROM feed_event WHERE user_id = \$1 AND facet_key = \$2 AND seq > \$3 LIMIT 1$/),
  read('holds.staleSince', /^SELECT seq, version FROM feed_event WHERE user_id = \$1 AND facet_key = \$2 AND seq > \$3$/),
  read('holds.placeLate', /^SELECT version FROM feed_event WHERE user_id = \$1 AND facet_key = \$2 AND seq > \$3$/),
  read('holds.readLateEdits', /^SELECT import_number, facet_key, version, op, payload FROM import_late_edit WHERE user_id = \$1 AND head_id = \$2$/),
  read('holds.laterFrame', /^SELECT 1 FROM import_frame x JOIN import_run r ON r\.user_id = x\.user_id/),
  // The revision's "since the marker" (C-1 :428): S's keys and every key under S's copies, tags included.
  read('holds.editsSince', /^SELECT facet_key, version FROM feed_event WHERE user_id = \$1 AND seq > \$2 AND \(facet_key = ANY\(\$3::text\[\]\)/),
  write('holds.recordLateEdit', /^INSERT INTO import_late_edit /),
  write('holds.recordRevision', /^INSERT INTO import_revision /),
  read('holds.moveBases.rows', /^SELECT mfc_id, head_id, kind, count, fields FROM import_row_base WHERE user_id = \$1 AND \(head_id = \$2 OR mfc_id = ANY\(\$3::text\[\]\)\)$/),
  read('holds.moveBases.copies', /^SELECT occ_id FROM import_copy_base WHERE user_id = \$1 AND occ_id = ANY\(\$2::uuid\[\]\)$/),
  read('holds.moveBases.kept', /^SELECT occ_id FROM import_kept_copy WHERE user_id = \$1 AND head_id = \$2$/),

  // ── answers (src/import/answers.ts) ─────────────────────────────────────────────────────────
  read('answers.itemSide', /^SELECT side FROM import_figure_item WHERE user_id = \$1 AND head_id = \$2$/),
  read('answers.keptOf', /^SELECT occ_id, head_id, kind FROM import_kept_copy WHERE user_id = \$1 AND occ_id = ANY\(\$2::uuid\[\]\)$/),
  // C-3: the row bases of S, per answer.
  read('answers.rowsOf', /^SELECT mfc_id FROM import_row_base WHERE user_id = \$1 AND head_id = \$2$/),
];
