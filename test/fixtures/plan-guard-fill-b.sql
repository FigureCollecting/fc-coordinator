-- Plan guard fill, part B, run after the whale's first import (made through the real app): more device
-- pushes from the 240 background users, interleaved with the whale's own device edits to the copies its
-- import made (tag memberships, added and removed), until the whale holds 32x the median user's feed.
-- Needs part A's temp tables (same session) and set_config('pg.whale', <uuid>). Tags only, so the
-- whale's second import (also through the app) finds nothing of its own decisions moved.
SET statement_timeout = 0;
SELECT setseed(0.1717);

CREATE TEMP TABLE b_ev (uid uuid, grp double precision, sub int, facet_key text, op text, payload text, dev text);
INSERT INTO b_ev
SELECT c.uid, floor(random() * 100000), (random() * 4)::int,
       CASE WHEN k < 0.25 THEN 'occ/' || c.occ || '/status'
            WHEN k < 0.40 THEN 'uf/' || c.head || '/score'
            WHEN k < 0.95 THEN 'occ/' || c.occ || '/tag/' || md5('tag:' || (random() * 63)::int)::uuid
            ELSE 'occ/' || c.occ || '/collection' END,
       'upsert',
       CASE WHEN k < 0.25 THEN '{"status":"owned","edited_at":"2026-10-25T10:00:00.000-05:00","tz":"America/Chicago"}'
            WHEN k < 0.40 THEN '{"score":9,"edited_at":"2026-10-25T10:00:00.000-05:00","tz":"America/Chicago"}'
            WHEN k < 0.95 THEN '{"edited_at":"2026-10-25T10:00:00.000-05:00","tz":"America/Chicago"}'
            ELSE '{"collection":"owned/shelf","edited_at":"2026-10-25T10:00:00.000-05:00","tz":"America/Chicago"}' END,
       md5('dev:' || c.uid)
  FROM g_copy c, generate_series(1, 6) n, LATERAL (SELECT random() + n * 0 AS k) x;

-- The whale's padding: 32x the median background feed, less what its import already wrote.
CREATE TEMP TABLE w_occ AS
  SELECT split_part(facet_key, '/', 2)::uuid AS occ, row_number() OVER (ORDER BY facet_key) AS i
    FROM facet_state WHERE user_id = current_setting('pg.whale')::uuid AND facet_key LIKE 'occ/%/head';
CREATE TEMP TABLE w_need AS
  SELECT greatest(0, 32 * (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n)
                             FROM (SELECT count(*) AS n FROM g_user u LEFT JOIN b_ev e USING (uid) GROUP BY u.uid) b)
                     + 32 * (SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY n)
                               FROM (SELECT count(*) AS n FROM feed_event WHERE user_id IN (SELECT uid FROM g_user) GROUP BY user_id) a)
                     - (SELECT count(*) FROM feed_event WHERE user_id = current_setting('pg.whale')::uuid)) AS n;
INSERT INTO b_ev
SELECT current_setting('pg.whale')::uuid, floor(random() * 100000), (random() * 4)::int,
       'occ/' || o.occ || '/tag/' || md5('wtag:' || (j % 13))::uuid,
       CASE WHEN j % 5 = 4 THEN 'delete' ELSE 'upsert' END,
       CASE WHEN j % 5 = 4 THEN '' ELSE '{"edited_at":"2026-10-25T10:00:00.000-05:00","tz":"America/Chicago"}' END,
       md5('dev:whale')
  FROM generate_series(1, (SELECT n FROM w_need)) j
  JOIN w_occ o ON o.i = 1 + (j * 7919) % (SELECT count(*) FROM w_occ);

CREATE TEMP TABLE b_mark AS SELECT coalesce(max(seq), 0) AS seq FROM feed_event;
INSERT INTO feed_event (user_id, facet_key, version, op, payload, opens_txn)
SELECT uid, facet_key,
       to_char(timestamp '2026-10-20 00:00:00' + make_interval(secs => n / 1000.0), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '#' || lpad((n % 1000)::text, 10, '0') || '#' || dev,
       op, payload, first
  FROM (SELECT *, row_number() OVER (ORDER BY grp, uid, sub, facet_key) AS n,
               row_number() OVER (PARTITION BY uid, grp ORDER BY sub, facet_key) = 1 AS first
          FROM b_ev) e
 ORDER BY n;

INSERT INTO mutation_receipt (user_id, client_id, request_sha256, outcomes)
SELECT DISTINCT uid, md5('b:' || uid::text || ':' || grp), sha256(('b:' || uid::text || ':' || grp)::bytea), '\x00'::bytea FROM b_ev;

INSERT INTO facet_state (user_id, facet_key, version, op, payload, seq)
SELECT DISTINCT ON (user_id, facet_key) user_id, facet_key, version, op, payload, seq
  FROM feed_event WHERE seq > (SELECT seq FROM b_mark) ORDER BY user_id, facet_key, seq DESC
ON CONFLICT (user_id, facet_key) DO UPDATE
  SET version = EXCLUDED.version, op = EXCLUDED.op, payload = EXCLUDED.payload, seq = EXCLUDED.seq;
