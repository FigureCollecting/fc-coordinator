-- ============================================================================
-- 0005_import.sql — the MFC import's server-internal state (fc-api-contract 0.3.0, import.proto).
--
-- Every write an import makes to a user's facets goes through facet_state and feed_event like a
-- Push. What is here is what the server keeps BESIDE the feed to decide the next import and to
-- place a late edit (import.proto THE SERVER DECIDES):
--
--   import_run         one row per import: its per-user counter, the export date, the version
--                      its writes carry and the seq of its marker imp/mfc/import (FRAME, F1).
--   import_frame       the figures an import decided: a pushed edit to one of them whose basis is
--                      before the marker is a LATE EDIT (import.proto HELD).
--   import_row_base    ROW BASE per MFC id: what the last import that settled the row took.
--   import_copy_base   COPY BASE per copy: the kind (or out) and head a settlement gave it.
--   import_field_base  FIELD BASE per head and field: the value MFC last stated (null: none).
--   import_figure_item each pending figure item, beside its facet: its rev, the import that
--                      raised it, MFC's side as that import found it and what it found.
--
-- Runs and frames are history, append-only like the feed. The bases and the items are the
-- import's current state and are rewritten as imports decide. No transaction control here:
-- scripts/migrate.sh owns the boundary (psql -1).
-- ============================================================================

CREATE TABLE import_run (
  user_id        uuid NOT NULL REFERENCES app_user(id),
  import_number  integer NOT NULL CHECK (import_number >= 1),
  export_date    date NOT NULL,
  version        text COLLATE "C" NOT NULL CHECK (sync_version_is_canonical(version) AND version LIKE '%#%#00000000000000000000000000000000'),
  marker_seq     bigint NOT NULL REFERENCES feed_event(seq),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, import_number)
);

CREATE TABLE import_frame (
  user_id        uuid NOT NULL,
  import_number  integer NOT NULL,
  head_id        uuid NOT NULL,
  PRIMARY KEY (user_id, import_number, head_id),
  FOREIGN KEY (user_id, import_number) REFERENCES import_run (user_id, import_number)
);

-- A Push asks, per figure it touches, for the last import that framed it.
CREATE INDEX import_frame_head_idx ON import_frame (user_id, head_id);

CREATE TABLE import_row_base (
  user_id        uuid NOT NULL REFERENCES app_user(id),
  mfc_id         text COLLATE "C" NOT NULL CHECK (mfc_id ~ '^[1-9][0-9]{0,63}$'),
  head_id        uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('owned', 'ordered', 'wished')),
  count          integer NOT NULL CHECK (count BETWEEN 0 AND 99),
  fields         jsonb NOT NULL,
  import_number  integer NOT NULL CHECK (import_number >= 1),
  PRIMARY KEY (user_id, mfc_id)
);

CREATE TABLE import_copy_base (
  user_id        uuid NOT NULL REFERENCES app_user(id),
  occ_id         uuid NOT NULL,
  head_id        uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('owned', 'ordered', 'wished', 'out')),
  PRIMARY KEY (user_id, occ_id)
);

CREATE TABLE import_field_base (
  user_id        uuid NOT NULL REFERENCES app_user(id),
  head_id        uuid NOT NULL,
  field          text NOT NULL CHECK (field IN ('score', 'note', 'wishability')),
  value          jsonb NOT NULL,              -- the JSON value, or JSON null for none
  PRIMARY KEY (user_id, head_id, field)
);

CREATE TABLE import_figure_item (
  user_id        uuid NOT NULL REFERENCES app_user(id),
  head_id        uuid NOT NULL,
  rev            text COLLATE "C" NOT NULL CHECK (rev ~ '^[0-9A-Za-z:._~-]{1,128}$'),
  raised_import  integer NOT NULL CHECK (raised_import >= 1),
  side           text NOT NULL,
  comps          jsonb NOT NULL,
  PRIMARY KEY (user_id, head_id)
);

-- As the feed: the application appends runs and frames and never rewrites one.
REVOKE UPDATE, DELETE ON import_run FROM coordinator;
REVOKE UPDATE, DELETE ON import_frame FROM coordinator;
