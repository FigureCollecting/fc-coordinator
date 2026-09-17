/**
 * THE STATUS CLASS NOBODY ASKED ABOUT.
 *
 * fail-closed.test.ts enumerates 504, 503, 500, 429, 401 and 403 and proves each
 * one denies. Every one of those reaches the deny path for the same reason:
 * axios's default `validateStatus` REJECTS it. A 3xx never reaches that path at
 * all — axios follows it and the answer arrives as a 200 from somewhere else
 * entirely. So "fail-closed on every non-2xx" was true of every class that was
 * tested and false of the one that was not, and it is the only class where the
 * failure is fail-OPEN.
 *
 * TWO CONSEQUENCES, AND THEY ARE DIFFERENT.
 *
 *   THE MINT. `follow-redirects` preserves the method AND the body across a
 *   307/308, including to another host. The body of the mint request is the
 *   service account's password and, when configured, the client secret. A token
 *   endpoint that answers 307 therefore hands both to whoever it names, and the
 *   token that host returns is cached and presented to OpenFGA as this
 *   service's credential. Measured before the fix: the redirect target received
 *   the full form body with the password intact, and `getOpenFgaToken` returned
 *   the attacker's token.
 *
 *   THE CHECK. The bearer IS dropped on a cross-host hop, so no credential
 *   leaks. What leaks is the DECISION: the redirect target answers
 *   `{"allowed": true}` and an unauthenticated third party has granted
 *   `inventory_levels`.
 *
 * The fix is one option in each place. A redirecting token endpoint or
 * authorization service is a misconfiguration, and following it is never the
 * right answer for a request that carries a credential or asks a security
 * question.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  grantsForSubject,
  resetEntitlementGrantsForTest,
  resetOpenFgaTokenForTest,
  setEntitlementAuditSink,
  type EntitlementAuditEvent,
} from '../../src/entitlements/index.js';
import {
  getOpenFgaToken,
  openFgaTokenCounters,
} from '../../src/entitlements/openfgaToken.js';
import { startFakeOpenFga, type FakeOpenFga } from '../helpers/fakeOpenFga.js';

const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';
const STORE = '01KXA5NRJYR0GYKX4NWQ2ANDZS';
const PASSWORD = 'p@ss word&with=specials+and/slashes';
const T0 = 1_780_000_000_000;

/** Every 3xx the two call sites could meet. 303 changes the method; the rest keep it. */
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

interface Recorded {
  url: string;
  method: string;
  body: string;
  authorization: string | undefined;
}

interface Server {
  baseUrl: string;
  seen: Recorded[];
  close: () => Promise<void>;
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The far side of the redirect: records everything it is given and answers helpfully. */
async function startRedirectTarget(body: unknown): Promise<Server> {
  const seen: Recorded[] = [];
  const { port, close } = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        method: req.method ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, seen, close };
}

/** A server whose only job is to point somewhere else. */
async function startRedirector(status: number, location: string): Promise<Server> {
  const seen: Recorded[] = [];
  const { port, close } = await listen((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        method: req.method ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        authorization: req.headers.authorization,
      });
      res.writeHead(status, { location });
      res.end();
    });
  });
  return { baseUrl: `http://127.0.0.1:${port}`, seen, close };
}

let events: EntitlementAuditEvent[];
const open: Server[] = [];

beforeEach(() => {
  events = [];
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  setEntitlementAuditSink((e) => events.push(e));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  setEntitlementAuditSink(null);
  while (open.length > 0) await open.pop()!.close();
  resetEntitlementGrantsForTest();
  resetOpenFgaTokenForTest();
  vi.restoreAllMocks();
});

const track = <T extends Server>(s: T): T => {
  open.push(s);
  return s;
};

