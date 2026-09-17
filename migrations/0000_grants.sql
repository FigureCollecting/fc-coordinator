-- 0000_grants.sql — the four statements that make two database roles WORK rather than BREAK.
--
-- Runs FIRST, as the MIGRATOR, through scripts/migrate.sh (ledger row + sha256, atomic with the
-- file under psql -1). It is a MIGRATION rather than a hand-run psql for one reason: an
-- un-versioned grant is a grant nobody can prove was applied, and the whole point of splitting the
-- owner from the application is that the split is provable.
--
-- ── WHY IT MUST BE 0000 AND CAN NEVER BE ADDED LATER ────────────────────────────────────────────
-- ALTER DEFAULT PRIVILEGES applies to objects created AFTER it runs. Numbered above 0001 it would
-- grant nothing on the tables 0001 and 0002 create. And migrate.sh refuses a pending file whose
-- prefix is at or below the highest APPLIED prefix (exit 6, "out-of-order migration"), so once a
-- database has applied 0001 this file can never enter its ledger at all — the only remaining route
-- would be the hand-run psql the header above rules out. It is 0000 on the first run, or it is
-- unprovable forever.
--
-- ── WHAT GOES WRONG WITHOUT THIS FILE ───────────────────────────────────────────────────────────
-- The migrator owns the database, so every table 0001 and 0002 create belongs to it. The
-- application role is a different role and inherits nothing, so it would see a schema full of
-- tables it may not touch. The failure is SQLSTATE 42501, and src/connect/interceptors.ts maps an
-- unrecognised pg error to INTERNAL rather than PERMISSION_DENIED — so the service reports a BUG,
-- not a permissions problem, and an operator goes looking in the wrong file.
--
-- ── WHY DEFAULT PRIVILEGES AND NOT "ON ALL TABLES" ──────────────────────────────────────────────
-- GRANT ... ON ALL TABLES IN SCHEMA public applies to the tables that exist RIGHT NOW. It would
-- cover 0001 and 0002 and silently miss every table any future migration adds — a regression that
-- appears months later, in one endpoint, as an INTERNAL error.
--
-- ── THE MIGRATOR IS NOT NAMED HERE, AND THAT IS DELIBERATE ──────────────────────────────────────
-- ALTER DEFAULT PRIVILEGES with no FOR ROLE clause attaches to the CURRENT role. That is always
-- exactly the role creating the tables, because it is the role running this runner. Naming a
-- migrator literally would mean that a Job pointed at a differently-named credential would create
-- tables whose default privileges belong to a role that creates nothing — grants that exist and
-- never apply, with no error at any point.
--
-- The APPLICATION role, by contrast, IS named literally: `coordinator` is the role the deployed
-- DSN connects as, so the migration and the Deployment share one contract. If the role does not
-- exist, the GRANT below fails with `role "coordinator" does not exist`, psql -1 rolls the whole
-- file back, and the ledger stays clean. Loud, and at the right moment.
--
-- ── WHAT IS DELIBERATELY NOT GRANTED ────────────────────────────────────────────────────────────
-- No CREATE on schema public, so the app role can never DDL. No TRUNCATE — a delete it could never
-- audit row by row. No REFERENCES, no TRIGGER. PG15+ already removed PUBLIC's CREATE on the public
-- schema and the app role is not the schema owner, so the DDL refusal is the database's own
-- default rather than something this file arranges; test/migrations.test.ts proves it anyway,
-- because a privilege model nobody exercises is a privilege model nobody has checked.
--
-- NO transaction control in this file: migrate.sh owns the boundary (a top-level BEGIN/COMMIT
-- refuses the whole run, exit 5) and wraps this file and its ledger row in one -1 transaction.

-- May open a connection to this database at all. PUBLIC holds CONNECT by default, so this is
-- belt-and-braces — and it is the line that keeps working on the day someone revokes CONNECT from
-- PUBLIC, which is exactly the hardening this estate is applying elsewhere.
--
-- Built through \gexec rather than written literally because the database NAME differs between the
-- deployment (`coordinator`) and the test fixture (`fccoord`), and a migration that only works
-- against one of them is a migration the suite cannot exercise. A plpgsql DO block would have done
-- the same job, but its `BEGIN` sits at the start of a line and the doctrine scan reads that as
-- transaction control.
SELECT format('GRANT CONNECT ON DATABASE %I TO coordinator', current_database())
\gexec

-- May see into the schema. Without USAGE every object inside is invisible regardless of any
-- table-level grant below.
GRANT USAGE ON SCHEMA public TO coordinator;

-- Rows, from every table the migrator creates from here on.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO coordinator;

-- Sequences behind every `bigserial` / identity column. USAGE is what nextval() needs; SELECT is
-- what currval() and lastval() need. Without these, an INSERT into a table the app may write fails
-- at the column DEFAULT — which reads as a table-permission bug and is not one.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO coordinator;
