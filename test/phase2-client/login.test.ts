// The login half: discovery, PKCE (S256), the loopback listener on the registered redirect, and
// the code exchange. Against a fake provider on a real socket, which checks the verifier the way
// Authentik does, so a wrong challenge fails here rather than at Ross's sign-in.
import { afterEach, describe, expect, it } from 'vitest';
import {
  LoginError,
  authorizationUrl,
  challengeFor,
  createPkce,
  discover,
  exchangeCode,
  listenForCallback,
  type CallbackListener,
} from '../../scripts/phase2-client/login.js';
import { createFetchTransport } from '../../scripts/phase2-client/transport.js';
import { startFakeOidcProvider, type FakeOidcProvider } from '../helpers/fakeOidcProvider.js';

const CLIENT_ID = 'fc-coordinator';
let provider: FakeOidcProvider | undefined;
let listener: CallbackListener | undefined;

afterEach(async () => {
  await listener?.close();
  listener = undefined;
  await provider?.close();
  provider = undefined;
});

const start = async (discovery?: (base: string) => Record<string, unknown>) => {
  provider = await startFakeOidcProvider({ clientId: CLIENT_ID, mintAccessToken: async () => `at-${Math.random().toString(36).slice(2)}-padding`, mintIdToken: async () => `id-${Math.random().toString(36).slice(2)}-padding`, ...(discovery ? { discovery } : {}) });
  return provider;
};

describe('PKCE', () => {
  it('derives the S256 challenge of RFC 7636 appendix B', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('mints a 43-character verifier, its challenge and a state, fresh each time', () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challenge).toBe(challengeFor(a.verifier));
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
  });

  it('builds the authorization request a public PKCE client sends', () => {
    const pkce = createPkce();
    const url = new URL(
      authorizationUrl(
        { issuer: 'https://idp.example/o/', authorizationEndpoint: 'https://idp.example/o/authorize/', tokenEndpoint: 'https://idp.example/o/token/' },
        { clientId: CLIENT_ID, redirectUri: 'http://localhost:5173/callback', pkce },
      ),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://idp.example/o/authorize/');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: 'http://localhost:5173/callback',
      scope: 'openid profile email',
      state: pkce.state,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });
  });
});

describe('discover', () => {
  it('reads the endpoints from the issuer it was configured with, in one request', async () => {
    const p = await start();
    const t = createFetchTransport();
    const d = await discover(t, p.issuer);
    expect(d.issuer).toBe(p.issuer);
    expect(d.authorizationEndpoint).toMatch(/\/application\/o\/authorize\/$/);
    expect(d.tokenEndpoint).toMatch(/\/application\/o\/token\/$/);
    expect(t.count).toBe(1);
  });

  it('refuses a document that names another issuer (mix-up)', async () => {
    const p = await start((base) => ({ issuer: `${base}/application/o/other/`, authorization_endpoint: `${base}/a`, token_endpoint: `${base}/t`, code_challenge_methods_supported: ['S256'] }));
    await expect(discover(createFetchTransport(), p.issuer)).rejects.toThrow(/issuer/);
  });

  it('refuses a cleartext endpoint off loopback, a missing endpoint and a provider without S256', async () => {
    let p = await start((base) => ({ issuer: `${base}/application/o/fc-coordinator/`, authorization_endpoint: 'http://idp.example/a', token_endpoint: `${base}/t` }));
    await expect(discover(createFetchTransport(), p.issuer)).rejects.toThrow(LoginError);
    await p.close();
    p = await start((base) => ({ issuer: `${base}/application/o/fc-coordinator/`, authorization_endpoint: `${base}/a` }));
    await expect(discover(createFetchTransport(), p.issuer)).rejects.toThrow(/token_endpoint/);
    await p.close();
    p = await start((base) => ({ issuer: `${base}/application/o/fc-coordinator/`, authorization_endpoint: `${base}/a`, token_endpoint: `${base}/t`, code_challenge_methods_supported: ['plain'] }));
    await expect(discover(createFetchTransport(), p.issuer)).rejects.toThrow(/S256/);
  });

  it('refuses an endpoint that is not a URL', async () => {
    const p = await start((base) => ({ issuer: `${base}/application/o/fc-coordinator/`, authorization_endpoint: 'not a url', token_endpoint: `${base}/t` }));
    await expect(discover(createFetchTransport(), p.issuer)).rejects.toThrow(/authorization_endpoint is not a URL/);
  });

  it('asks the issuer as configured, so one without its trailing slash is a different issuer', async () => {
    const p = await start();
    const t = createFetchTransport();
    await expect(discover(t, p.issuer.replace(/\/$/, ''))).rejects.toThrow(/issuer/);
    expect(t.count).toBe(1);
  });

  it('refuses a provider that does not answer with a document', async () => {
    const p = await start();
    await expect(discover(createFetchTransport(), p.issuer.replace('fc-coordinator', 'missing'))).rejects.toThrow(/discovery/);
  });
});

