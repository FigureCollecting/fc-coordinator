-- migrate: no-transaction
-- ============================================================================
-- 0009_late_edit_indexes.sql — indexes for the late-edit path, the per-answer reads and the copy
-- lookups, and the database's session limits (PLAN.md U4 and U5, DB index audit 2026-11-03).
--
-- NO TRANSACTION (first line): scripts/migrate.sh applies this file statement by statement, the only
-- way CREATE INDEX CONCURRENTLY runs, so no build blocks a Push or an import's writes. Every statement
-- is re-runnable (IF NOT EXISTS): a failure part-way leaves what ran before it, and the re-run steps
-- over it. The runner refuses to record the file while any index is left INVALID (exit 7).
--
--   feed_event_user_facet_seq_idx    one key's history of one user: facetsBefore (seq < f.start),
--                                    hadHeadBy (seq <= r.marker), an answer or a server write since
--                                    a basis, placeLate, and the revision's edits since the marker.
--                                    Insert-only table: no HOT interaction.
--   feed_event_user_txn_open_idx     the seq that opened a user's last transaction at or below a
--                                    marker (readFrames' start). Partial: ~1 B per event.
--   import_row_base_user_head_idx    the row bases of one figure (an answer, a revision's moveBases)
--   import_kept_copy_user_head_idx   the kept copies of one figure
--   import_copy_base_user_head_idx   the copy bases of one figure (figureOccs)
--   facet_state.occ_head/occ_origin  STORED generated columns holding what figureOccs compares, with a
--                                    partial index each. An index whose expression or predicate read
--                                    payload, op or facet_key directly would turn off HOT for EVERY
--                                    facet_state update (measured 91 % -> 0 %, WAL +31 %); a generated
--                                    column changes only on a copy's head or origin, so a score or
--                                    status edit stays HOT. ADD COLUMN rewrites the table once
--                                    (milliseconds at today's size), under lock_timeout 5 s: on a
--                                    timeout the file fails before any index, and the re-run retries.
--                                    The CASE casts payload only for an upsert of a head or origin
--                                    key, whose payload has passed its schema (JSON); a tombstone's ''
--                                    is never cast.
--
-- Session limits (CNPG managed roles have no per-role SET, so they ride here, per database):
--   idle_in_transaction_session_timeout 120 s   longer than the import's Node-side gaps inside its
--                                               transaction (~3 s at prod size, ~30 s at 10x)
--   statement_timeout                    30 s   the app's longest statement is milliseconds today;
--                                               migrate.sh runs its own sessions with 0
-- ============================================================================

SET lock_timeout = '5s';
ALTER TABLE facet_state
  ADD COLUMN IF NOT EXISTS occ_head text GENERATED ALWAYS AS
    (CASE WHEN op = 'upsert' AND facet_key LIKE 'occ/%/head' THEN payload::jsonb ->> 'head_id' END) STORED,
  ADD COLUMN IF NOT EXISTS occ_origin text GENERATED ALWAYS AS
    (CASE WHEN op = 'upsert' AND facet_key LIKE 'occ/%/origin' THEN payload::jsonb ->> 'native_id' END) STORED;
RESET lock_timeout;

CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_event_user_facet_seq_idx ON feed_event (user_id, facet_key, seq);
CREATE INDEX CONCURRENTLY IF NOT EXISTS feed_event_user_txn_open_idx ON feed_event (user_id, seq) WHERE opens_txn;
CREATE INDEX CONCURRENTLY IF NOT EXISTS import_row_base_user_head_idx ON import_row_base (user_id, head_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS import_kept_copy_user_head_idx ON import_kept_copy (user_id, head_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS import_copy_base_user_head_idx ON import_copy_base (user_id, head_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS facet_state_occ_head_idx ON facet_state (user_id, occ_head) WHERE occ_head IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS facet_state_occ_origin_idx ON facet_state (user_id, occ_origin) WHERE occ_origin IS NOT NULL;

DO $$ BEGIN
  EXECUTE format('ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '120s');
  EXECUTE format('ALTER DATABASE %I SET statement_timeout = %L', current_database(), '30s');
END $$;
