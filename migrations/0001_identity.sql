-- ============================================================================
-- 0001_identity.sql — identity and device enrolment (plan §B.1).
--
-- Identity is Authentik's. There is NO password, NO TOTP and NO WebAuthn in
-- this service — that absence is precisely what makes fc-coordinator a
-- REPLACEMENT for fc-backend rather than a second one. app_user.id IS the
-- Authentik uuid, which is also the entitlement `sub` and the OpenFGA subject.
--
-- Transaction boundaries are owned by scripts/migrate.sh (psql -1). This file
-- must contain no BEGIN/COMMIT and no CREATE INDEX CONCURRENTLY.
-- ============================================================================

CREATE TABLE app_user (
  id            uuid PRIMARY KEY,              -- Authentik uuid; never a local sequence
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz                    -- soft delete ONLY (user-data-retention-policy)
);

COMMENT ON TABLE app_user IS
  'Authentik-owned identity. No credential material is stored here, ever.';
COMMENT ON COLUMN app_user.id IS
  'The Authentik uuid: also the entitlement subject and the OpenFGA subject.';

-- DPoP (§A.4). The JWK thumbprint of a device key is the ONLY durable auth
-- state this service holds. Revocation sets revoked_at; rows are never deleted,
-- so a revoked key stays auditable.
CREATE TABLE device (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES app_user(id),
  label         text,
  jkt           text NOT NULL,                 -- RFC 7638 base64url SHA-256 thumbprint
  jwk           jsonb NOT NULL,                -- PUBLIC parameters only; never a private key
  enrolled_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz
);

COMMENT ON COLUMN device.jwk IS
  'Public JWK parameters only. A private key must never reach this column.';

-- One LIVE key per (user, thumbprint). Revoking frees the thumbprint for
-- re-enrolment without losing the revoked row.
CREATE UNIQUE INDEX device_user_jkt_live_uniq
  ON device (user_id, jkt)
  WHERE revoked_at IS NULL;

CREATE INDEX device_user_idx ON device (user_id);
