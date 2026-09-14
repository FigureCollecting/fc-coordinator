// ============================================================================
// Device enrolment queries (plan §B.1 `device`, §A.4 "Identity").
//
// The JWK thumbprint of a device key is the ONLY durable auth state this
// service holds. Three rules are enforced here, not in the routes:
//
//   * REVOCATION IS revoked_at. Nothing deletes a device row, ever, so a
//     revoked key stays auditable and the same key can be re-enrolled later
//     without losing the history (the unique index is partial on
//     revoked_at IS NULL, which is what makes that possible).
//   * A SOFT-DELETED USER HAS NO DEVICES. Every lookup joins app_user and
//     requires deleted_at IS NULL, so ending an account ends its sessions
//     without touching a single device row.
//   * ONLY PUBLIC JWK PARAMETERS ARE STORED. publicJwkParams is an ALLOWLIST,
//     not a blocklist: a parameter nobody here has heard of does not reach the
//     column, which is the only version of this rule that survives a new key
//     type being invented.
//
// These take a minimal SqlClient rather than pg.Pool so a caller can hand in a
// transaction, and so nothing here depends on the pool's lifecycle.
// ============================================================================

export interface SqlClient {
  query<R>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export interface LiveDevice {
  deviceId: string;
  jkt: string;
}

export interface EnrolledDevice extends LiveDevice {
  enrolledAt: Date;
  /** false when this exact live (user, thumbprint) was already enrolled. */
  created: boolean;
}

export interface RevokedDevice extends LiveDevice {
  revokedAt: Date;
  /** false when the device was already revoked — the call is idempotent. */
  changed: boolean;
}

export type AppUserState = 'created' | 'existing' | 'deleted';

/** Public JWK members, by key type. Anything not named here is dropped. */
const PUBLIC_JWK_PARAMS = ['kty', 'crv', 'x', 'y', 'n', 'e', 'kid', 'alg', 'use'] as const;

export function publicJwkParams(jwk: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const param of PUBLIC_JWK_PARAMS) {
    const value = jwk[param];
    if (typeof value === 'string') out[param] = value;
  }
  return out;
}

/**
 * First sign-in creates the local row for an Authentik uuid. It carries no
 * credential material and no profile: identity stays Authentik's.
 * A soft-deleted user is NOT resurrected — the caller must refuse the request.
 */
export async function ensureAppUser(db: SqlClient, userId: string): Promise<AppUserState> {
  const inserted = await db.query<{ id: string }>(
    'INSERT INTO app_user (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING id',
    [userId],
  );
  if (inserted.rows.length === 1) return 'created';

  const existing = await db.query<{ deleted_at: Date | null }>(
    'SELECT deleted_at FROM app_user WHERE id = $1',
    [userId],
  );
  return existing.rows[0]?.deleted_at === null ? 'existing' : 'deleted';
}

export async function findLiveDevice(
  db: SqlClient,
  userId: string,
  jkt: string,
): Promise<LiveDevice | undefined> {
  const { rows } = await db.query<{ id: string; jkt: string }>(
    `SELECT d.id, d.jkt
       FROM device d
       JOIN app_user u ON u.id = d.user_id
      WHERE d.user_id = $1
        AND d.jkt = $2
        AND d.revoked_at IS NULL
        AND u.deleted_at IS NULL`,
    [userId, jkt],
  );
  const row = rows[0];
  return row ? { deviceId: row.id, jkt: row.jkt } : undefined;
}

export interface EnrolDeviceInput {
  userId: string;
  jkt: string;
  jwk: Record<string, unknown>;
  label?: string | undefined;
}

export async function enrollDevice(db: SqlClient, input: EnrolDeviceInput): Promise<EnrolledDevice> {
  // The conflict target names the PARTIAL index's predicate, so re-enrolling a
  // thumbprint that is currently live is a no-op while re-enrolling one that
  // was revoked inserts a NEW row and leaves the revoked one in place.
  const inserted = await db.query<{ id: string; enrolled_at: Date }>(
    `INSERT INTO device (id, user_id, label, jkt, jwk)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)
     ON CONFLICT (user_id, jkt) WHERE revoked_at IS NULL DO NOTHING
     RETURNING id, enrolled_at`,
    [input.userId, input.label ?? null, input.jkt, JSON.stringify(publicJwkParams(input.jwk))],
  );

  const created = inserted.rows[0];
  if (created) {
    return { deviceId: created.id, jkt: input.jkt, enrolledAt: created.enrolled_at, created: true };
  }

  const existing = await db.query<{ id: string; enrolled_at: Date }>(
    'SELECT id, enrolled_at FROM device WHERE user_id = $1 AND jkt = $2 AND revoked_at IS NULL',
    [input.userId, input.jkt],
  );
  const row = existing.rows[0]!;
  return { deviceId: row.id, jkt: input.jkt, enrolledAt: row.enrolled_at, created: false };
}

export async function revokeDevice(
  db: SqlClient,
  input: { userId: string; deviceId: string },
): Promise<RevokedDevice | undefined> {
  // One statement, two outcomes. The second branch reads the pre-UPDATE
  // snapshot, so a row this statement just revoked cannot also match it — the
  // UNION ALL returns exactly one row or none.
  const { rows } = await db.query<{ id: string; jkt: string; revoked_at: Date; changed: boolean }>(
    `WITH updated AS (
       UPDATE device SET revoked_at = now()
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
       RETURNING id, jkt, revoked_at
     )
     SELECT id, jkt, revoked_at, true AS changed FROM updated
     UNION ALL
     SELECT id, jkt, revoked_at, false AS changed
       FROM device
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NOT NULL`,
    [input.deviceId, input.userId],
  );

  const row = rows[0];
  return row
    ? { deviceId: row.id, jkt: row.jkt, revokedAt: row.revoked_at, changed: row.changed }
    : undefined;
}
