import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, MAX_SEQ } from './cursor.js';

describe('the Delta cursor', () => {
  it('reads the empty cursor as the start of the feed', () => {
    expect(decodeCursor('')).toBe(0n);
  });

  it("spells the start of the feed only as '': the cursor a client holds before it applies anything", () => {
    expect(encodeCursor(0n)).toBe('');
    expect(decodeCursor(Buffer.from('v1:0').toString('base64url'))).toBeUndefined();
  });

  it('round-trips every seq a bigint column can hold', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_SEQ }), (seq) => {
        expect(decodeCursor(encodeCursor(seq))).toBe(seq);
      }),
    );
    expect(decodeCursor(encodeCursor(MAX_SEQ))).toBe(MAX_SEQ);
  });

  it('is opaque: no digits of the seq appear in it', () => {
    expect(encodeCursor(12345n)).not.toContain('12345');
  });

  it.each([
    ['not base64url', 'not-a-cursor!'],
    ['base64 padding', `${Buffer.from('v1:5').toString('base64')}==`],
    ['a foreign version', Buffer.from('v2:5').toString('base64url')],
    ['no seq', Buffer.from('v1:').toString('base64url')],
    ['a negative seq', Buffer.from('v1:-1').toString('base64url')],
    ['a leading zero', Buffer.from('v1:007').toString('base64url')],
    ['a seq past int8', Buffer.from(`v1:${MAX_SEQ + 1n}`).toString('base64url')],
    ['trailing bytes', Buffer.from('v1:5\n').toString('base64url')],
    ['a non-canonical spelling of a valid cursor', `${encodeCursor(5n).slice(0, -1)}${String.fromCharCode(encodeCursor(5n).charCodeAt(encodeCursor(5n).length - 1) + 1)}`],
  ])('refuses %s', (_why, cursor) => {
    expect(decodeCursor(cursor)).toBeUndefined();
  });

  it('refuses to encode a seq outside int8', () => {
    expect(() => encodeCursor(-1n)).toThrow(RangeError);
    expect(() => encodeCursor(MAX_SEQ + 1n)).toThrow(RangeError);
  });
});
