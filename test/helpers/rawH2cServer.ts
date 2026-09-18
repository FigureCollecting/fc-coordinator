/**
 * A RAW cleartext HTTP/2 server — no Connect adapter, no gRPC framing, no
 * protobuf. It answers a stream with exactly the bytes and headers it is given.
 *
 * WHY THIS EXISTS SEPARATELY FROM test/helpers/fakeOpenFga.ts. That fake is a
 * well-behaved OpenFGA: it can refuse, it can be slow, it can say no, but
 * everything it sends is a valid gRPC response because the adapter makes it
 * one. The failures worth testing at a transport boundary are the ones a
 * WELL-BEHAVED server cannot produce — a middlebox answering HTML, a proxy
 * redirecting, a payload that does not decode. Those are what this is for, and
 * a helper that could not produce them would quietly narrow the suite to
 * "OpenFGA behaves like OpenFGA".
 */
import * as http2 from 'node:http2';
import type { AddressInfo } from 'node:net';

export interface RawH2cServer {
  baseUrl: string;
  /** Every stream the server was asked to serve, by `:path`. */
  paths: string[];
  close: () => Promise<void>;
}

export type RawH2cHandler = (
  stream: http2.ServerHttp2Stream,
  headers: http2.IncomingHttpHeaders,
) => void;

export async function startRawH2cServer(handler: RawH2cHandler): Promise<RawH2cServer> {
  const paths: string[] = [];
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on('session', (s) => {
    sessions.add(s);
    s.once('close', () => sessions.delete(s));
  });
  server.on('stream', (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    paths.push(String(headers[':path'] ?? ''));
    // Drain the request body: the client sends a length-prefixed message and a
    // server that never reads it can stall the stream before the answer lands.
    stream.on('data', () => {});
    stream.on('error', () => {});
    handler(stream, headers);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    paths,
    close: async () => {
      for (const s of sessions) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
