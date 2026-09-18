/**
 * A FAKE AUTHENTIK THAT DERIVES `iss` FROM THE REQUEST, BECAUSE THE REAL ONE
 * DOES.
 *
 * WHY THIS FAKE EXISTS RATHER THAN A CONSTANT ISSUER. Authentik builds the
 * issuer out of the incoming request in BOTH issuer modes:
 *
 *   def get_issuer(self, request: HttpRequest) -> str | None:
 *       if self.issuer_mode == IssuerMode.GLOBAL:
 *           return request.build_absolute_uri(reverse("authentik_core:root-redirect"))
 *       ...
 *       return request.build_absolute_uri(url)
 *
 * `build_absolute_uri` takes the scheme from `X-Forwarded-Proto` (Django's
 * SECURE_PROXY_SSL_HEADER, which is how Authentik runs behind a proxy) and the
 * authority from the `Host` header. So a mint reached through the in-cluster
 * mirror WITHOUT those two headers returns a token whose `iss` names the
 * mirror, OpenFGA's issuer check refuses it, and the refusal arrives as a
 * redacted read with no line saying why.
 *
 * A fake with a pinned issuer agrees with a client that sends no headers, and
 * agreement between two things built from the same assumption is not evidence
 * — the same trap test/entitlements/openfga-status.test.ts documents for the
 * gRPC status trailer. So this one computes the issuer the way Authentik does
 * and records the headers it was reached with.
 *
 * It listens on loopback and answers on ANY Host, exactly as a Service behind a
 * mesh mirror does: the dial address and the authority presented are separate
 * facts, and that separation is the whole thing under test.
 */
import * as http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

/** The provider slug, matching fc-infra's `openfga-oidc.yaml` blueprint. */
export const PROVIDER_SLUG = 'fc-coordinator';

export interface AuthentikCall {
  method: string;
  path: string;
  /** As it arrived on the wire. The authority Authentik will put in `iss`. */
  host: string | undefined;
  /** Django's SECURE_PROXY_SSL_HEADER. Decides the SCHEME in `iss`. */
  forwardedProto: string | undefined;
}

export interface FakeAuthentik {
  /** Where to dial. Always loopback — the presented authority is a header. */
  origin: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** Every request, token endpoint and JWKS alike, in order. */
  calls: AuthentikCall[];
  /** Only the JWKS fetches, for asserting what jose put on the wire. */
  jwksCalls: AuthentikCall[];
  /** Only the token mints. */
  tokenCalls: AuthentikCall[];
  /** Every `access_token` handed out, in order. */
  issued: string[];
  close: () => Promise<void>;
}

/** Exactly Authentik's `request.build_absolute_uri(url)` for `issuer_mode: per_provider`. */
export const issuerFor = (host: string | undefined, forwardedProto: string | undefined): string =>
  `${forwardedProto ?? 'http'}://${host ?? ''}/application/o/${PROVIDER_SLUG}/`;

export async function startFakeAuthentik(): Promise<FakeAuthentik> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'authentik-kid-1', alg: 'RS256', use: 'sig' };

  const calls: AuthentikCall[] = [];
  const issued: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      void (async (): Promise<void> => {
        const path = (req.url ?? '').split('?')[0] ?? '';
        const call: AuthentikCall = {
          method: req.method ?? '',
          path,
          host: req.headers.host,
          forwardedProto: Array.isArray(req.headers['x-forwarded-proto'])
            ? req.headers['x-forwarded-proto'][0]
            : req.headers['x-forwarded-proto'],
        };
        calls.push(call);

        if (path.endsWith('/jwks/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ keys: [jwk] }));
          return;
        }

        // The token endpoint. `iss` comes from THIS request, as Authentik's does.
        const issuer = issuerFor(call.host, call.forwardedProto);
        const token = await new SignJWT({})
          .setProtectedHeader({ alg: 'RS256', kid: 'authentik-kid-1' })
          .setIssuer(issuer)
          .setAudience('openfga')
          .setSubject('9a1d5c70-3f28-4c6b-9f11-6d0e8b2a7c44')
          .setIssuedAt()
          .setExpirationTime('10m')
          .sign(privateKey);
        issued.push(token);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 600 }));
      })();
    });
  });

  const sockets = new Set<Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    tokenEndpoint: `${origin}/application/o/token/`,
    jwksUri: `${origin}/application/o/${PROVIDER_SLUG}/jwks/`,
    calls,
    get jwksCalls() {
      return calls.filter((c) => c.path.endsWith('/jwks/'));
    },
    get tokenCalls() {
      return calls.filter((c) => !c.path.endsWith('/jwks/'));
    },
    issued,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
