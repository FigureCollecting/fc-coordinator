// Defence in depth for "never prints tokens or key material": every line the client writes goes
// through one writer that knows every secret the run has handled and scrubs it. The client is
// built never to need it (the full-run test asserts zero redactions); this proves it works.
import { describe, expect, it } from 'vitest';
import { MIN_SECRET_LENGTH, REDACTED, createSafeOutput } from '../../scripts/phase2-client/output.js';

const sink = () => {
  const chunks: string[] = [];
  return { chunks, write: (chunk: string) => chunks.push(chunk), text: () => chunks.join('') };
};

describe('createSafeOutput', () => {
  it('writes lines to the right stream', () => {
    const out = sink();
    const err = sink();
    const o = createSafeOutput(out, err);
    o.out('to stdout');
    o.err('to stderr');
    expect(out.text()).toBe('to stdout\n');
    expect(err.text()).toBe('to stderr\n');
    expect(o.redactions).toBe(0);
  });

  it('scrubs a registered secret from both streams and counts it', () => {
    const out = sink();
    const err = sink();
    const o = createSafeOutput(out, err);
    o.secret('s3cr3t-value-123');
    o.out('token=s3cr3t-value-123 and again s3cr3t-value-123');
    o.err('s3cr3t-value-123');
    expect(out.text()).toBe(`token=${REDACTED} and again ${REDACTED}\n`);
    expect(err.text()).toBe(`${REDACTED}\n`);
    expect(o.redactions).toBe(3);
  });

  it('registers each segment of a JWT, so a fragment cannot leak either', () => {
    const out = sink();
    const o = createSafeOutput(out, sink());
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiI3ZjNhMWM2MiJ9.c2lnbmF0dXJlLWJ5dGVzLWhlcmU';
    o.secret(jwt);
    o.out('payload only: eyJzdWIiOiI3ZjNhMWM2MiJ9');
    o.out(`whole: ${jwt}`);
    expect(out.text()).toBe(`payload only: ${REDACTED}\nwhole: ${REDACTED}\n`);
  });

  it('ignores undefined and values too short to be secrets, so ordinary words survive', () => {
    const out = sink();
    const o = createSafeOutput(out, sink());
    o.secret(undefined);
    o.secret('B1');
    o.secret('x'.repeat(MIN_SECRET_LENGTH - 1));
    o.out(`B1 PASS ${'x'.repeat(MIN_SECRET_LENGTH - 1)}`);
    expect(out.text()).toBe(`B1 PASS ${'x'.repeat(MIN_SECRET_LENGTH - 1)}\n`);
    expect(o.redactions).toBe(0);
  });

  it('scrubs a secret of exactly the minimum length', () => {
    const out = sink();
    const o = createSafeOutput(out, sink());
    o.secret('y'.repeat(MIN_SECRET_LENGTH));
    o.out(`[${'y'.repeat(MIN_SECRET_LENGTH)}]`);
    expect(out.text()).toBe(`[${REDACTED}]\n`);
  });

  it('scrubs the longer of two overlapping secrets whole', () => {
    const out = sink();
    const o = createSafeOutput(out, sink());
    o.secret('abcdefgh');
    o.secret('abcdefgh-ijklmnop');
    o.out('abcdefgh-ijklmnop');
    expect(out.text()).toBe(`${REDACTED}\n`);
  });
});