describe('the loopback listener and the code exchange', () => {
  it('takes the code from the redirect, closes, and exchanges it with the verifier', async () => {
    const p = await start();
    const t = createFetchTransport();
    const d = await discover(t, p.issuer);
    const pkce = createPkce();
    listener = await listenForCallback({ redirectUri: new URL('http://localhost:0/callback'), state: pkce.state, timeoutMs: 5_000 });
    expect(listener.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
    expect(listener.redirectUri).not.toBe('http://localhost:0/callback');

    const authorize = await fetch(authorizationUrl(d, { clientId: CLIENT_ID, redirectUri: listener.redirectUri, pkce }), { redirect: 'manual' });
    const callback = await fetch(authorize.headers.get('location')!.replace('localhost', '127.0.0.1'));
    expect(callback.status).toBe(200);
    expect(await callback.text()).toMatch(/close this tab/);
    const code = await listener.code;

    const tokens = await exchangeCode(t, d, { code, verifier: pkce.verifier, redirectUri: listener.redirectUri, clientId: CLIENT_ID, now: () => 1_000_000 });
    expect(tokens.accessToken).toBe(p.grants[0]!.accessToken);
    expect(tokens.expiresAt).toBe(1_000_000 + 600_000);
    expect(tokens.secrets).toEqual(expect.arrayContaining([p.grants[0]!.idToken, p.grants[0]!.refreshToken]));
    expect(p.tokenCalls[0]!.get('code_verifier')).toBe(pkce.verifier);
  });

  it('turns a refused exchange into an error that names the code but echoes nothing', async () => {
    const p = await start();
    const t = createFetchTransport();
    const d = await discover(t, p.issuer);
    const err = await exchangeCode(t, d, { code: 'never-issued-code', verifier: 'v'.repeat(43), redirectUri: 'http://localhost:5173/callback', clientId: CLIENT_ID, now: Date.now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginError);
    expect((err as Error).message).toMatch(/invalid_grant/);
    expect((err as Error).message).not.toMatch(/never-issued-code/);
  });

  it('keeps an OAuth error code only when it looks like one', async () => {
    const d = { issuer: 'https://idp.example/', authorizationEndpoint: 'https://idp.example/a', tokenEndpoint: 'https://idp.example/t' };
    const t = { count: 0, request: async () => ({ status: 400, headers: new Headers(), body: new TextEncoder().encode('{"error":"<b>code c-123</b>"}') }) };
    const err = (await exchangeCode(t, d, { code: 'c-123', verifier: 'v', redirectUri: 'r', clientId: CLIENT_ID, now: Date.now }).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('the token endpoint answered 400 (no OAuth error code)');
  });

  it('carries no id or refresh token it was not given', async () => {
    const d = { issuer: 'https://idp.example/', authorizationEndpoint: 'https://idp.example/a', tokenEndpoint: 'https://idp.example/t' };
    const t = { count: 0, request: async () => ({ status: 200, headers: new Headers(), body: new TextEncoder().encode('{"access_token":"abcdefghijk","expires_in":60}') }) };
    expect(await exchangeCode(t, d, { code: 'c', verifier: 'v', redirectUri: 'r', clientId: CLIENT_ID, now: () => 0 })).toEqual({ accessToken: 'abcdefghijk', expiresAt: 60_000, secrets: [] });
    const zero = { count: 0, request: async () => ({ status: 200, headers: new Headers(), body: new TextEncoder().encode('{"access_token":"abcdefghijk","expires_in":0}') }) };
    await expect(exchangeCode(zero, d, { code: 'c', verifier: 'v', redirectUri: 'r', clientId: CLIENT_ID, now: () => 0 })).rejects.toThrow(/expires_in/);
  });

  it('refuses a token response without an access token or a lifetime', async () => {
    const t = { count: 0, request: async () => ({ status: 200, headers: new Headers(), body: new TextEncoder().encode('{"token_type":"Bearer","expires_in":600}') }) };
    const d = { issuer: 'https://idp.example/', authorizationEndpoint: 'https://idp.example/a', tokenEndpoint: 'https://idp.example/t' };
    await expect(exchangeCode(t, d, { code: 'c', verifier: 'v', redirectUri: 'r', clientId: CLIENT_ID, now: Date.now })).rejects.toThrow(/access_token/);
    const t2 = { count: 0, request: async () => ({ status: 200, headers: new Headers(), body: new TextEncoder().encode('{"access_token":"abcdefghijk"}') }) };
    await expect(exchangeCode(t2, d, { code: 'c', verifier: 'v', redirectUri: 'r', clientId: CLIENT_ID, now: Date.now })).rejects.toThrow(/expires_in/);
    const t3 = { count: 0, request: async () => ({ status: 502, headers: new Headers(), body: new TextEncoder().encode('<html>bad gateway</html>') }) };
    await expect(exchangeCode(t3, d, { code: 'c', verifier: 'v', redirectUri: 'r', clientId: CLIENT_ID, now: Date.now })).rejects.toThrow(/502/);
  });

  it('answers a wrong state 400 and keeps waiting, and any other path 404', async () => {
    listener = await listenForCallback({ redirectUri: new URL('http://127.0.0.1:0/callback'), state: 'expected-state-value', timeoutMs: 5_000 });
    const base = new URL(listener.redirectUri);
    expect((await fetch(`${base.origin}/callback?code=c1&state=forged-state-value`)).status).toBe(400);
    expect((await fetch(`${base.origin}/elsewhere?code=c1&state=expected-state-value`)).status).toBe(404);
    // A browser's redirect is a GET; anything else on the callback path is not ours to read.
    expect((await fetch(`${base.origin}/callback?code=c1&state=expected-state-value`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base.origin}/callback?state=expected-state-value`)).status).toBe(400);
    expect((await fetch(`${base.origin}/callback?code=c1`)).status).toBe(400);
    expect((await fetch(`${base.origin}/callback?code=the-code&state=expected-state-value`)).status).toBe(200);
    expect(await listener.code).toBe('the-code');
  });

  it('fails the login on an authorization error, naming only its code', async () => {
    listener = await listenForCallback({ redirectUri: new URL('http://127.0.0.1:0/callback'), state: 'expected-state-value', timeoutMs: 5_000 });
    const pending = listener.code.catch((e: unknown) => e);
    const base = new URL(listener.redirectUri);
    expect((await fetch(`${base.origin}/callback?error=access_denied&error_description=%3Cscript%3E&state=expected-state-value`)).status).toBe(400);
    const err = await pending;
    expect(err).toBeInstanceOf(LoginError);
    expect((err as Error).message).toBe('the authorization server refused the sign-in: access_denied');
  });

  it('names an unrecognisable authorization error as such, echoing nothing', async () => {
    listener = await listenForCallback({ redirectUri: new URL('http://127.0.0.1:0/callback'), state: 'expected-state-value', timeoutMs: 5_000 });
    const pending = listener.code.catch((e: unknown) => e);
    await fetch(`${new URL(listener.redirectUri).origin}/callback?error=%3Cscript%3E&state=expected-state-value`);
    expect(((await pending) as Error).message).toBe('the authorization server refused the sign-in: unrecognised error');
  });

  it('gives up after its timeout', async () => {
    listener = await listenForCallback({ redirectUri: new URL('http://127.0.0.1:0/callback'), state: 'expected-state-value', timeoutMs: 50 });
    await expect(listener.code).rejects.toThrow(/no sign-in within/);
  });

  it('says so when the redirect port is already held', async () => {
    listener = await listenForCallback({ redirectUri: new URL('http://127.0.0.1:0/callback'), state: 's', timeoutMs: 5_000 });
    const held = new URL(listener.redirectUri);
    await expect(listenForCallback({ redirectUri: held, state: 's', timeoutMs: 50 })).rejects.toThrow(/cannot listen on 127.0.0.1:\d+ .*EADDRINUSE/);
  });

  it('refuses to listen anywhere but loopback', async () => {
    await expect(listenForCallback({ redirectUri: new URL('http://0.0.0.0:0/callback'), state: 's', timeoutMs: 50 })).rejects.toThrow(/loopback/);
  });
});
