-- ============================================================================
-- 0009_revoke_public_connect.sql — close this database to PUBLIC (PGHBA-1).
--
-- PostgreSQL gives PUBLIC CONNECT and TEMPORARY on every database it creates. On pg-spine that meant
-- any login role in the cluster, the spine's own role included, could open a session on database
-- `coordinator`, read its whole catalog (every table, column and index name) and create temp tables
-- here. Row data was never exposed, because no table grants anything to PUBLIC. fc-infra's pg_hba
-- block on pg-spine now rejects every role outside its own database. This file is the second, separate
-- control on the same boundary: the same revoke that decision R1 ran by hand on database `spine`.
--
-- WHO KEEPS WHAT
--   the owner (the migrator)   CONNECT and TEMPORARY implicitly, as owner; the migrate Job and
--                              scripts/mask-store.sh are untouched
--   the app role `coordinator` CONNECT through 0000_grants.sql's explicit grant. It loses TEMPORARY,
--                              which it only ever had through PUBLIC; src/ creates no temp table
--   cnpg_metrics_exporter      CONNECT, granted below where the role exists. CNPG creates it on every
--                              cluster, and until now its per-database queries reached this database
--                              through PUBLIC alone (R1 granted it the same way on `spine`). A plain
--                              Postgres without the role (this repo's tests, a developer's) still
--                              migrates
--   every other role           nothing: "permission denied for database"
-- The maintenance database `postgres` gets no migration here: it is not this repo's database, and the
-- pg_hba rejects already keep the coordinator's roles and the spine's role out of it.
--
-- WHY IT CHECKS ITS OWN OUTCOME
-- A REVOKE removes only what the revoking role granted. A CONNECT that some other grantor gave PUBLIC
-- would survive this file silently, and a revoke that leaves the app role with no CONNECT of its own
-- would lock the service out at its next new connection. Either way the DO block raises, psql -1 rolls
-- the whole file back with its ledger row, and the migrate Job fails with exit 3 instead of reporting
-- a change it did not make.
--
-- Idempotent: REVOKE and GRANT of a privilege already in that state change nothing, and the check is
-- a read. The database name is current_database() through \gexec, as in 0000: the deployment's is
-- `coordinator`, the test fixture's `fccoord`.
-- No transaction control here: scripts/migrate.sh owns the boundary (psql -1).
-- ============================================================================

SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', current_database())
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO cnpg_metrics_exporter', current_database())
 WHERE EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cnpg_metrics_exporter')
\gexec

DO $$ BEGIN
  IF pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'CONNECT')
     OR pg_catalog.has_database_privilege('public', pg_catalog.current_database(), 'TEMPORARY') THEN
    RAISE EXCEPTION '0009: PUBLIC still holds CONNECT or TEMPORARY on database % (a grant by a role other than its owner survives the revoke); nothing was changed',
      pg_catalog.current_database();
  END IF;
  IF NOT pg_catalog.has_database_privilege('coordinator', pg_catalog.current_database(), 'CONNECT') THEN
    RAISE EXCEPTION '0009: the revoke would lock the application role coordinator out of database % (it holds no CONNECT of its own; 0000_grants.sql grants it); nothing was changed',
      pg_catalog.current_database();
  END IF;
END $$;
