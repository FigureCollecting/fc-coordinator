-- ============================================================================
-- 0003_sync.sql — the SyncService substrate (coordinator.v1 SyncService, fc-api-contract 0.2.0).
--
-- facet_state is authoritative: one row per (user, facet_key), tombstones included. feed_event
-- is the per-user change log Delta pages over, by seq and never by version. 0002's holding table
-- stays unused for now.
--
-- Versions are TEXT COLLATE "C" and are compared in the handler (compareVersion), never with
-- SQL < or >: under a locale collation such as glibc en_US, punctuation is ignored and case is
-- folded, so a locale comparison of out-of-grammar tokens is not bytewise.
--
-- No transaction control here: scripts/migrate.sh owns the boundary (psql -1).
-- ============================================================================

-- The contract's version grammar (sync.proto rule 5), including calendar validity, so a token
-- that PostgreSQL stores is always one the package's parseVersion accepts, and vice versa.
CREATE FUNCTION sync_version_is_canonical(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN CASE
  WHEN (v COLLATE "C") !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{6}Z(#[0-9]{10}#[0-9a-f]{32})?$'
    THEN false
  ELSE substr(v, 9, 2)::int <= CASE substr(v, 6, 2)::int
    WHEN 2 THEN CASE
      WHEN (substr(v, 1, 4)::int % 4 = 0 AND substr(v, 1, 4)::int % 100 <> 0) OR substr(v, 1, 4)::int % 400 = 0
        THEN 29
      ELSE 28
    END
    WHEN 4 THEN 30
    WHEN 6 THEN 30
    WHEN 9 THEN 30
    WHEN 11 THEN 30
    ELSE 31
  END
END;

-- Writers take seq inside a per-user advisory lock, so within one user seq order is commit order
-- and a Delta reader paging by seq can never pass a seq that commits later.
CREATE SEQUENCE feed_event_seq AS bigint;

CREATE TABLE feed_event (
  seq         bigint PRIMARY KEY DEFAULT nextval('feed_event_seq'),
  user_id     uuid NOT NULL REFERENCES app_user(id),
  facet_key   text COLLATE "C" NOT NULL,
  version     text COLLATE "C" NOT NULL CHECK (sync_version_is_canonical(version)),
  op          text NOT NULL CHECK (op IN ('upsert', 'delete')),
  payload     text NOT NULL,                 -- JSON text, bytes exactly as pushed
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK ((op = 'delete') = (payload = ''))
);

ALTER SEQUENCE feed_event_seq OWNED BY feed_event.seq;

CREATE INDEX feed_event_user_seq_idx ON feed_event (user_id, seq);

CREATE TABLE facet_state (
  user_id     uuid NOT NULL REFERENCES app_user(id),
  facet_key   text COLLATE "C" NOT NULL,
  version     text COLLATE "C" NOT NULL CHECK (sync_version_is_canonical(version)),
  op          text NOT NULL CHECK (op IN ('upsert', 'delete')),
  payload     text NOT NULL,
  seq         bigint NOT NULL REFERENCES feed_event(seq),  -- the write that produced this state
  PRIMARY KEY (user_id, facet_key),
  CHECK ((op = 'delete') = (payload = ''))
);

-- Per (user, device), recorded on every Delta: acked = the cursor the device presented,
-- delivered = the last seq it was sent. Nothing prunes the feed yet.
CREATE TABLE feed_cursor (
  user_id        uuid NOT NULL REFERENCES app_user(id),
  device_id      uuid NOT NULL REFERENCES device(id),
  acked_seq      bigint NOT NULL,
  delivered_seq  bigint NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_id)
);

-- Push idempotency per user (never global): the request hash, and each event's first outcome and
-- reason (a coordinator.v1 PushResponse without `current`). A replay repeats those and reads
-- `current` afresh, so a sibling's later write reaches it.
CREATE TABLE mutation_receipt (
  user_id         uuid NOT NULL REFERENCES app_user(id),
  client_id       text COLLATE "C" NOT NULL,
  request_sha256  bytea NOT NULL CHECK (octet_length(request_sha256) = 32),
  outcomes        bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id)
);

-- R-6 roles: the migrator owns these tables and 0000's default privileges gave the application
-- role SELECT, INSERT, UPDATE and DELETE. Narrow that to the verbs the sync path uses: the feed
-- and the receipts are append-only, and a facet is tombstoned, never deleted.
REVOKE UPDATE, DELETE ON feed_event FROM coordinator;
REVOKE UPDATE, DELETE ON mutation_receipt FROM coordinator;
REVOKE DELETE ON facet_state FROM coordinator;
REVOKE DELETE ON feed_cursor FROM coordinator;