const oidcEnv = (tokenEndpoint: string, over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv =>
  ({
    OPENFGA_OIDC_TOKEN_ENDPOINT: tokenEndpoint,
    OPENFGA_OIDC_CLIENT_ID: 'openfga',
    OPENFGA_OIDC_USERNAME: 'svc-openfga-fc-coordinator',
    OPENFGA_OIDC_PASSWORD: PASSWORD,
    OPENFGA_OIDC_CLIENT_SECRET: 'cs-super-secret-value',
    ...over,
  }) as NodeJS.ProcessEnv;

// ===========================================================================
// THE MINT — a credential-bearing POST must never be replayed elsewhere
// ===========================================================================
describe('a token endpoint that redirects', () => {
  it('sends the service-account password NOWHERE but the configured endpoint', async () => {
    const target = track(await startRedirectTarget({ access_token: 'stolen', expires_in: 600 }));
    const redirector = track(await startRedirector(307, `${target.baseUrl}/token`));

    const token = await getOpenFgaToken(oidcEnv(`${redirector.baseUrl}/token`), T0);

    // The whole finding, inverted into an assertion.
    expect(target.seen).toHaveLength(0);
    expect(token).toBeNull();

    // And said the other way round, so a future reader sees the actual stake:
    // nothing the far side captured can contain either credential, because it
    // captured nothing.
    const leaked = JSON.stringify(target.seen);
    expect(leaked).not.toContain('password');
    expect(leaked).not.toContain('cs-super-secret-value');
  });

  it.each(REDIRECT_STATUSES)('fails the mint closed on a %i', async (status) => {
    const target = track(await startRedirectTarget({ access_token: 'stolen', expires_in: 600 }));
    const redirector = track(await startRedirector(status, `${target.baseUrl}/token`));

    expect(await getOpenFgaToken(oidcEnv(`${redirector.baseUrl}/token`), T0)).toBeNull();
    expect(target.seen).toHaveLength(0);
    expect(openFgaTokenCounters()['token_mint_failed']).toBe(1);
  });

  it('refuses a SAME-HOST redirect too — the rule is about following, not about hosts', async () => {
    // A same-origin redirect leaks nothing, so it is tempting to allow it. It is
    // still a token endpoint that is not where it says it is, and an allowance
    // shaped like "same host is fine" is one Host header away from not being.
    const redirector = track(await startRedirector(307, '/elsewhere'));

    expect(await getOpenFgaToken(oidcEnv(`${redirector.baseUrl}/token`), T0)).toBeNull();
    expect(redirector.seen).toHaveLength(1);
  });

  it('denies the read, names token_mint_failed, and never asks OpenFGA', async () => {
    const fga: FakeOpenFga = await startFakeOpenFga(() => true);
    const target = track(await startRedirectTarget({ access_token: 'stolen', expires_in: 600 }));
    const redirector = track(await startRedirector(307, `${target.baseUrl}/token`));
    try {
      const grants = await grantsForSubject(
        SUB,
        T0,
        oidcEnv(`${redirector.baseUrl}/token`, {
          OPENFGA_API_URL: fga.baseUrl,
          OPENFGA_STORE_ID: STORE,
        }),
      );

      expect(grants).toEqual([]);
      expect(fga.calls).toHaveLength(0);
      expect(target.seen).toHaveLength(0);
      expect(events[0]).toMatchObject({
        decision: 'error',
        reason: 'token_mint_failed',
        source: 'none',
      });
    } finally {
      await fga.close();
    }
  });
});

// ===========================================================================
// THE CHECK — a third party must not be able to issue the grant
// ===========================================================================
describe('an OpenFGA endpoint that redirects', () => {
  it('does not accept a grant issued by the redirect TARGET', async () => {
    // The bearer is dropped on a cross-host hop, so nothing leaks here. What
    // would leak is the answer: an unauthenticated third party granting
    // inventory_levels.
    const target = track(await startRedirectTarget({ allowed: true }));
    const redirector = track(await startRedirector(307, `${target.baseUrl}/check`));

    const grants = await grantsForSubject(SUB, T0, {
      OPENFGA_API_URL: redirector.baseUrl,
      OPENFGA_STORE_ID: STORE,
    } as NodeJS.ProcessEnv);

    expect(grants).toEqual([]);
    expect(target.seen).toHaveLength(0);
    expect(events[0]).toMatchObject({ decision: 'error', http_status: 307 });
  });

  it.each(REDIRECT_STATUSES)('denies on a %i whose body CLAIMS a grant', async (status) => {
    // The redirect response itself carries the grant, so a reader that treated
    // a 3xx as a success would find `allowed: true` waiting for it.
    const target = track(await startRedirectTarget({ allowed: true }));
    const { port, close } = await listen((_req, res) => {
      res.writeHead(status, {
        location: `${target.baseUrl}/check`,
        'content-type': 'application/json',
      });
      res.end(JSON.stringify({ allowed: true }));
    });
    open.push({ baseUrl: `http://127.0.0.1:${port}`, seen: [], close });

    const grants = await grantsForSubject(SUB, T0, {
      OPENFGA_API_URL: `http://127.0.0.1:${port}`,
      OPENFGA_STORE_ID: STORE,
    } as NodeJS.ProcessEnv);

    expect(grants).toEqual([]);
    expect(events[0]).toMatchObject({ decision: 'error', http_status: status });
  });
});

// ===========================================================================
// THE SOURCE
// ===========================================================================
describe('both call sites', () => {
  it.each([
    ['the mint', 'openfgaToken.ts'],
    ['the Check', 'grants.ts'],
  ])('configure maxRedirects: 0 on %s', (_label, file) => {
    // Behaviour alone cannot pin this: a change that removed the option AND
    // adjusted these fixtures would pass. The option is the claim, so the option
    // is what is asserted — the same belt-and-braces the validateStatus pin uses.
    const source = fs.readFileSync(
      path.resolve(import.meta.dirname, `../../src/entitlements/${file}`),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    expect(code).toMatch(/maxRedirects:\s*0/);
  });
});
