-- ============================================================================
-- 0006_import_reimport.sql — what a re-import and an answer keep beside 0005 (fc-api-contract
-- 0.3.0, import.proto MATERIALIZE, A COPY KEPT AGAINST MFC'S REMOVAL, FULL DISCREPANCY REPORT).
--
--   import_copy_base.import_removed
--                      the copy is one an import removed: MATERIALIZE restores such a copy
--                      before it creates one. It stays so until an import (or what a keep or
--                      per_copy applies of MFC's change) restores it, whatever an answer or a
--                      device writes to it meanwhile.
--   import_kept_copy   a KNOWING KEEP: a copy the user kept against MFC's removal, by the undo
--                      of an applied change or a keep or per_copy on a conflict, at the kind and
--                      on the figure it was kept at. It drops its own record when the copy leaves
--                      that kind or figure, or when MFC counts it again (it gets a live base).
--   import_export_row  the latest export's rows, as the import read them: what the full
--                      discrepancy report compares the collection with.
--   import_frame.before
--                      S as it stood just before the import (import.proto FRAME): S's rows in
--                      the export, its row, copy and field bases, its item, its knowing keeps
--                      and its copies. A late edit is replayed against it (src/import/replay.ts).
--                      NULL for a frame recorded before 0006: a late edit for it is held.
--   import_late_edit   each late edit a Push replayed and APPLIED, under the earliest import it
--                      is late for: a later replay places it before that import and each later
--                      one. One answered STALE is not kept: a STALE answer is final.
--   import_revision    each Push whose replay changed S's live copies or items (a REVISION): its
--                      position on the feed and S's live copies and items either side, which
--                      HELD (ii) reads for an edit made before it.
--
-- The late edits and the revisions are history, append-only like the feed.
-- No transaction control here: scripts/migrate.sh owns the boundary (psql -1).
-- ============================================================================

ALTER TABLE import_copy_base ADD COLUMN import_removed boolean NOT NULL DEFAULT false;

CREATE TABLE import_kept_copy (
  user_id        uuid NOT NULL REFERENCES app_user(id),
  occ_id         uuid NOT NULL,
  head_id        uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('owned', 'ordered', 'wished')),
  PRIMARY KEY (user_id, occ_id)
);

CREATE TABLE import_export_row (
  user_id        uuid NOT NULL REFERENCES app_user(id),
  mfc_id         text COLLATE "C" NOT NULL CHECK (mfc_id ~ '^[1-9][0-9]{0,63}$'),
  head_id        uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('owned', 'ordered', 'wished')),
  count          integer NOT NULL CHECK (count BETWEEN 0 AND 99),
  PRIMARY KEY (user_id, mfc_id)
);

ALTER TABLE import_frame ADD COLUMN before jsonb;

CREATE TABLE import_late_edit (
  user_id        uuid NOT NULL,
  import_number  integer NOT NULL,
  head_id        uuid NOT NULL,
  facet_key      text COLLATE "C" NOT NULL,
  version        text COLLATE "C" NOT NULL CHECK (sync_version_is_canonical(version)),
  op             text NOT NULL CHECK (op IN ('upsert', 'delete')),
  payload        text NOT NULL,
  PRIMARY KEY (user_id, import_number, head_id, facet_key, version),
  CHECK ((op = 'delete') = (payload = '')),
  FOREIGN KEY (user_id, import_number) REFERENCES import_run (user_id, import_number)
);

CREATE TABLE import_revision (
  user_id        uuid NOT NULL,
  import_number  integer NOT NULL,
  head_id        uuid NOT NULL,
  seq            bigint NOT NULL REFERENCES feed_event(seq),
  before         jsonb NOT NULL,
  after          jsonb NOT NULL,
  PRIMARY KEY (user_id, head_id, seq),
  FOREIGN KEY (user_id, import_number) REFERENCES import_run (user_id, import_number)
);

REVOKE UPDATE, DELETE ON import_late_edit FROM coordinator;
REVOKE UPDATE, DELETE ON import_revision FROM coordinator;
