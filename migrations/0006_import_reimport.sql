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
--
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
