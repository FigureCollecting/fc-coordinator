/**
 * THE ANSWER THAT IS NOT AN ANSWER — the gRPC successor to
 * test/entitlements/redirect.test.ts's Check half.
 *
 * WHAT THE OLD FILE FOUND. fail-closed.test.ts enumerated 504, 503, 500, 429,
 * 401 and 403 and proved each denied, all for the same reason: axios's default
 * `validateStatus` rejected them. A 3xx never reached that rule — axios FOLLOWED
 * it, and the answer arrived as a 200 from somewhere else entirely. So
 * "fail-closed on every non-2xx" was true of every class that had been tested
 * and false of the one that had not, and a redirect target answering
 * `{"allowed": true}` could issue the grant, unauthenticated. The bearer is
 * dropped on a cross-host hop, so what leaked was not a credential but the
 * DECISION.
 *
 * WHY IT IS NOT SIMPLY DELETED. gRPC has no redirects, so the specific trap is
 * gone — but "the trap is gone" is a claim about a transport, and the reasoning
 * that found it was not about redirects at all. It was: the rule was verified
 * against the failures someone thought to list, and the failure that mattered
 * was outside the list. Deleting the file would delete that, and the next
 * transport would get one fewer question asked of it.
 *
 * SO THE QUESTION IS RE-ASKED IN THE NEW VOCABULARY: what can arrive on this
 * hop that is neither a CheckResponse nor a gRPC status? Three things a
 * well-behaved server cannot produce, and all three are produced here on a raw
 * h2c socket:
 *
 *   A REDIRECT ANYWAY. A proxy or a middlebox can still answer 302 with a
 *   Location. The client must not follow it and must not read it as a decision.
 *   Asserted twice: the answer denies, AND the target records no request.
 *
 *   A NON-gRPC CONTENT TYPE. An ingress that answers HTML — a login page, an
 *   error page, a captive portal — with HTTP 200. This is the closest living
 *   relative of the redirect trap: a 200 that parses as something, carrying a
 *   body that claims a grant.
 *
 *   A PAYLOAD THAT DOES NOT DECODE. Correct gRPC framing, correct trailers,
 *   and bytes that are not a CheckResponse. Under HTTP this was `bad_body`;
 *   over gRPC it surfaces as a client-side decode failure, and the point is
 *   the same — an unrecognised answer is a FAULT, never a decision.
 *
 * EVERY CASE'S BODY CLAIMS A GRANT where a body is possible at all, for the
 * reason the old file gave: a case whose payload says nothing would deny under
 * a broken implementation too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grantsForSubject,
  resetEntitlementGrantsForTest,
  resetOpenFgaTokenForTest,
  setEntitlementAuditSink,
  type EntitlementAuditEvent,
} from '../../src/entitlements/index.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';
import { startRawH2cServer, type RawH2cServer } from '../helpers/rawH2cServer.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const T0 = 1_780_000_000_000;

let events: EntitlementAuditEvent[];
const open: RawH2cServer[] = [];

const track = (s: RawH2cServer): RawH2cServer => {
  open.push(s);
  return s;
};

const env = (baseUrl: string): NodeJS.ProcessEnv =>
  ({ OPENFGA_GRPC_URL: baseUrl, OPENFGA_STORE_ID: STORE }) as NodeJS.ProcessEnv;

/** A gRPC DATA frame: one uncompressed, length-prefixed message. */
const grpcFrame = (payload: Buffer): Buffer => {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};

