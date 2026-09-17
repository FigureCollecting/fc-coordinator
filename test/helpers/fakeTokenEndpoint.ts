/**
 * A FAKE OAuth2 `client_credentials` token endpoint, standing in for Authentik.
 *
 * A real socket rather than a mocked axios, for the same reason fakeOpenFga.ts
 * is one: the thing under test builds a form body and url-encodes two secrets
 * into it, and a mock asserts the call we MEANT to make. This records the bytes
 * that actually went over the wire, so a missing `--data-urlencode` equivalent
 * shows up as a password that does not round-trip.
 */
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface TokenCall {
  method: string;
  contentType: string | undefined;
  authorization: string | undefined;
  /** The parsed form body, so a test can compare values rather than encodings. */
  form: Record<string, string>;
  /** The raw body, for asserting the encoding itself. */
  raw: string;
}

export interface TokenReply {
  status?: number;
  /** Anything but an object is sent verbatim, to exercise a malformed body. */
  body?: unknown;
}

export interface FakeTokenEndpoint {
  url: string;
  calls: TokenCall[];
  /** Swap the answer mid-test: the next call gets this. */
  reply: (next: TokenReply) => void;
  close: () => Promise<void>;
}

export async function startFakeTokenEndpoint(
  initial: TokenReply = { body: { access_token: 'token-1', token_type: 'Bearer', expires_in: 600 } },
): Promise<FakeTokenEndpoint> {
  const calls: TokenCall[] = [];
  let next: TokenReply = initial;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const form: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(raw)) form[k] = v;
      calls.push({
        method: req.method ?? '',
        contentType: req.headers['content-type'],
        authorization: req.headers.authorization,
        form,
        raw,
      });
      const status = next.status ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof next.body === 'string' ? next.body : JSON.stringify(next.body ?? {}));
    });
  });

  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/application/o/token/`,
    calls,
    reply: (r) => {
      next = r;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
