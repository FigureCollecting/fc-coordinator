-- ============================================================================
-- 0007_display_restriction.sql — display restrictions as DATA (ADDR-1; fc-api-contract 0.4.0
-- catalog.proto DISPLAY RESTRICTIONS, Ross 2026-09-26; orchestrator ruling 2026-10-09).
--
--   display_restriction  one restriction: it WITHHOLDS what its scope names from the viewer
--                        contexts its scope covers, for one image (subject = the derivative's
--                        content address), one product (subject = a spine product id; a merged
--                        id covers its survivor) or one source (subject = a store's site key).
--                        Nothing here grants anything.
--
-- The CHECKs are the WRITER's rules from the contract: only the four scopes and the three levels,
-- and a subject that is neither empty nor begins or ends with white space. The reader
-- (src/display/source.ts) takes rows verbatim and the evaluator fails closed on anything it does
-- not recognise, so these CHECKs keep typos out; they are not what keeps an image hidden.
--
-- The app role READS only. A restriction is written by an operator (the migrator's credential)
-- or a later intake path with its own grant, never by the service that enforces it.
-- No transaction control here: scripts/migrate.sh owns the boundary (psql -1).
-- ============================================================================

CREATE TABLE display_restriction (
  rule_id     text COLLATE "C" PRIMARY KEY
                CHECK (rule_id <> '' AND rule_id !~ '^[[:space:]]' AND rule_id !~ '[[:space:]]$' AND length(rule_id) <= 128),
  level       text COLLATE "C" NOT NULL CHECK (level IN ('image', 'product', 'source')),
  subject     text COLLATE "C" NOT NULL
                CHECK (subject <> '' AND subject !~ '^[[:space:]]' AND subject !~ '[[:space:]]$' AND length(subject) <= 512),
  scope       text COLLATE "C" NOT NULL CHECK (scope IN ('no_display', 'owner_views_only', 'no_share', 'no_mask')),
  -- Why the restriction exists (a takedown reference, a ruling): for the operator, never sent.
  reason      text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);

REVOKE INSERT, UPDATE, DELETE ON display_restriction FROM coordinator;
