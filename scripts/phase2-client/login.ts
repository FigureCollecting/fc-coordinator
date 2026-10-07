// A real authorization-code + PKCE (S256) sign-in against the fc-coordinator provider, the way a
// public client does it: discovery, a loopback listener on the registered redirect
// (http://localhost:5173/callback), one browser sign-in by a person, and the code exchange.
//
// The token request carries NO DPoP header. Authentik 2026.5.4 drops `cnf` from access tokens, so
// the coordinator binds devices by enrolment (binding.ts, path B); a token the IdP bound to one
// key would make B8's second device unrepresentable with one sign-in.
//
// Nothing secret is ever put into an error message: a refused exchange names the OAuth error
// code, never the body, the code or the verifier.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Transport } from './transport.js';

export class LoginError extends Error {}

export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}

export interface TokenSet {
  accessToken: string;
  /** Epoch ms. Authentik's fc-coordinator tokens live 10 minutes and come with no refresh grant. */
  expiresAt: number;
  /** The id and refresh tokens, if any: never used, never printed. */
  secrets: string[];
}

export interface CallbackListener {
  /** The redirect actually served: an ephemeral port is filled in. */
  redirectUri: string;
  code: Promise<string>;
  close(): Promise<void>;
}

export const SCOPE = 'openid profile email';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Where the redirect listener may live: IPv4 loopback, which is what browsers reach for "localhost". */
const REDIRECT_HOSTS = new Set(['127.0.0.1', 'localhost']);

export function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: challengeFor(verifier), state: randomBytes(24).toString('base64url') };
}

export function authorizationUrl(d: Discovery, p: { clientId: string; redirectUri: string; pkce: Pkce }): string {
  const url = new URL(d.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('scope', SCOPE);
  url.searchParams.set('state', p.pkce.state);
  url.searchParams.set('code_challenge', p.pkce.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function endpoint(doc: Record<string, unknown>, name: string): string {
  const value = doc[name];
  if (typeof value !== 'string') throw new LoginError(`discovery names no ${name}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LoginError(`discovery's ${name} is not a URL`);
  }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname)))) {
    throw new LoginError(`discovery's ${name} is not https: ${url.origin}`);
  }
  return value;
}

export async function discover(t: Transport, issuer: string): Promise<Discovery> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`;
  const res = await t.request({ method: 'GET', url: `${base}.well-known/openid-configuration`, headers: { accept: 'application/json' }, label: 'discovery' });
  let doc: Record<string, unknown>;
  try {
    if (res.status !== 200) throw new Error();
    doc = JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
  } catch {
    throw new LoginError(`OIDC discovery at ${base} answered ${res.status}, not a document`);
  }
  // Mix-up defence: the document must speak for the issuer we were told to trust.
  if (doc['issuer'] !== issuer) throw new LoginError(`discovery's issuer '${String(doc['issuer'])}' is not '${issuer}'`);
  const methods = doc['code_challenge_methods_supported'];
  if (Array.isArray(methods) && !methods.includes('S256')) throw new LoginError('the provider does not offer PKCE S256');
  return { issuer, authorizationEndpoint: endpoint(doc, 'authorization_endpoint'), tokenEndpoint: endpoint(doc, 'token_endpoint') };
}

export async function exchangeCode(
  t: Transport,
  d: Discovery,
  p: { code: string; verifier: string; redirectUri: string; clientId: string; now: () => number },
): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.verifier,
  });
  const res = await t.request({
    method: 'POST',
    url: d.tokenEndpoint,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    label: 'token',
  });
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(new TextDecoder().decode(res.body)) as Record<string, unknown>;
  } catch {
    // An HTML error page from a proxy: the status says enough.
  }
  if (res.status !== 200) {
    const code = typeof body['error'] === 'string' && /^[a-z_]{1,64}$/.test(body['error']) ? body['error'] : 'no OAuth error code';
    throw new LoginError(`the token endpoint answered ${res.status} (${code})`);
  }
  const accessToken = body['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') throw new LoginError('the token response carries no access_token');
  const expiresIn = body['expires_in'];
  if (typeof expiresIn !== 'number' || !(expiresIn > 0)) throw new LoginError('the token response carries no expires_in');
  const secrets = [body['id_token'], body['refresh_token']].filter((v): v is string => typeof v === 'string');
  return { accessToken, expiresAt: p.now() + expiresIn * 1000, secrets };
}

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
};

/**
 * Serve the redirect on loopback only, until one callback carries the expected state. A callback
 * with another state is answered 400 and ignored (it is not ours); an `error` ends the sign-in.
 */
export async function listenForCallback(o: { redirectUri: URL; state: string; timeoutMs: number }): Promise<CallbackListener> {
  if (o.redirectUri.protocol !== 'http:' || !REDIRECT_HOSTS.has(o.redirectUri.hostname)) {
    throw new LoginError(`the redirect must be http on IPv4 loopback, got ${o.redirectUri.origin}`);
  }
  let settle: { resolve: (code: string) => void; reject: (error: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  code.catch(() => {});

  const server = http.createServer((req, res) => {
    const url = new URL(String(req.url), 'http://loopback');
    const reply = (status: number, text: string): void => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`${text}\n`);
    };
    if (req.method !== 'GET' || url.pathname !== o.redirectUri.pathname) return reply(404, 'not found');
    if (!sameSecret(url.searchParams.get('state') ?? '', o.state)) return reply(400, 'this sign-in was not started here');
    const error = url.searchParams.get('error');
    if (error !== null) {
      const named = /^[a-z_]{1,64}$/.test(error) ? error : 'unrecognised error';
      settle?.reject(new LoginError(`the authorization server refused the sign-in: ${named}`));
      return reply(400, 'sign-in refused; see the terminal');
    }
    const received = url.searchParams.get('code');
    if (received === null || received === '') return reply(400, 'no code in this redirect');
    settle?.resolve(received);
    return reply(200, 'fc-coordinator phase-2 client: sign-in received. You can close this tab.');
  });
  const sockets = new Set<Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  // localhost is served on IPv4 loopback; browsers try it for "localhost".
  const host = '127.0.0.1';
  const port = Number(o.redirectUri.port);
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(new LoginError(`cannot listen on ${host}:${port} for the redirect (${String(error.code)}); is something else, fc-mobile's dev server say, holding it?`)),
    );
    server.listen(port, host, () => resolve());
  });
  const served = new URL(o.redirectUri.href);
  served.port = String((server.address() as AddressInfo).port);

  const timer = setTimeout(() => settle?.reject(new LoginError(`no sign-in within ${Math.round(o.timeoutMs / 1000)} s`)), o.timeoutMs);
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= new Promise<void>((resolve) => {
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
    return closed;
  };
  return { redirectUri: served.toString(), code, close };
}
