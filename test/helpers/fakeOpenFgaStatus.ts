/**
 * A FAKE OpenFGA THAT CAN LIE THE WAY THE REAL ONE DOES: it writes OpenFGA's
 * OWN error numbers into the `grpc-status` trailer, outside the canonical 0–16
 * range that gRPC defines.
 *
 * WHY test/helpers/fakeOpenFga.ts CANNOT DO THIS, which is the whole reason
 * this file exists. That fake serves through `connectNodeAdapter`, so every
 * status it emits is a valid `Code` by construction — its reply type is
 * `code?: Code` and there is no value of it that reproduces what the real
 * binary sends. A fake that cannot express the failure cannot test it, and the
 * first round of this unit passed a full suite while the re-mint path was dead
 * against the real service. The fake agreed with the client because both were
 * built from the same wrong assumption.
 *
 * WHAT THE REAL SERVICE SENDS (openfga/api errors_ignore.proto @ 7a79d2a,
 * sha256 fb356436851b49898c57420f7efac8145c078871c9cfa11f10188c3615dfff9d):
 *
 *   AuthErrorCode   1001 invalid_subject   1002 invalid_audience
 *                   1003 invalid_issuer    1004 invalid_claims
 *                   1005 invalid_bearer_token
 *                   1010 bearer_token_missing
 *                   1500 unauthenticated   1600 forbidden
 *   ErrorCode       2000 validation_error  2001 authorization_model_not_found …
 *
 * Connect maps any of those to `Code.Internal` with the message
 * "invalid grpc-status: 1010", and hands the RAW TRAILER through as the error's
 * `metadata` — which is where grants.ts reads the number back from.
 *
 * TRAILERS-ONLY on the error path, because that is the shape a gRPC server uses
 * when it refuses before producing a message: one HEADERS frame carrying
 * `:status 200`, the grpc content type, and `grpc-status`. No DATA frame.
 */
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { create, toBinary } from '@bufbuild/protobuf';
import { CheckResponseSchema } from '../../src/entitlements/gen/openfga/v1/openfga_service_pb.js';

/** One answer. A raw status, or a real CheckResponse. */
export type RawReply =
  | {
      /** Written verbatim into `grpc-status`. Canonical or not — that is the point. */
      status: number;
      /**
       * Written verbatim into `grpc-message`. A real service puts a human
       * string here, and a badly-behaved one can put anything it was given —
       * which is why there is a test that echoes the bearer back through it.
       */
      message?: string;
    }
  | { allowed: boolean };

export interface RawFgaCall {
  authorization: string | undefined;
  path: string;
}

export interface FakeOpenFgaStatus {
  baseUrl: string;
  calls: RawFgaCall[];
  /** Answers are taken from the front of this queue; the last one repeats. */
  script: (replies: RawReply[]) => void;
  close: () => Promise<void>;
}

/** gRPC length-prefixed framing: one uncompressed message. */
const frame = (payload: Uint8Array): Buffer => {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, Buffer.from(payload)]);
};

export async function startFakeOpenFgaStatus(
  initial: RawReply[] = [{ allowed: true }],
): Promise<FakeOpenFgaStatus> {
  const calls: RawFgaCall[] = [];
  let queue: RawReply[] = [...initial];

  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (s) => {
    sessions.add(s);
    s.once('close', () => sessions.delete(s));
  });
  server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const authorization = headers['authorization'];
    calls.push({
      authorization: typeof authorization === 'string' ? authorization : undefined,
      path: String(headers[':path'] ?? ''),
    });
    stream.on('error', () => {});
    // Read the request off the wire before answering: a server that never
    // drains can stall the stream ahead of its own response.
    stream.on('data', () => {});
    stream.on('end', () => {
      const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? { allowed: false };
      if ('status' in reply) {
        // TRAILERS-ONLY. `:status` is 200 — the HTTP request succeeded; it is
        // the gRPC status that refuses, which is exactly the trap: nothing at
        // the HTTP layer says anything went wrong.
        stream.respond(
          {
            ':status': 200,
            'content-type': 'application/grpc',
            'grpc-status': String(reply.status),
            ...(reply.message === undefined ? {} : { 'grpc-message': encodeURIComponent(reply.message) }),
          },
          { endStream: true },
        );
        return;
      }
      // The success path is a DATA frame plus a TRAILER carrying grpc-status 0,
      // which is where a real gRPC server puts it once it has produced a
      // message. `waitForTrailers` is what lets node emit one.
      stream.respond(
        { ':status': 200, 'content-type': 'application/grpc' },
        { waitForTrailers: true },
      );
      stream.once('wantTrailers', () => {
        stream.sendTrailers({ 'grpc-status': '0' });
      });
      stream.end(
        frame(
          toBinary(
            CheckResponseSchema,
            create(CheckResponseSchema, { allowed: reply.allowed, resolution: '' }),
          ),
        ),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    script: (replies) => {
      queue = [...replies];
    },
    close: async () => {
      for (const s of sessions) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
