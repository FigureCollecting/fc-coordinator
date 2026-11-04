-- Plan guard fill, part A: 240 background users, each with a first import (one contiguous server
-- transaction, as lockUser serialises it) and then device pushes of 1-5 events, all users interleaved.
-- Shapes follow src/import/writes.ts and the contract's payload schemas; versions are canonical. The
-- per-user median is 125 MFC rows (about 1.8k feed events once part B has run): the whale the test
-- builds through the real app is 32x that. Run on one session (temp tables), as a superuser.
SET statement_timeout = 0;
SELECT setseed(0.4242);

CREATE TEMP TABLE g_user AS
  SELECT md5('pg-u' || i)::uuid AS uid, i AS idx, 60 + (i * 37) % 131 AS nrows FROM generate_series(1, 240) i;
CREATE TEMP TABLE g_row AS
  SELECT u.uid, u.idx, r, (100000 + r * 7 + u.idx)::text AS mfc_id,
         md5('head:' || ((r * 7919 + u.idx * 13) % 400000))::uuid AS head,
         CASE WHEN r % 29 = 0 THEN 2 ELSE 1 END AS ncopies
    FROM g_user u, generate_series(1, u.nrows) r;
CREATE TEMP TABLE g_copy AS
  SELECT uid, idx, r, mfc_id, head, o AS ordinal, md5('occ:' || uid || ':' || mfc_id || ':' || o)::uuid AS occ
    FROM g_row, generate_series(1, ncopies) o;

INSERT INTO app_user (id) SELECT uid FROM g_user;
INSERT INTO device (id, user_id, jkt, jwk) SELECT md5('dev:' || uid)::uuid, uid, md5('jkt:' || uid), '{}' FROM g_user;

-- One row per event: (uid, grp, sub) orders the feed; the first event of a (uid, grp) group opens its transaction.
CREATE TEMP TABLE g_ev (uid uuid, grp double precision, sub int, facet_key text, op text, payload text, dev text);
INSERT INTO g_ev
SELECT uid, idx, (r * 2 + ordinal) * 10 + k, fk, 'upsert', pl, '00000000000000000000000000000000'
  FROM g_copy, LATERAL (VALUES
    (1, 'occ/' || occ || '/origin', json_build_object('site', 'mfc', 'native_id', mfc_id, 'ordinal', ordinal)::text),
    (2, 'occ/' || occ || '/head', json_build_object('head_id', head, 'edited_at', '2026-10-09T12:46:52.000-05:00', 'tz', 'America/Chicago')::text),
    (3, 'occ/' || occ || '/status', json_build_object('status', CASE WHEN r % 9 = 0 THEN 'ordered' WHEN r % 13 = 0 THEN 'wished' ELSE 'owned' END, 'edited_at', '2026-10-09T12:46:52.000-05:00', 'tz', 'America/Chicago')::text),
    (4, CASE WHEN r % 3 = 0 THEN 'occ/' || occ || '/collection' END, json_build_object('collection', 'owned/default', 'edited_at', '2026-10-09T12:46:52.000-05:00', 'tz', 'America/Chicago')::text)
  ) v(k, fk, pl) WHERE fk IS NOT NULL;
INSERT INTO g_ev
SELECT uid, idx, r * 20 + 15 + k, fk, 'upsert', pl, '00000000000000000000000000000000'
  FROM g_row, LATERAL (VALUES
    (1, CASE WHEN r % 5 < 3 THEN 'uf/' || head || '/score' END, json_build_object('score', (r % 10) + 0.5, 'edited_at', '2026-10-09T12:46:52.000-05:00', 'tz', 'America/Chicago')::text),
    (2, CASE WHEN r % 10 = 0 THEN 'uf/' || head || '/note' END, json_build_object('note', repeat('note text ', 5 + r % 40), 'edited_at', '2026-10-09T12:46:52.000-05:00', 'tz', 'America/Chicago')::text)
  ) v(k, fk, pl) WHERE fk IS NOT NULL;
