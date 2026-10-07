-- ============================================================================
-- 0004_sync_transactions.sql — contract 0.3.0's sync rules on the feed (fc-api-contract 0.3.0).
--
-- sync.proto rule 7: every server transaction (one Push, one import, ...) writes its events
-- consecutively in the user's feed (lockUser holds every writer of a user until commit), and its
-- last event carries commit_cursor. feed_event.opens_txn marks the FIRST event of each server
-- transaction. The last is derived when Delta reads: an event is last when the user's next event
-- opens a transaction, or when there is none, because a transaction commits whole and a reader
-- sees all of it or none. So the feed stays append-only: nothing is updated when a transaction
-- ends. A writer that marks nothing writes one-event transactions, never an unterminated one.
--
-- held_edit keeps each Push event answered PUSH_OUTCOME_HELD (import.proto HELD): kept on the
-- server, not applied, with the basis it was made on (the seq its cursor names, 0 for '').
--
-- No transaction control here: scripts/migrate.sh owns the boundary (psql -1).
-- ============================================================================

ALTER TABLE feed_event ADD COLUMN opens_txn boolean NOT NULL DEFAULT true;

-- Every event already stored was written by a Push, one database transaction each, and every
-- event of one database transaction shares its created_at (now() is the transaction's start).
-- An event continues its transaction when the user's previous event was written in the same one.
UPDATE feed_event f
   SET opens_txn = false
  FROM (SELECT seq, user_id, created_at,
               lag(created_at) OVER (PARTITION BY user_id ORDER BY seq) AS previous
          FROM feed_event) p
 WHERE p.seq = f.seq
   AND p.previous = p.created_at;

CREATE TABLE held_edit (
  user_id     uuid NOT NULL REFERENCES app_user(id),
  client_id   text COLLATE "C" NOT NULL,       -- the Push's client_id
  ordinal     integer NOT NULL CHECK (ordinal >= 0),  -- the event's place in that Push
  facet_key   text COLLATE "C" NOT NULL,
  version     text COLLATE "C" NOT NULL CHECK (sync_version_is_canonical(version)),
  op          text NOT NULL CHECK (op IN ('upsert', 'delete')),
  payload     text NOT NULL,
  basis_seq   bigint NOT NULL CHECK (basis_seq >= 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id, ordinal),
  CHECK ((op = 'delete') = (payload = ''))
);

-- As the feed and the receipts: the application appends a held edit and never rewrites one.
REVOKE UPDATE, DELETE ON held_edit FROM coordinator;