beforeEach(() => {
  events = [];
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  setEntitlementAuditSink((e) => events.push(e));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  setEntitlementAuditSink(null);
  while (open.length > 0) await open.pop()?.close();
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

// ===========================================================================
// A REDIRECT THE TRANSPORT CANNOT FOLLOW
// ===========================================================================
describe('an endpoint that redirects', () => {
  it.each([301, 302, 303, 307, 308])(
    'denies on a %i and never dials the target',
    async (status) => {
      // The target is a REAL fake OpenFGA that would happily grant. If the
      // client followed anything, this call would come back allowed and the
      // target's call log would show it.
      const target: FakeOpenFga = await startFakeOpenFga(() => true);
      const redirector = track(
        await startRawH2cServer((stream) => {
          stream.respond({
            ':status': status,
            location: `${target.baseUrl}/openfga.v1.OpenFGAService/Check`,
            'content-type': 'application/grpc',
          });
          stream.end();
        }),
      );
      try {
        const grants = await grantsForSubject(SUB, T0, env(redirector.baseUrl));

        expect(grants).toEqual([]);
        // The whole of the old finding, inverted: the far side captured
        // nothing, so nothing it would have said could have been believed.
        expect(target.calls).toHaveLength(0);
        // `unknown` is what the gRPC protocol has to say about an HTTP status
        // it was never given a mapping for, and it is the honest answer: the
        // peer did not speak gRPC, so there is no gRPC status to report.
        expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'unknown' });
      } finally {
        await target.close();
      }
    },
  );
});

// ===========================================================================
// A 200 THAT IS NOT gRPC AT ALL
// ===========================================================================
describe('an h2c endpoint answering something other than gRPC', () => {
  it('denies on an HTML 200 whose body claims a grant', async () => {
    const server = track(
      await startRawH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'text/html; charset=utf-8' });
        stream.end('<html><body>{"allowed": true}</body></html>');
      }),
    );

    const grants = await grantsForSubject(SUB, T0, env(server.baseUrl));

    expect(grants).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'unknown' });
  });

  it('denies on a JSON 200 shaped exactly like the old REST answer', async () => {
    // The most dangerous shape there is: the body the HTTP client used to
    // accept, served at the gRPC endpoint. A client that had fallen back to
    // reading JSON would grant here.
    const server = track(
      await startRawH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/json' });
        stream.end(JSON.stringify({ allowed: true, resolution: '' }));
      }),
    );

    expect(await grantsForSubject(SUB, T0, env(server.baseUrl))).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'unknown' });
  });

  it('records the attempt as an error rather than a silent deny', async () => {
    // A deny and an error are different operational facts, and this is the one
    // place the difference is easy to lose: nothing threw at the socket, the
    // call simply came back unusable. Reported as a deny it would look like a
    // revoked user and nobody would look at the ingress.
    const server = track(
      await startRawH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'text/plain' });
        stream.end('ok');
      }),
    );

    await grantsForSubject(SUB, T0, env(server.baseUrl));

    expect(events[0]?.decision).toBe('error');
    expect(events[0]?.source).toBe('openfga');
  });
});

// ===========================================================================
// FRAMING RIGHT, BYTES WRONG
// ===========================================================================
describe('a gRPC response that does not decode', () => {
  it('denies when the payload is not a CheckResponse', async () => {
    const server = track(
      await startRawH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
        // Field 1 sent as LENGTH-DELIMITED (wire type 2) where CheckResponse
        // declares a bool (wire type 0), with a payload long enough that the
        // reader runs off the end of the message rather than shrugging.
        stream.write(grpcFrame(Buffer.from([0x0a, 0x7f, 0x01, 0x02])));
        stream.end();
      }),
    );

    const grants = await grantsForSubject(SUB, T0, env(server.baseUrl));

    expect(grants).toEqual([]);
    // `internal` rather than `unknown`: the peer DID speak gRPC, and the
    // failure is in the bytes it sent. The two codes tell an operator which
    // side of the ingress to look at, which is the whole value of recording it.
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'internal' });
  });

  it('denies when the framing promises a message and sends none', async () => {
    // An OK status with no message at all. There is no `allowed` to read, and
    // "no news is good news" is the exact shape of a fail-open.
    const server = track(
      await startRawH2cServer((stream) => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' });
        stream.end();
      }),
    );

    expect(await grantsForSubject(SUB, T0, env(server.baseUrl))).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', grpc_code: 'internal' });
  });
});
