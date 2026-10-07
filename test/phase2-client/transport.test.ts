// The ONE door to the network. Every request the client sends goes through it and is counted,
// which is what lets --plan assert zero. It never follows a redirect: a 3xx carrying a token's
// request elsewhere is answered, not obeyed.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createFetchTransport } from '../../scripts/phase2-client/transport.js';

let server: http.Server | undefined;
const hits: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[] = [];

async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  hits.length = 0;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('createFetchTransport', () => {
  it('sends the method, headers and body, returns status, headers and bytes, and counts', async () => {
    const base = await serve((_req, res) => {
      res.writeHead(201, { 'dpop-nonce': 'n-1', 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    const t = createFetchTransport();
    expect(t.count).toBe(0);
    const res = await t.request({ method: 'POST', url: `${base}/api/x`, headers: { 'x-a': 'b' }, body: 'hello', label: 'test' });
    expect(t.count).toBe(1);
    expect(res.status).toBe(201);
    expect(res.headers.get('dpop-nonce')).toBe('n-1');
    expect(new TextDecoder().decode(res.body)).toBe('{"ok":true}');
    expect(hits[0]).toMatchObject({ method: 'POST', url: '/api/x', body: 'hello' });
    expect(hits[0]!.headers['x-a']).toBe('b');
  });

  it('answers a redirect instead of following it', async () => {
    const base = await serve((req, res) => {
      if (req.url === '/elsewhere') {
        res.writeHead(200);
        res.end('followed');
        return;
      }
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    const t = createFetchTransport();
    const res = await t.request({ method: 'GET', url: `${base}/start`, headers: {}, label: 'test' });
    expect(res.status).toBe(302);
    expect(hits.map((h) => h.url)).toEqual(['/start']);
  });

  it('counts a request that failed, and gives up after its timeout', async () => {
    const base = await serve(() => {
      /* never answers */
    });
    const t = createFetchTransport({ timeoutMs: 100 });
    await expect(t.request({ method: 'GET', url: `${base}/slow`, headers: {}, label: 'test' })).rejects.toThrow();
    expect(t.count).toBe(1);
  });

  it('uses an injected fetch when given one', async () => {
    const seen: string[] = [];
    const t = createFetchTransport({
      fetch: async (input) => {
        seen.push(String(input));
        return new Response(null, { status: 204 });
      },
    });
    const res = await t.request({ method: 'GET', url: 'https://example.invalid/a', headers: {}, label: 'test' });
    expect(res.status).toBe(204);
    expect(seen).toEqual(['https://example.invalid/a']);
  });
});
