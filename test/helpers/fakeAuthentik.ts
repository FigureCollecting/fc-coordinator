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
 * SECURE_PROXY_SSL_HEADER) and the authority from `X-Forwarded-Host` when it
 * is present, `Host` otherwise (Authentik's front server,
 * internal/utils/web/host.go and packages/ak-axum/src/extract/host.rs).
 *
 * THE MIRROR REWRITES `Host`. The Linkerd multicluster gateway replaces it with
 * its local target's authority before Authentik sees the request, measured on
 * prod 2026-09-22 (fc-infra acceptance-u6.sh case d). So on this path `Host`
 * can never carry the public authority and only `X-Forwarded-Host` can. This
 * fixture applies the same rewrite: a mint without `X-Forwarded-Host` returns
 * a token whose `iss` names the in-cluster Service, which OpenFGA refuses.
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

/**
 * TWO PROVIDERS ON ONE AUTHENTIK, and conflating them is how an acceptance step
 * reads a working mesh path as a failure.
 *
 * `openfga` issues the OpenFGA SERVICE ACCOUNT's token — the credential this
 * unit moves onto the mirror. fc-infra pins its issuer in three merged places,
 * e.g. `nodes/fc-ha-01/multicluster/openfga-oidc-STAGE9.yaml:83`:
 * `https://auth.mindsignals1.com/application/o/openfga/`.
 *
 * `fc-coordinator` issues the USER's token, and it is that provider's key set
 * the coordinator fetches — `OIDC_JWKS_URI` ends `/application/o/fc-coordinator/jwks/`.
 *
 * Same host, same mirror, different issuer paths. The fixture serves both.
 */
export const OPENFGA_PROVIDER_SLUG = 'openfga';
export const USER_PROVIDER_SLUG = 'fc-coordinator';

/**
 * The authority the multicluster gateway rewrites `Host` to: the mirror's
 * local target Service, as measured on prod 2026-09-22.
 */
export const GATEWAY_TARGET_AUTHORITY = 'authentik-mc.authz.svc.cluster.local:9000';

export interface AuthentikCall {
  method: string;
  path: string;
  /** As the client sent it, before the gateway rewrote it. Not what `iss` uses. */
  host: string | undefined;
  /** Decides the AUTHORITY in `iss` when present. */
  forwardedHost: string | undefined;
  /** Django's SECURE_PROXY_SSL_HEADER. Decides the SCHEME in `iss`. */
  forwardedProto: string | undefined;
  /** `host`, `forwarded` and every `x-forwarded-*` header, exactly as sent. */
  proxyHeaders: Record<string, string>;
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

/**
 * Authentik's `request.build_absolute_uri(url)` for `issuer_mode: per_provider`
 * and the OPENFGA provider, as reached through the mirror. Scheme from
 * `X-Forwarded-Proto`; authority from `X-Forwarded-Host`, else the `Host` the
 * gateway rewrote, never the `Host` the client sent.
 */
export const issuerFor = (call: Pick<AuthentikCall, 'forwardedHost' | 'forwardedProto'>): string =>
  `${call.forwardedProto ?? 'http'}://${call.forwardedHost ?? GATEWAY_TARGET_AUTHORITY}/application/o/${OPENFGA_PROVIDER_SLUG}/`;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const proxyHeadersOf = (headers: http.IncomingHttpHeaders): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name === 'host' || name === 'forwarded' || name.startsWith('x-forwarded-')) {
      out[name] = Array.isArray(value) ? value.join(', ') : (value ?? '');
    }
  }
  return out;
};

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
          forwardedHost: first(req.headers['x-forwarded-host']),
          forwardedProto: first(req.headers['x-forwarded-proto']),
          proxyHeaders: proxyHeadersOf(req.headers),
        };
        calls.push(call);

        if (path.endsWith('/jwks/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ keys: [jwk] }));
          return;
        }

        // The token endpoint. `iss` comes from THIS request, as Authentik's does.
        const issuer = issuerFor(call);
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
    jwksUri: `${origin}/application/o/${USER_PROVIDER_SLUG}/jwks/`,
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
