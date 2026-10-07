// A FAKE Authentik authorization server for the Phase-2 client: discovery, an authorize endpoint
// that signs the user in at once and redirects with a code, and a token endpoint that checks the
// PKCE verifier (S256) before minting. It binds 127.0.0.1 on an ephemeral port and is never
// pointed at anything real. Every code, verifier and token it hands out is recorded, so a test
// can grep the client's output for them.
import { createHash, randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export const FAKE_PROVIDER_PATH = '/application/o/fc-coordinator/';

export interface IssuedGrant {
  code: string;
  verifier: string;
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

export interface FakeOidcProvider {
  /** The issuer the client is configured with, trailing slash included, as Authentik spells it. */
  issuer: string;
  authorizeCalls: URLSearchParams[];
  tokenCalls: URLSearchParams[];
  grants: IssuedGrant[];
  /** Every value this provider minted that the client must never print. */
  secrets(): string[];
  close(): Promise<void>;
}

export interface FakeOidcOptions {
  clientId: string;
  /** Mints the access token, so the coordinator under test can verify it. */
  mintAccessToken: () => Promise<string>;
  /** Override what discovery says, to test the client's refusals. */
  discovery?: (base: string) => Record<string, unknown>;
}

const challengeOf = (verifier: string): string => createHash('sha256').update(verifier, 'ascii').digest('base64url');

export async function startFakeOidcProvider(options: FakeOidcOptions): Promise<FakeOidcProvider> {
  const authorizeCalls: URLSearchParams[] = [];
  const tokenCalls: URLSearchParams[] = [];
  const grants: IssuedGrant[] = [];
  const pending = new Map<string, { challenge: string; redirectUri: string; clientId: string }>();
  let base = '';

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    if (req.method === 'GET' && url.pathname === `${FAKE_PROVIDER_PATH}.well-known/openid-configuration`) {
      json(
        res,
        200,
        options.discovery?.(base) ?? {
          issuer: `${base}${FAKE_PROVIDER_PATH}`,
          authorization_endpoint: `${base}/application/o/authorize/`,
          token_endpoint: `${base}/application/o/token/`,
          code_challenge_methods_supported: ['S256', 'plain'],
        },
      );
      return;
    }
    if (req.method === 'GET' && url.pathname === '/application/o/authorize/') {
      const q = url.searchParams;
      authorizeCalls.push(q);
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || q.get('client_id') !== options.clientId) {
        json(res, 400, { error: 'invalid_request' });
        return;
      }
      const code = randomBytes(24).toString('base64url');
      pending.set(code, { challenge: q.get('code_challenge') ?? '', redirectUri: q.get('redirect_uri') ?? '', clientId: q.get('client_id') ?? '' });
      const location = new URL(q.get('redirect_uri') ?? '');
      location.searchParams.set('code', code);
      location.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: location.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/application/o/token/') {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (raw += chunk));
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(raw);
          tokenCalls.push(form);
          const code = form.get('code') ?? '';
          const grant = pending.get(code);
          pending.delete(code);
          const verifier = form.get('code_verifier') ?? '';
          if (
            grant === undefined ||
            form.get('grant_type') !== 'authorization_code' ||
            form.get('client_id') !== grant.clientId ||
            form.get('redirect_uri') !== grant.redirectUri ||
            challengeOf(verifier) !== grant.challenge
          ) {
            json(res, 400, { error: 'invalid_grant', error_description: `refused code ${code}` });
            return;
          }
          const issued: IssuedGrant = {
            code,
            verifier,
            accessToken: await options.mintAccessToken(),
            idToken: await options.mintAccessToken(),
            refreshToken: randomBytes(32).toString('base64url'),
          };
          grants.push(issued);
          json(res, 200, {
            access_token: issued.accessToken,
            token_type: 'Bearer',
            expires_in: 600,
            id_token: issued.idToken,
            refresh_token: issued.refreshToken,
          });
        })();
      });
      return;
    }
    json(res, 404, { error: 'not_found' });
  });

  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    issuer: `${base}${FAKE_PROVIDER_PATH}`,
    authorizeCalls,
    tokenCalls,
    grants,
    secrets: () => grants.flatMap((g) => [g.code, g.verifier, g.accessToken, g.idToken, g.refreshToken]),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * The browser, for a test: follow the authorization URL to the provider, then follow its redirect
 * to the client's loopback listener, exactly as a signed-in browser would.
 */
export async function signInLikeABrowser(authorizationUrl: string): Promise<void> {
  const authorize = await fetch(authorizationUrl, { redirect: 'manual' });
  const location = authorize.headers.get('location');
  if (authorize.status !== 302 || location === null) throw new Error(`authorize answered ${authorize.status}`);
  const callback = await fetch(location, { redirect: 'manual' });
  await callback.text();
}
