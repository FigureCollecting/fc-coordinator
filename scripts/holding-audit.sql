-- ============================================================================
-- holding-audit.sql — read-only audit of the retired 0.2.x holding grain (WK-05b).
--
-- fc-api-contract 0.3.0 retires holding/{head_id}/status and holding/{head_id}/count: a Push of
-- either is REJECTED facet_key_not_user_owned, and rows already stored stay inert (sync.proto
-- rule 6, RETIRED). This counts what is stored, so the 0.3.0 roll can record it:
--
--   source         rows   live                                  users
--   facet_state    keys under holding/   of them, upserts        distinct users
--   feed_event     events under holding/ of them, upserts        distinct users
--   holding_table  rows of 0002's table  of them, not soft-deleted  distinct users
--
--   psql -X -A -v ON_ERROR_STOP=1 -f scripts/holding-audit.sql   (any role that can SELECT them)
--
-- It writes nothing: the work runs in one transaction PostgreSQL itself holds READ ONLY, and is
-- rolled back. test/sync/holding-audit.test.ts runs it against a local migrated database only.
-- ============================================================================
BEGIN TRANSACTION READ ONLY;

WITH sources (source) AS (VALUES ('facet_state'), ('feed_event')),
facets AS (
  SELECT 'facet_state' AS source, user_id, op FROM facet_state WHERE starts_with(facet_key, 'holding/')
  UNION ALL
  SELECT 'feed_event', user_id, op FROM feed_event WHERE starts_with(facet_key, 'holding/')
)
SELECT s.source,
       count(f.user_id) AS rows,
       count(f.user_id) FILTER (WHERE f.op = 'upsert') AS live,
       count(DISTINCT f.user_id) AS users
  FROM sources s LEFT JOIN facets f ON f.source = s.source
 GROUP BY s.source
UNION ALL
SELECT 'holding_table', count(*), count(*) FILTER (WHERE deleted_at IS NULL), count(DISTINCT user_id)
  FROM holding
 ORDER BY 1;

ROLLBACK;
