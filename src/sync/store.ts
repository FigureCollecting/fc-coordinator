// SQL over migrations/0003_sync.sql. Each function runs on the client it is handed, so Push can
// hold one transaction across them. Versions are ordered by the contract's compareVersion in
// this process, never by SQL < or > (a locale collation is not bytewise).
import { canonicalInstant, compareVersion, parseVersion } from '@figurecollecting/fc-api-contract';

export interface SqlClient {
  query<R>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
}

export interface TxClient extends SqlClient {
  /** Pass an error to discard a connection whose state is unknown. */
  release(err?: Error | boolean): void;
}

export interface SyncPool extends SqlClient {
  connect(): Promise<TxClient>;
}

export type FacetOp = 'upsert' | 'delete';

export interface Facet {
  facetKey: string;
  version: string;
  op: FacetOp;
  /** JSON text exactly as pushed; '' for a tombstone. */
  payload: string;
}

export interface FeedEvent extends Facet {
  seq: bigint;
}

interface FacetRow {
  facet_key: string;
  version: string;
  op: FacetOp;
  payload: string;
}

const toFacet = (row: FacetRow): Facet => ({
  facetKey: row.facet_key,
  version: row.version,
  op: row.op,
  payload: row.payload,
});

/** 'sync' in ASCII. The two-int key space never meets migrate.sh's single-bigint lock. */
const LOCK_NAMESPACE = 0x73796e63;

/** Run `fn` in one transaction on one connection. */
export async function transaction<T>(pool: SyncPool, fn: (tx: TxClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  let broken: Error | undefined;
  try {
    await tx.query('BEGIN');
    const value = await fn(tx);
    await tx.query('COMMIT');
    return value;
  } catch (err) {
    try {
      await tx.query('ROLLBACK');
    } catch (rollbackError) {
      broken = rollbackError as Error;
    }
    throw err;
  } finally {
    tx.release(broken);
  }
}

/**
 * Serialise every writer of one user's feed until commit. seq is taken inside this lock, so per
 * user seq order is commit order and a Delta reader cannot pass a seq that commits later.
 */
export async function lockUser(tx: SqlClient, userId: string): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [LOCK_NAMESPACE, userId]);
}

/** The Postgres clock as a canonical bare instant, and in epoch microseconds. */
export async function serverNow(db: SqlClient): Promise<{ iso: string; micros: bigint }> {
  // to_json renders ISO 8601 whatever the session DateStyle.
  const { rows } = await db.query<{ now: string }>("SELECT to_json(clock_timestamp()) #>> '{}' AS now");
  const iso = canonicalInstant(rows[0]!.now);
  return { iso, micros: parseVersion(iso)!.micros };
}

export async function readFacet(db: SqlClient, userId: string, facetKey: string, forUpdate = false): Promise<Facet | undefined> {
  const { rows } = await db.query<FacetRow>(
    `SELECT facet_key, version, op, payload FROM facet_state WHERE user_id = $1 AND facet_key = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId, facetKey],
  );
  return rows[0] === undefined ? undefined : toFacet(rows[0]);
}

/**
 * The one place a pushed version meets the stored one. The caller holds lockUser in a
 * transaction. Last writer wins per facet: equal or older is not applied.
 */
export async function applyEvent(tx: SqlClient, userId: string, event: Facet): Promise<{ applied: boolean; current: Facet }> {
  const stored = await readFacet(tx, userId, event.facetKey, true);
  if (stored !== undefined && compareVersion(event.version, stored.version) <= 0) {
    return { applied: false, current: stored };
  }
  await tx.query(
    `WITH fed AS (
       INSERT INTO feed_event (user_id, facet_key, version, op, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING seq, user_id, facet_key, version, op, payload
     )
     INSERT INTO facet_state (user_id, facet_key, version, op, payload, seq)
     SELECT user_id, facet_key, version, op, payload, seq FROM fed
     ON CONFLICT (user_id, facet_key) DO UPDATE
       SET version = EXCLUDED.version, op = EXCLUDED.op, payload = EXCLUDED.payload, seq = EXCLUDED.seq`,
    [userId, event.facetKey, event.version, event.op, event.payload],
  );
  return { applied: true, current: event };
}

/** One page of a user's feed after `afterSeq`, in seq order. */
export async function readFeed(
  db: SqlClient,
  userId: string,
  afterSeq: bigint,
  limit: number,
): Promise<{ events: FeedEvent[]; hasMore: boolean }> {
  const { rows } = await db.query<FacetRow & { seq: string }>(
    `SELECT seq, facet_key, version, op, payload FROM feed_event
      WHERE user_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
    [userId, afterSeq.toString(), limit + 1],
  );
  return {
    events: rows.slice(0, limit).map((row) => ({ ...toFacet(row), seq: BigInt(row.seq) })),
    hasMore: rows.length > limit,
  };
}

/** The seq of a user's newest feed event; 0 for an empty feed. */
export async function feedHead(db: SqlClient, userId: string): Promise<bigint> {
  const { rows } = await db.query<{ head: string }>(
    'SELECT coalesce(max(seq), 0) AS head FROM feed_event WHERE user_id = $1',
    [userId],
  );
  return BigInt(rows[0]!.head);
}

/** The newest seq this database has issued to anyone; a cursor past it was never ours. */
export async function issuedHead(db: SqlClient): Promise<bigint> {
  const { rows } = await db.query<{ head: string }>(
    'SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS head FROM feed_event_seq',
  );
  return BigInt(rows[0]!.head);
}

export async function recordCursor(
  db: SqlClient,
  userId: string,
  deviceId: string,
  ackedSeq: bigint,
  deliveredSeq: bigint,
): Promise<void> {
  await db.query(
    `INSERT INTO feed_cursor (user_id, device_id, acked_seq, delivered_seq) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, device_id) DO UPDATE
       SET acked_seq = EXCLUDED.acked_seq, delivered_seq = EXCLUDED.delivered_seq, updated_at = now()`,
    [userId, deviceId, ackedSeq.toString(), deliveredSeq.toString()],
  );
}

export async function readReceipt(
  tx: SqlClient,
  userId: string,
  clientId: string,
): Promise<{ requestSha256: Buffer; outcomes: Buffer } | undefined> {
  const { rows } = await tx.query<{ request_sha256: Buffer; outcomes: Buffer }>(
    'SELECT request_sha256, outcomes FROM mutation_receipt WHERE user_id = $1 AND client_id = $2',
    [userId, clientId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { requestSha256: row.request_sha256, outcomes: row.outcomes };
}

export async function writeReceipt(
  tx: SqlClient,
  userId: string,
  clientId: string,
  requestSha256: Buffer,
  outcomes: Buffer,
): Promise<void> {
  await tx.query(
    'INSERT INTO mutation_receipt (user_id, client_id, request_sha256, outcomes) VALUES ($1, $2, $3, $4)',
    [userId, clientId, requestSha256, outcomes],
  );
}
