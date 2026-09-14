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

export interface FakeOpenFga {
  baseUrl: string;
  calls: FgaCall[];
  close: () => Promise<void>;
}

/**
 * @param decide answers one Check. `true` grants `inventory_levels`.
 */
export async function startFakeOpenFga(
  decide: (call: FgaCall) => boolean,
): Promise<FakeOpenFga> {
  const calls: FgaCall[] = [];
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
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
