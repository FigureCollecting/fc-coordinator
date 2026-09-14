-- ============================================================================
-- 0002_collection.sql — the HOLDING layer of collectible-entity-layers.
--
-- Spine references (head_id, gtin14, mfc_id, unit_ref) are TEXT and NEVER
-- foreign keys: the spine is a DIFFERENT DATABASE with a different lifecycle,
-- and an FK would couple this service's writes to the spine's redirect chain.
--
-- Money is string amounts end-to-end, per the FIDELITY DOCTRINE: a price is
-- recorded as observed, not as a float that has already lost digits.
-- ============================================================================

CREATE TABLE collection (
  id         uuid PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES app_user(id),
  name       text NOT NULL,
  kind       text NOT NULL CHECK (kind IN ('owned','ordered','wished','custom')),
  privacy    text NOT NULL DEFAULT 'private',
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX collection_user_idx ON collection (user_id) WHERE deleted_at IS NULL;

CREATE TABLE holding (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES app_user(id),
  collection_id  uuid REFERENCES collection(id),
  head_id        text,          -- spine head/redirect-chain id, when resolved
  gtin14         text,          -- the Compare seed we actually hold
  mfc_id         text,          -- provenance of an imported row
  unit_ref       text,          -- the UNIT layer: serial/cert/impression; NULL for plain figures
  status         text NOT NULL CHECK (status IN ('owned','ordered','wished')),
  count          integer NOT NULL DEFAULT 1,
  score          numeric(3,1),
  note           text,
  shop           text,
  price_paid_amount   text,     -- string amounts end-to-end (FIDELITY DOCTRINE)
  price_paid_currency text,
  acquired_at    date,
  wishability    smallint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

COMMENT ON COLUMN holding.head_id IS
  'Spine head id as TEXT. Never an FK: a different database and a different lifecycle.';
COMMENT ON COLUMN holding.price_paid_amount IS
  'String amount, per the fidelity doctrine. Never a float.';

CREATE INDEX holding_user_status_idx ON holding (user_id, status) WHERE deleted_at IS NULL;
CREATE INDEX holding_user_head_idx ON holding (user_id, head_id);