INSERT INTO g_ev SELECT uid, idx, 2147483000, 'imp/mfc/import', 'upsert', '{"import":1,"export_date":"2026-09-09"}', '00000000000000000000000000000000' FROM g_user;
-- Device pushes: four edits per copy on average, in transactions of one to five events at random times
-- after every import above (grp > 1000).
INSERT INTO g_ev
SELECT c.uid, 1000 + floor(random() * 100000), (random() * 4)::int,
       CASE WHEN k < 0.25 THEN 'occ/' || c.occ || '/status'
            WHEN k < 0.40 THEN 'uf/' || c.head || '/score'
            WHEN k < 0.95 THEN 'occ/' || c.occ || '/tag/' || md5('tag:' || (random() * 63)::int)::uuid
            ELSE 'occ/' || c.occ || '/collection' END,
       'upsert',
       CASE WHEN k < 0.25 THEN '{"status":"owned","edited_at":"2026-10-20T10:00:00.000-05:00","tz":"America/Chicago"}'
            WHEN k < 0.40 THEN '{"score":8,"edited_at":"2026-10-20T10:00:00.000-05:00","tz":"America/Chicago"}'
            WHEN k < 0.95 THEN '{"edited_at":"2026-10-20T10:00:00.000-05:00","tz":"America/Chicago"}'
            ELSE '{"collection":"owned/shelf","edited_at":"2026-10-20T10:00:00.000-05:00","tz":"America/Chicago"}' END,
       md5('dev:' || c.uid)
  FROM g_copy c, generate_series(1, 4) n, LATERAL (SELECT random() + n * 0 AS k) x;

INSERT INTO feed_event (user_id, facet_key, version, op, payload, opens_txn)
SELECT uid, facet_key,
       to_char(timestamp '2026-10-01 00:00:00' + make_interval(secs => n / 1000.0), 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '#' || lpad((n % 1000)::text, 10, '0') || '#' || dev,
       op, payload, first
  FROM (SELECT *, row_number() OVER (ORDER BY grp, uid, sub, facet_key) AS n,
               row_number() OVER (PARTITION BY uid, grp ORDER BY sub, facet_key) = 1 AS first
          FROM g_ev) e
 ORDER BY n;

-- One receipt per device push (the import's own transaction has none).
INSERT INTO mutation_receipt (user_id, client_id, request_sha256, outcomes)
SELECT DISTINCT uid, md5(uid::text || ':' || grp), sha256((uid::text || ':' || grp)::bytea), '\x00'::bytea FROM g_ev WHERE grp >= 1000;

INSERT INTO facet_state (user_id, facet_key, version, op, payload, seq)
SELECT DISTINCT ON (user_id, facet_key) user_id, facet_key, version, op, payload, seq
  FROM feed_event WHERE user_id IN (SELECT uid FROM g_user) ORDER BY user_id, facet_key, seq DESC;

INSERT INTO import_run (user_id, import_number, export_date, version, marker_seq)
SELECT user_id, 1, date '2026-09-09', split_part(version, '#', 1) || '#0000000001#00000000000000000000000000000000', seq
  FROM feed_event WHERE facet_key = 'imp/mfc/import' AND user_id IN (SELECT uid FROM g_user);
INSERT INTO import_frame (user_id, import_number, head_id, settled, before)
SELECT DISTINCT uid, 1, head, true, NULL::jsonb FROM g_row;
INSERT INTO import_row_base (user_id, mfc_id, head_id, kind, count, fields, import_number)
SELECT uid, mfc_id, head, 'owned', ncopies, '{"score":7}', 1 FROM g_row;
INSERT INTO import_copy_base (user_id, occ_id, head_id, kind) SELECT uid, occ, head, 'owned' FROM g_copy;
INSERT INTO import_export_row (user_id, mfc_id, head_id, kind, count) SELECT uid, mfc_id, head, 'owned', ncopies FROM g_row;
INSERT INTO import_field_base (user_id, head_id, field, value) SELECT DISTINCT uid, head, 'score', '7'::jsonb FROM g_row WHERE r % 5 < 3;
INSERT INTO import_kept_copy (user_id, occ_id, head_id, kind) SELECT uid, occ, head, 'owned' FROM g_copy WHERE r % 4 = 1;
INSERT INTO import_figure_item (user_id, head_id, rev, raised_import, side, comps) SELECT uid, head, 'r1', 1, '{}', '{}' FROM g_row WHERE r = 1;
