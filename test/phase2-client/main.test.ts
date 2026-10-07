// The entry point: --plan by default and zero requests in it (acceptance (b)), asserted by the
// client's own transport counter, by a fetch spy, and from OUTSIDE by a TCP listener that counts
// every connection a real `npm run phase2` process makes. Then the live run's refusals: a target
// that is not the coordinator stops the run before anyone is asked to sign in.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateClientKey, type ClientKey } from '../../scripts/phase2-client/dpop.js';
import { liveDeps, main, type MainDeps } from '../../scripts/phase2-client/main.js';
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

/** The secrets, or JWT segments of them, that appear in the output. */
const printed = (output: string, secrets: string[]): string[] =>
  secrets.flatMap((s) => [s, ...s.split('.').filter((part) => part.length >= 16)]).filter((needle) => output.includes(needle));

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

  it('shows the B1 inputs it was given and a root prefix', async () => {
    const c = capture(createFetchTransport());
    const args = ['--target', CANARY, '--prefix', '', '--b1-request', '{"gtin14":"04573102591234","nowIso":"2026-09-14T12:00:00.000Z"}', '--b1-reference', '/evidence/a7.json'];
    expect(await main(args, c.deps)).toBe(0);
    expect(c.stdout()).toContain('prefix    (root)');
    expect(c.stdout()).toContain('Compare (the --b1-request): 200, result_json byte-identical to /evidence/a7.json');
    expect(c.stdout()).toContain('GET /auth/session with no credentials');
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

describe('liveDeps', () => {
  it('is the real process: its streams, a fresh counted transport, the clock, and a file reader', async () => {
    const deps = liveDeps();
    expect(deps.stdout).toBe(process.stdout);
    expect(deps.stderr).toBe(process.stderr);
    expect(deps.transport.count).toBe(0);
    expect(deps.now).toBe(Date.now);
    expect(deps.pollMs).toBe(5_000);
    expect(deps.generateKey).toBe(generateClientKey);
    await expect(deps.openBrowser('https://example.invalid/')).resolves.toBeUndefined();
    await expect(deps.awaitRestart()).resolves.toBeUndefined();
    const started = Date.now();
    await deps.sleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'fc-phase2-deps-')), 'ref.json');
    writeFileSync(file, 'abc');
    expect(Array.from(await deps.readFile(file))).toEqual([97, 98, 99]);
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
  const routed = async (rewrite?: (req: HttpRequest) => boolean, noncePeriodSeconds = 300): Promise<Transport & { labels: string[] }> => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const userId = randomUUID();
    let mint: (claims?: Record<string, unknown>) => Promise<string> = async () => '';
    provider = await startFakeOidcProvider({ clientId: CLIENT_ID, mintAccessToken: () => mint(), mintIdToken: () => mint({ preferred_username: 'phase2-test' }) });
    const issuer = await makeIssuer({ issuer: provider.issuer, audience: CLIENT_ID });
    mint = (claims = {}) => issuer.mint({ ...claims, sub: userId });
    app = buildCoordinator({ issuer, origin: ORIGIN, devices: memoryDevices(), logLines: [], noncePeriodSeconds });
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
    expect(c.stderr()).toMatch(/^aborted: connect ECONNRESET DPoP \[redacted\]$/m);
    expect(printed(c.stdout() + c.stderr(), provider!.secrets())).toEqual([]);
  });

  it('scrubs every kind of secret out of a Connect error body and out of a network error', async () => {
    const transport = await routed();
    const keys: ClientKey[] = [];
    let proof = '';
    let nonce = '';
    // One of each kind the run holds, each named, so a test can say which one got through.
    const everySecret = (): [string, string][] => {
      const grant = provider!.grants[0]!;
      const key = keys[0]!;
      return [
        ['access', grant.accessToken],
        ['id', grant.idToken],
        ['refresh', grant.refreshToken],
        ['code', grant.code],
        ['verifier', grant.verifier],
        ['proof', proof],
        ['nonce', nonce],
        ['x', key.publicJwk.x!],
        ['y', key.publicJwk.y!],
        ['jkt', key.jkt],
      ];
    };
    const embedded = (): string => everySecret().map(([kind, value]) => `${kind}=${value}`).join(' ');
    const hostile: Transport = {
      get count() {
        return transport.count;
      },
      request: async (req) => {
        if (req.label === 'B2') throw new Error(`connect ECONNRESET ${embedded()}`);
        proof = req.headers['dpop'] ?? proof;
        const res = await transport.request(req);
        nonce = res.headers.get('dpop-nonce') ?? nonce;
        return req.label === 'B1' ? withStatus(res, 500, JSON.stringify({ code: embedded() })) : res;
      },
    };
    const c = capture(hostile, {
      openBrowser: signInLikeABrowser,
      generateKey: async () => {
        const key = await generateClientKey();
        keys.push(key);
        return key;
      },
    });
    expect(await main([...live, '--issuer', provider!.issuer, '--b1-request', '{"gtin14":"04573102591234","nowIso":"2026-09-14T12:00:00.000Z"}'], c.deps)).toBe(2);
    // Anti-vacuous: ten distinct secrets, the id token not a copy of the access token.
    expect(new Set(everySecret().map(([, value]) => value)).size).toBe(10);
    const scrubbed = everySecret().map(([kind]) => `${kind}=[redacted]`).join(' ');
    expect(c.stdout()).toContain(`\nB1        FAIL Compare answered 500 ${scrubbed}\n`);
    expect(c.stderr()).toContain(`\naborted: connect ECONNRESET ${scrubbed}\n`);
    expect(printed(c.stdout() + c.stderr(), everySecret().map(([, value]) => value))).toEqual([]);
  });

  it('runs to the end on its own, and fails the run when the cleanup revoke is refused', async () => {
    const transport = await routed(undefined, 0.3);
    const refusing: Transport = {
      get count() {
        return transport.count;
      },
      request: async (req) => {
        const res = await transport.request(req);
        return req.label === 'cleanup' ? withStatus(res, 404, '{"error":"device_not_found"}') : res;
      },
    };
    const c = capture(refusing, { openBrowser: signInLikeABrowser, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
    // A short nonce period so B6 is quick, and no time for B7, which has no restart here.
    const exit = await main([...live, '--issuer', provider!.issuer, '--nonce-period-seconds', '0.3', '--restart-timeout-seconds', '0.05'], c.deps);
    expect(exit).toBe(1);
    expect(c.stdout()).toMatch(/^cleanup +FAIL revoking the run's first device .* answered 404$/m);
    expect(c.stdout()).toMatch(/^B7 +INCONCLUSIVE no restart observed/m);
    expect(c.stdout()).toMatch(/^requests sent: \d+$/m);
  }, 30_000);

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
