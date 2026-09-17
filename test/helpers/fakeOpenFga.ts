/**
 * A FAKE OpenFGA Check endpoint, so the entitlement path can be driven
 * end-to-end without the real authz substrate — which, per plan decision D4, is
 * unreachable from production anyway.
 *
 * Plain `node:http` rather than a mocked axios: the module under test builds a
 * URL, a body and a bearer, and every one of those is a way to ask a question
 * no tuple can answer. Mocking axios would assert the call we MEANT to make;
 * a real socket asserts the one we DID.
 */
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface FgaCall {
  path: string;
  method: string;
  authorization: string | undefined;
  body: unknown;
}

/** An answer that overrides `decide` — a status, a body, or both. */
export interface FgaReply {
  status?: number;
  /** A string is sent verbatim, which is how a malformed body is exercised. */
  body?: unknown;
}

export interface FakeOpenFga {
  baseUrl: string;
  calls: FgaCall[];
  /**
   * Override the next answers, or pass null to go back to `decide`. The Check's
   * fail-closed rule is about NON-2xx and about wire surprises, and neither can
   * be produced by a fake that only ever answers 200 with a boolean.
   */
  reply: (next: FgaReply | null) => void;
  /**
   * Answer the NEXT call this way, once, then fall back. A sticky override
   * cannot express "401 first, then fine", and expressing that with a timer is
   * a race dressed as a test.
   */
  replyOnce: (next: FgaReply) => void;
  close: () => Promise<void>;
}

/**
 * @param decide answers one Check. `true` grants `inventory_levels`.
 */
export async function startFakeOpenFga(
  decide: (call: FgaCall) => boolean,
): Promise<FakeOpenFga> {
  const calls: FgaCall[] = [];
  let override: FgaReply | null = null;
  const queued: FgaReply[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const call: FgaCall = {
        path: req.url ?? '',
        method: req.method ?? '',
        authorization: req.headers.authorization,
        body,
      };
      calls.push(call);
      const once = queued.shift();
      if (once !== undefined) {
        res.writeHead(once.status ?? 200, { 'content-type': 'application/json' });
        res.end(typeof once.body === 'string' ? once.body : JSON.stringify(once.body ?? {}));
        return;
      }
      if (override !== null) {
        res.writeHead(override.status ?? 200, { 'content-type': 'application/json' });
        res.end(typeof override.body === 'string' ? override.body : JSON.stringify(override.body ?? {}));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ allowed: decide(call), resolution: '' }));
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
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    reply: (next) => {
      override = next;
    },
    replyOnce: (next) => {
      queued.push(next);
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
