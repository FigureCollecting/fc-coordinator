/**
 * A FAKE OpenFGA, SERVING openfga.v1.OpenFGAService/Check OVER gRPC ON
 * CLEARTEXT h2c — the same shape the real service presents on :8081, and the
 * same shape the Linkerd proxy meets before it wraps the hop in mTLS.
 *
 * WHY A REAL SERVER AND NOT A MOCKED CLIENT, unchanged from the HTTP version
 * this replaces: the module under test builds a path, a message and a bearer,
 * and every one of those is a way to ask a question no tuple can answer.
 * Mocking the transport would assert the call we MEANT to make; a real socket
 * asserts the one we DID. That mattered more after the move, not less — the
 * path is now derived from the generated descriptor, the fields are protobuf
 * field numbers rather than JSON keys, and the bearer is gRPC metadata. All
 * three are new ways to be wrong, and all three are on the wire here.
 *
 * `http2.createServer` WITHOUT `allowHTTP1`, deliberately. gRPC is HTTP/2 only;
 * a server that also spoke HTTP/1.1 would let a client that had quietly fallen
 * back to Connect-over-h1 keep passing these tests, which is the exact
 * regression this unit exists to make impossible.
 */
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { Code, ConnectError, type ConnectRouter } from '@connectrpc/connect';
import { connectNodeAdapter } from '@connectrpc/connect-node';
import { OpenFGAService } from '../../src/entitlements/gen/openfga/v1/openfga_service_pb.js';

/** One Check, as the server saw it — metadata and message, not a JSON body. */
export interface FgaCall {
  /** The bearer presented as gRPC metadata, or undefined when none was sent. */
  authorization: string | undefined;
  /** The RPC the client dialled, from the descriptor rather than a URL. */
  method: string;
  storeId: string;
  user: string;
  relation: string;
  object: string;
  modelId: string;
}

/**
 * An answer that overrides `decide`.
 *
 * A gRPC server's two ways to answer are a MESSAGE or a STATUS CODE, so this is
 * the pair — `allowed` for the first, `code` for the second — where the HTTP
 * fake had a status and a body. `delayMs` holds the answer without sending
 * anything, which is the only way to make the client's deadline be the thing
 * that ends the call.
 */
export interface FgaReply {
  code?: Code;
  message?: string;
  allowed?: boolean;
  delayMs?: number;
  /**
   * Metadata to hang off the error. A ConnectError carries the response
   * headers and trailers, and `util.inspect` prints a Headers object's
   * contents — so this is the gRPC route by which logging an error OBJECT
   * rather than its message puts whatever the far side sent into the log.
   * Exists so that leak can be asserted against rather than assumed away.
   */
  metadata?: Record<string, string>;
}

export interface FakeOpenFga {
  /** `http://127.0.0.1:<port>` — cleartext h2c, no TLS, as inside the pod. */
  baseUrl: string;
  calls: FgaCall[];
  /** Override the next answers, or pass null to go back to `decide`. */
  reply: (next: FgaReply | null) => void;
  /**
   * Answer the NEXT call this way, once, then fall back. A sticky override
   * cannot express "unauthenticated first, then fine", and expressing that with
   * a timer is a race dressed as a test.
   */
  replyOnce: (next: FgaReply) => void;
  close: () => Promise<void>;
}

const never = new Promise<never>(() => {});

/**
 * @param decide answers one Check. `true` grants the relation asked about.
 */
export async function startFakeOpenFga(
  decide: (call: FgaCall) => boolean,
): Promise<FakeOpenFga> {
  const calls: FgaCall[] = [];
  let override: FgaReply | null = null;
  const queued: FgaReply[] = [];

  const routes = (router: ConnectRouter): ConnectRouter =>
    router.service(OpenFGAService, {
      check: async (req, ctx) => {
        const call: FgaCall = {
          authorization: ctx.requestHeader.get('authorization') ?? undefined,
          method: ctx.method.name,
          storeId: req.storeId,
          user: req.tupleKey?.user ?? '',
          relation: req.tupleKey?.relation ?? '',
          object: req.tupleKey?.object ?? '',
          modelId: req.authorizationModelId,
        };
        calls.push(call);

        const answer = queued.shift() ?? override;
        if (answer !== null && answer !== undefined) {
          // Hold the stream open and send nothing. `never` rather than a timer:
          // a timer that outlives the test is a leak, and the client's deadline
          // is what this shape exists to exercise.
          if (answer.delayMs !== undefined) await never;
          if (answer.code !== undefined) {
            throw new ConnectError(
              answer.message ?? 'fake openfga',
              answer.code,
              answer.metadata === undefined ? undefined : new Headers(answer.metadata),
            );
          }
          return { allowed: answer.allowed ?? false, resolution: '' };
        }
        return { allowed: decide(call), resolution: '' };
      },
    });

  const server = http2.createServer(connectNodeAdapter({ routes }));
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (s) => {
    sessions.add(s);
    s.once('close', () => sessions.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    reply: (next) => {
      override = next;
    },
    replyOnce: (next) => {
      queued.push(next);
    },
    close: async () => {
      // Sessions first: a handler parked on `never` holds a stream open, and
      // server.close() waits for streams. Destroying the session is what lets
      // the suite move on rather than hanging on its own fixture.
      for (const s of sessions) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
