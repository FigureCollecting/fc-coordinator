// The entry point: --plan by default and zero requests in it (acceptance (b)), asserted by the
// client's own transport counter, by a fetch spy, and from OUTSIDE by a TCP listener that counts
// every connection a real `npm run phase2` process makes. Then the live run's refusals: a target
// that is not the coordinator stops the run before anyone is asked to sign in.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateClientKey } from '../../scripts/phase2-client/dpop.js';
import { main, type MainDeps } from '../../scripts/phase2-client/main.js';
import { createFetchTransport, type HttpRequest, type Transport } from '../../scripts/phase2-client/transport.js';
import { makeIssuer } from '../helpers/auth.js';
import { signInLikeABrowser, startFakeOidcProvider, type FakeOidcProvider } from '../helpers/fakeOidcProvider.js';
import { CLIENT_ID, buildCoordinator, injectTransport, memoryDevices, withStatus } from '../helpers/phase2Harness.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CANARY = 'https://fc-api-canary.mindsignals1.com';

interface Captured {
  deps: MainDeps;
  stdout: () => string;
  stderr: () => string;
}

function capture(transport: Transport, overrides: Partial<MainDeps> = {}): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    deps: {
      stdout: { write: (s: string) => out.push(s) },
      stderr: { write: (s: string) => err.push(s) },
      transport,
      openBrowser: async () => {
        throw new Error('no browser in this test');
      },
      generateKey: generateClientKey,
      awaitRestart: async () => {},
      readFile: async () => new Uint8Array(),
      now: Date.now,
      sleep: async () => {},
      pollMs: 1,
      ...overrides,
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('acceptance (b): --plan sends zero requests', () => {
  it('is the default, prints every step and case, and its transport counts zero', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const transport = createFetchTransport();
    const c = capture(transport);
    expect(await main(['--target', CANARY], c.deps)).toBe(0);
    expect(transport.count).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const text = c.stdout();
    expect(text).toMatch(/^PLAN: nothing is sent/m);
    expect(text).toContain(`target    ${CANARY}`);
    for (const id of ['B1', 'B2', 'B3', 'B4', 'B5b', 'B6', 'B7', 'B8', 'B9b']) expect(text).toMatch(new RegExp(`^  ${id} `, 'm'));
    expect(text).toContain('occ/<new occurrence uuid>/status');
    expect(text).toContain('occ/<new occurrence uuid>/head');
    expect(text).not.toContain('holding/');
    expect(text).toContain(`--confirm fc-api-canary.mindsignals1.com`);
    expect(text).toMatch(/^requests sent: 0$/m);
    expect(c.stderr()).toBe('');
  });

  it('plans without a target too, saying what a live run needs', async () => {
    const transport = createFetchTransport();
    const c = capture(transport);
    expect(await main([], c.deps)).toBe(0);
    expect(c.stdout()).toContain('target    none: a live run needs --target <origin> --confirm <host>');
    expect(transport.count).toBe(0);
  });

  it('opens no socket at all: a real process, watched by a listener that counts connections', async () => {
    let connections = 0;
    const watcher: Server = createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => watcher.listen(0, '127.0.0.1', () => resolve()));
    const port = (watcher.address() as { port: number }).port;
    try {
      // Target and issuer both point at the watcher: any request the plan made would land here.
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/phase2-client/cli.ts', '--target', `http://127.0.0.1:${port}`, '--issuer', `http://127.0.0.1:${port}/application/o/fc-coordinator/`],
        { cwd: REPO, encoding: 'utf8', timeout: 60_000 },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toMatch(/^requests sent: 0$/m);
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((resolve) => watcher.close(() => resolve()));
    }
  });
});

describe('the command line', () => {
  it('prints the usage for --help and exits 0', async () => {
    const c = capture(createFetchTransport());
    expect(await main(['--help'], c.deps)).toBe(0);
    expect(c.stdout()).toMatch(/^usage: npm run phase2 --/m);
  });

  it('exits 2 with the reason and the usage on a bad argument, sending nothing', async () => {
    const transport = createFetchTransport();
    const c = capture(transport);
    expect(await main(['--target', CANARY, '--confirm', 'figurecollecting.com'], c.deps)).toBe(2);
    expect(c.stderr()).toMatch(/does not match/);
    expect(c.stderr()).toMatch(/usage: npm run phase2 --/);
    expect(transport.count).toBe(0);
  });
});

