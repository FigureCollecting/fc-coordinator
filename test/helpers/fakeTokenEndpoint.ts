/**
 * A FAKE OAuth2 `client_credentials` token endpoint, standing in for Authentik.
 *
 * A real socket rather than a mocked axios, for the same reason fakeOpenFga.ts
 * is one: the thing under test builds a form body and url-encodes two secrets
 * into it, and a mock asserts the call we MEANT to make. This records the bytes
 * that actually went over the wire, so a missing `--data-urlencode` equivalent
 * shows up as a password that does not round-trip.
 *
 * A DISTINCT TOKEN PER REQUEST, by default, and that default is load-bearing.
 * It used to hand out the constant `token-1` however many times it was asked,
 * which is not what an identity provider does — Authentik issues a separate JWT
 * per grant. The difference is invisible to most tests and decisive for one: a
 * caller asking "is the token in the cache the one I was refused with?" gets
 * `true` from a constant fake no matter what happened in between, so a fix that
 * turns on exactly that question measured as a no-op and was written off. It is
 * not a no-op; it takes 26 mints to 2. See test/entitlements/mint-storm.test.ts.
 *
 * Pass `initial`, or call `reply`, to pin a fixed answer where a test needs to
 * name the token it expects; `reply(null)` goes back to minting distinct ones.
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
  /**
   * Every `access_token` this endpoint actually handed out, in order.
   *
   * Exposed so a test that DEPENDS on the tokens being distinct can prove they
   * were, rather than inheriting it from a default someone may later change
   * back. That is the assumption whose silent failure hid a working fix.
   */
  issued: string[];
  /** Swap the answer mid-test: the next call gets this. `null` restores the default. */
  reply: (next: TokenReply | null) => void;
  close: () => Promise<void>;
}

export async function startFakeTokenEndpoint(initial?: TokenReply): Promise<FakeTokenEndpoint> {
  const calls: TokenCall[] = [];
  const issued: string[] = [];
  /** null means "mint a fresh one", which is the default and what a real IdP does. */
  let next: TokenReply | null = initial ?? null;
  let minted = 0;

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
      const answer: TokenReply =
        next ?? { body: { access_token: `token-${++minted}`, token_type: 'Bearer', expires_in: 600 } };
      const status = answer.status ?? 200;
      // Recorded from the answer actually sent, pinned or minted, so `issued`
      // never disagrees with what went down the socket.
      const token = (answer.body as { access_token?: unknown } | undefined)?.access_token;
      if (typeof token === 'string') issued.push(token);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}));
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
    issued,
    reply: (r) => {
      next = r;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
