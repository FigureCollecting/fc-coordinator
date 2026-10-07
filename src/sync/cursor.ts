// The Delta cursor: base64url of `v1:<seq>`. Opaque to clients; the prefix lets the paging
// basis change without a wire break. Only the canonical spelling decodes, so one position has
// exactly one cursor and a client can compare cursors (StatusResponse.cursor). The start of the
// feed is '': the cursor a client holds before it has applied any transaction (rule 7).

const PREFIX = 'v1:';
const BODY = /^v1:(0|[1-9][0-9]{0,18})$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The largest value a PostgreSQL bigint (the seq column) can hold. */
export const MAX_SEQ = 2n ** 63n - 1n;

export function encodeCursor(seq: bigint): string {
  if (seq < 0n || seq > MAX_SEQ) throw new RangeError(`seq out of range: ${seq}`);
  if (seq === 0n) return '';
  return Buffer.from(`${PREFIX}${seq}`, 'latin1').toString('base64url');
}

/** The seq a cursor names; 0 for the empty cursor; undefined when it is unreadable. */
export function decodeCursor(cursor: string): bigint | undefined {
  if (cursor === '') return 0n;
  if (!BASE64URL.test(cursor)) return undefined;
  const match = BODY.exec(Buffer.from(cursor, 'base64url').toString('latin1'));
  if (match === null) return undefined;
  const seq = BigInt(match[1]!);
  if (seq > MAX_SEQ || encodeCursor(seq) !== cursor) return undefined;
  return seq;
}