describe('a live run that must stop early', () => {
  let app: FastifyInstance | undefined;
  let provider: FakeOidcProvider | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    await provider?.close();
    provider = undefined;
  });

  const ORIGIN = 'http://127.0.0.1:5999';
  const live = ['--target', ORIGIN, '--confirm', '127.0.0.1:5999', '--redirect-uri', 'http://127.0.0.1:0/callback'];

  /** The coordinator over inject, the provider over a real socket: one transport for both. */
  const routed = async (rewrite?: (req: HttpRequest) => boolean): Promise<Transport & { labels: string[] }> => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const userId = randomUUID();
    let mint: () => Promise<string> = async () => '';
    provider = await startFakeOidcProvider({ clientId: CLIENT_ID, mintAccessToken: () => mint() });
    const issuer = await makeIssuer({ issuer: provider.issuer, audience: CLIENT_ID });
    mint = () => issuer.mint({ sub: userId });
    app = buildCoordinator({ issuer, origin: ORIGIN, devices: memoryDevices(), logLines: [] });
    await app.ready();
    const coordinator = injectTransport(() => app!);
    const network = createFetchTransport();
    const labels: string[] = [];
    let count = 0;
    return {
      labels,
      get count() {
        return count;
      },
      async request(req) {
        count += 1;
        labels.push(req.label);
        const res = await (req.url.startsWith(ORIGIN) ? coordinator : network).request(req);
        return rewrite?.(req) === true ? withStatus(res, 404) : res;
      },
    };
  };

  it('stops before the sign-in when the target does not answer like the coordinator', async () => {
    const transport = await routed((req) => req.label === 'preflight');
    const c = capture(transport);
    expect(await main([...live, '--issuer', provider!.issuer], c.deps)).toBe(2);
    expect(transport.labels).toEqual(['preflight']);
    expect(c.stdout()).toMatch(/^preflight +FAIL /m);
    expect(provider!.authorizeCalls).toHaveLength(0);
  });

  it('stops when the provider cannot be discovered', async () => {
    const transport = await routed();
    const c = capture(transport);
    expect(await main([...live, '--issuer', provider!.issuer.replace('fc-coordinator', 'nope')], c.deps)).toBe(2);
    expect(c.stderr()).toMatch(/^sign-in failed: .*discovery/m);
  });

  it('stops before the sign-in when the B1 reference cannot be read', async () => {
    const transport = await routed();
    const c = capture(transport, {
      readFile: async () => {
        throw new Error('ENOENT: no such file');
      },
    });
    expect(await main([...live, '--issuer', provider!.issuer, '--b1-reference', '/nope/a7.json'], c.deps)).toBe(2);
    expect(c.stderr()).toMatch(/cannot read --b1-reference/);
    expect(transport.labels).toEqual([]);
  });

  it('aborts with exit 2 when the network fails mid-run, printing no secret', async () => {
    const transport = await routed();
    const failing: Transport = {
      get count() {
        return transport.count;
      },
      request: async (req) => {
        if (req.label === 'B2') throw new Error(`connect ECONNRESET ${req.headers['authorization'] ?? ''}`);
        return transport.request(req);
      },
    };
    const c = capture(failing, { openBrowser: signInLikeABrowser });
    expect(await main([...live, '--issuer', provider!.issuer], c.deps)).toBe(2);
    expect(c.stderr()).toMatch(/^aborted: connect ECONNRESET/m);
    expect(c.stderr()).toContain('[redacted]');
    expect(c.stderr()).not.toContain(provider!.grants[0]!.accessToken);
  });

  it('fails the sign-in when the enrolment is refused', async () => {
    const transport = await routed();
    const refusing: Transport = {
      get count() {
        return transport.count;
      },
      request: async (req) => {
        const res = await transport.request(req);
        return req.label === 'enrol' ? withStatus(res, 403, '{"error":"account_closed"}') : res;
      },
    };
    const c = capture(refusing, { openBrowser: signInLikeABrowser });
    expect(await main([...live, '--issuer', provider!.issuer], c.deps)).toBe(2);
    expect(c.stderr()).toMatch(/^aborted: enrolment answered 403/m);
  });
});
