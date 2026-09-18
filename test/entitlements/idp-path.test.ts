/**
 * ONE RULE FOR BOTH IdP URLs, AND THE ONE PLACE CLEARTEXT IS EVER ACCEPTED.
 *
 * WHAT CHANGED AND WHY. R7 (fc-infra PR #22) mirrors Authentik across the
 * existing Linkerd multicluster link so the coordinator's two OIDC hops — the
 * JWKS fetch and the OpenFGA token mint — stop crossing the public internet
 * with a service-account password under one-way TLS. The mirror is a
 * cluster-local Service and the hop INSIDE the pod is cleartext: the Linkerd
 * proxy is what puts mTLS on the wire. So the https-only rule both call sites
 * carried had to be relaxed for exactly that case and for nothing else.
 *
 * THE RULE, STATED ONCE:
 *
 *   https                     accepted, unchanged, no headers added
 *   loopback                  accepted, unchanged — a local test issuer
 *   *.svc.cluster.local       accepted over http, AND IDP_PUBLIC_HOST becomes
 *                             REQUIRED
 *   anything else over http   REFUSED, with the message each site already had
 *
 * WHY THE PUBLIC HOST IS REQUIRED RATHER THAN OPTIONAL, which is the part that
 * is not obvious from the transport change alone. Authentik derives the token's
 * `iss` from the REQUEST — `request.build_absolute_uri`, in both issuer modes —
 * so a mint reached through the mirror without `Host` and `X-Forwarded-Proto`
 * returns a token whose issuer names `authentik-mc-fc-ha.authz.svc.cluster.local`.
 * OpenFGA pins the public issuer, refuses every such token, and the refusal
 * surfaces as reads coming back redacted. A mesh URL with no public host is
 * therefore not a working configuration with a missing nicety; it is a
 * configuration that denies everything, and it must fail at boot.
 *
 * WHY THE SUFFIX IS A CONSTANT AND NOT AN ENVIRONMENT VARIABLE. The value
 * decides where plaintext is acceptable. openfgaToken.ts already states the
 * rule for this class of setting — "a flag whose whole purpose is to disable a
 * transport requirement is a flag that eventually gets set in production by
 * someone in a hurry" — and a suffix env is that flag wearing a DNS name.
 */
import { describe, expect, it } from 'vitest';
import {
  IDP_PUBLIC_HOST_KEY,
  MESH_HOST_SUFFIX,
  idpPathsDisagree,
  resolveIdpPath,
} from '../../src/entitlements/idpEndpoint.js';

const PUBLIC_HOST = 'auth.mindsignals1.com';
const MIRROR = `http://authentik-mc-fc-ha.authz.svc.cluster.local:9000/application/o/token/`;
const KEY = 'OPENFGA_OIDC_TOKEN_ENDPOINT';
const SUFFIX = " — the service account's password is sent to it";

const resolve = (
  raw: string,
  env: Record<string, string | undefined> = {},
  options: { refusalSuffix?: string } = {},
): ReturnType<typeof resolveIdpPath> =>
  resolveIdpPath(new URL(raw), { key: KEY, env: env as NodeJS.ProcessEnv, ...options });

const ok = (result: ReturnType<typeof resolveIdpPath>): Extract<typeof result, { ok: true }> => {
  if (!result.ok) throw new Error(`expected an accepted path, got: ${result.reason}`);
  return result;
};

describe('the mesh suffix is a constant this suite can name', () => {
  it('is the cluster-local DNS domain, spelled out rather than matched loosely', () => {
    // NOT a regex on the word "cluster": `evil-cluster.example.com` must not
    // become a place a password may be posted in the clear.
    expect(MESH_HOST_SUFFIX).toBe('svc.cluster.local');
    expect(IDP_PUBLIC_HOST_KEY).toBe('IDP_PUBLIC_HOST');
  });
});

describe('the public https path', () => {
  it('is accepted and carries no headers at all', () => {
    const { path } = ok(resolve('https://auth.mindsignals1.com/application/o/token/'));
    expect(path.kind).toBe('public');
    expect(path.headers).toEqual({});
    expect(path.publicHost).toBeUndefined();
  });

  it('names itself in one readable line', () => {
    const { path } = ok(resolve('https://auth.mindsignals1.com/application/o/token/'));
    expect(path.description).toBe('public https auth.mindsignals1.com');
  });

  it('is unchanged by IDP_PUBLIC_HOST being set — no headers appear on it', () => {
    // The public hop already presents the public authority, because it dials
    // it. Adding a forged Host there would be a change with no purpose and a
    // way to make the two paths behave differently for no reason.
    const { path } = ok(
      resolve('https://auth.mindsignals1.com/application/o/token/', { IDP_PUBLIC_HOST: PUBLIC_HOST }),
    );
    expect(path.kind).toBe('public');
    expect(path.headers).toEqual({});
  });
});

describe('the mesh mirror path', () => {
  it('accepts cleartext to a cluster-local host when the public host is set', () => {
    const { path } = ok(resolve(MIRROR, { IDP_PUBLIC_HOST: PUBLIC_HOST }));
    expect(path.kind).toBe('mesh');
    expect(path.publicHost).toBe(PUBLIC_HOST);
  });

  it('carries the two headers Authentik needs to mint a PUBLIC issuer', () => {
    const { path } = ok(resolve(MIRROR, { IDP_PUBLIC_HOST: PUBLIC_HOST }));
    expect(path.headers).toEqual({
      host: PUBLIC_HOST,
      'x-forwarded-proto': 'https',
    });
  });

  it('names the mirror AND the authority it presents, so a boot log is diagnostic', () => {
    const { path } = ok(resolve(MIRROR, { IDP_PUBLIC_HOST: PUBLIC_HOST }));
    expect(path.description).toBe(
      'mesh mirror authentik-mc-fc-ha.authz.svc.cluster.local:9000 presenting Host auth.mindsignals1.com',
    );
  });

  it('REFUSES a mesh URL with no public host, naming what is missing and why', () => {
    const refused = resolve(MIRROR);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain('IDP_PUBLIC_HOST');
    expect(refused.reason).toContain('iss');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['carrying a scheme', 'https://auth.mindsignals1.com'],
    ['carrying a path', 'auth.mindsignals1.com/application'],
    ['carrying userinfo', 'svcuser:hunter2@auth.mindsignals1.com'],
    ['carrying whitespace', 'auth.mindsignals1.com x'],
  ])('REFUSES a mesh URL whose public host is %s', (_label, value) => {
    const refused = resolve(MIRROR, { IDP_PUBLIC_HOST: value });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain(IDP_PUBLIC_HOST_KEY);
  });

  it('REFUSES a public host that is itself another in-cluster name', () => {
    // The exact own-goal this rule exists to prevent, spelled as a
    // configuration: a "public" host that is a second mirror name mints tokens
    // OpenFGA refuses, which is the failure the headers are meant to avoid.
    const refused = resolve(MIRROR, {
      IDP_PUBLIC_HOST: 'authentik-server.authz.svc.cluster.local:9000',
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain(IDP_PUBLIC_HOST_KEY);
  });

  it('accepts a public host carrying a port, which an edge on a non-443 port needs', () => {
    const { path } = ok(resolve(MIRROR, { IDP_PUBLIC_HOST: 'auth.mindsignals1.com:8443' }));
    expect(path.headers['host']).toBe('auth.mindsignals1.com:8443');
  });

  it('matches the suffix on a LABEL boundary, so a lookalike domain is still refused', () => {
    // `notsvc.cluster.local` ends with the suffix as a STRING and is a
    // different domain. A naive endsWith accepts it; this must not.
    const refused = resolve('http://authentik.evilsvc.cluster.local:9000/token', {
      IDP_PUBLIC_HOST: PUBLIC_HOST,
    });
    expect(refused.ok).toBe(false);
  });

  it('refuses a domain that merely CONTAINS the word cluster', () => {
    const refused = resolve('http://authentik.evil-cluster.example.com/token', {
      IDP_PUBLIC_HOST: PUBLIC_HOST,
    });
    expect(refused.ok).toBe(false);
  });
});

describe('the refusal that was already there is NOT weakened', () => {
  it('refuses plain http to a public host with the message the call site already had', () => {
    const refused = resolve('http://auth.mindsignals1.com/application/o/token/', {}, { refusalSuffix: SUFFIX });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toBe(
      `${KEY} must use https (got 'http:') unless it is loopback${SUFFIX}`,
    );
  });

  it('refuses plain http even when a public host is configured', () => {
    // IDP_PUBLIC_HOST is not a permission. It says which authority to present
    // ON the mesh path; it cannot make an arbitrary internet host cleartext.
    const refused = resolve('http://auth.mindsignals1.com/application/o/token/', {
      IDP_PUBLIC_HOST: PUBLIC_HOST,
    });
    expect(refused.ok).toBe(false);
  });

  it.each([['ftp:', 'ftp://auth.mindsignals1.com/token']])(
    'refuses %s, which is neither https nor a mesh host',
    (_label, raw) => {
      expect(resolve(raw).ok).toBe(false);
    },
  );
});

describe('loopback, which every fixture in this suite is reached over', () => {
  it.each([
    ['localhost', 'http://localhost:9000/application/o/token/'],
    ['127.0.0.1', 'http://127.0.0.1:9000/application/o/token/'],
    ['::1', 'http://[::1]:9000/application/o/token/'],
  ])('accepts plain http to %s with no headers, exactly as before', (_label, raw) => {
    const { path } = ok(resolve(raw));
    expect(path.kind).toBe('loopback');
    expect(path.headers).toEqual({});
  });

  it('presents the public host when one IS configured, so the mesh wire is testable', () => {
    // A local issuer that derives `iss` from the request behaves like the real
    // one, and this is how the mesh transport is exercised over a real socket:
    // `.svc.cluster.local` resolves nowhere on a workstation, so the headers
    // could otherwise only be asserted against a mock of our own client.
    const { path } = ok(
      resolve('http://127.0.0.1:9000/application/o/token/', { IDP_PUBLIC_HOST: PUBLIC_HOST }),
    );
    expect(path.kind).toBe('loopback');
    expect(path.headers).toEqual({ host: PUBLIC_HOST, 'x-forwarded-proto': 'https' });
  });

  it('produces the SAME headers as the mesh path, which is what makes that proof transfer', () => {
    const viaMesh = ok(resolve(MIRROR, { IDP_PUBLIC_HOST: PUBLIC_HOST })).path;
    const viaLoopback = ok(
      resolve('http://127.0.0.1:9000/application/o/token/', { IDP_PUBLIC_HOST: PUBLIC_HOST }),
    ).path;
    expect(viaLoopback.headers).toEqual(viaMesh.headers);
  });

  it('still refuses an invalid public host on loopback rather than ignoring it', () => {
    expect(resolve('http://127.0.0.1:9000/token', { IDP_PUBLIC_HOST: 'https://x.example' }).ok).toBe(
      false,
    );
  });

  it('names itself distinctly from the mesh path in the boot line', () => {
    expect(ok(resolve('http://127.0.0.1:9000/token')).path.description).toBe(
      'loopback 127.0.0.1:9000',
    );
    expect(
      ok(resolve('http://127.0.0.1:9000/token', { IDP_PUBLIC_HOST: PUBLIC_HOST })).path.description,
    ).toBe('loopback 127.0.0.1:9000 presenting Host auth.mindsignals1.com');
  });
});

// ===========================================================================
// HARDENING FROM THE ADVERSARIAL REVIEW OF PR #10
// ===========================================================================
describe('the public host accepts the form an operator actually writes', () => {
  it('accepts an explicit :443 and PRESENTS it without the default port', () => {
    // The message promised `host:port`, and the URL parser strips a default
    // port, so the one host:port form anyone writes by hand was refused by a
    // message saying it was allowed. Accepted now — and NORMALISED, because
    // `Host: auth.mindsignals1.com:443` would make Authentik build
    // `https://auth.mindsignals1.com:443/application/o/openfga/` and OpenFGA
    // pins the issuer WITHOUT the port. Sending it verbatim would produce
    // exactly the refusal these headers exist to prevent.
    const { path } = ok(resolve(MIRROR, { IDP_PUBLIC_HOST: 'auth.mindsignals1.com:443' }));
    expect(path.headers['host']).toBe('auth.mindsignals1.com');
    expect(path.description).toContain('presenting Host auth.mindsignals1.com');
  });

  it('keeps a NON-default port, which is a real authority and not redundant spelling', () => {
    expect(ok(resolve(MIRROR, { IDP_PUBLIC_HOST: 'auth.mindsignals1.com:8443' })).path.headers['host'])
      .toBe('auth.mindsignals1.com:8443');
  });

  it('REFUSES a name the URL parser rewrites, such as a Cyrillic homograph', () => {
    // `\u0430uth.mindsignals1.com` parses to `xn--uth-5cd.mindsignals1.com`. It is a
    // DIFFERENT authority to the one written, and what would go on the wire is
    // the punycode form — so accepting it would mean the Host header did not
    // say what the manifest said. Refused rather than silently rewritten: an
    // operator who wants an internationalised host writes the A-label.
    const refused = resolve(MIRROR, { IDP_PUBLIC_HOST: '\u0430uth.mindsignals1.com' });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain(IDP_PUBLIC_HOST_KEY);
  });

  it('accepts the same host written in capitals, which is the same authority', () => {
    expect(ok(resolve(MIRROR, { IDP_PUBLIC_HOST: 'AUTH.Mindsignals1.COM' })).path.headers['host'])
      .toBe('auth.mindsignals1.com');
  });

  it.each([
    ['a wildcard', '*'],
    ['a trailing dot, which is a different name to a strict issuer check', 'auth.mindsignals1.com.'],
    ['an empty label', 'auth..mindsignals1.com'],
    ['a leading dot', '.mindsignals1.com'],
  ])('REFUSES %s, which would mint tokens OpenFGA refuses in silence', (_label, value) => {
    expect(resolve(MIRROR, { IDP_PUBLIC_HOST: value }).ok).toBe(false);
  });
});

describe('the scheme is checked on EVERY path, not only the public one', () => {
  it.each([
    ['ftp', 'ftp://authentik-mc-fc-ha.authz.svc.cluster.local:9000/token'],
    ['file', 'file://authentik-mc-fc-ha.authz.svc.cluster.local/token'],
  ])('REFUSES %s to a mesh host rather than calling it a healthy mirror', (_label, raw) => {
    // It failed closed downstream — axios refuses the protocol before dialling
    // — but it printed a boot line saying the mirror was configured and well,
    // which is the one thing openfgaToken.ts's boot rule exists to prevent.
    const refused = resolve(raw, { IDP_PUBLIC_HOST: PUBLIC_HOST });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.reason).toContain(KEY);
  });

  it('REFUSES a non-http scheme to loopback too', () => {
    expect(resolve('ftp://127.0.0.1:9000/token').ok).toBe(false);
  });
});

describe('the two IdP URLs must agree about whether the path is in-cluster', () => {
  const JWKS_MESH = 'http://authentik-mc-fc-ha.authz.svc.cluster.local:9000/application/o/fc-coordinator/jwks/';
  const JWKS_PUBLIC = 'https://auth.mindsignals1.com/application/o/fc-coordinator/jwks/';
  const TOKEN_MESH = 'http://authentik-mc-fc-ha.authz.svc.cluster.local:9000/application/o/token/';
  const TOKEN_PUBLIC = 'https://auth.mindsignals1.com/application/o/token/';

  const check = (over: Record<string, string | undefined>): string | null =>
    idpPathsDisagree({ IDP_PUBLIC_HOST: PUBLIC_HOST, ...over } as NodeJS.ProcessEnv);

  it('accepts both on the mirror', () => {
    expect(check({ OIDC_JWKS_URI: JWKS_MESH, OPENFGA_OIDC_TOKEN_ENDPOINT: TOKEN_MESH })).toBeNull();
  });

  it('accepts both public', () => {
    expect(check({ OIDC_JWKS_URI: JWKS_PUBLIC, OPENFGA_OIDC_TOKEN_ENDPOINT: TOKEN_PUBLIC })).toBeNull();
  });

  it('REFUSES the token endpoint moved alone — the shape that boots and denies everything', () => {
    // WHY THIS IS THE DANGEROUS ONE. A mesh JWKS URI with no public host THROWS
    // and the pod crash-loops, which an operator sees immediately. The token
    // endpoint fails SOFT by design — the mint returns null and every check
    // denies — so a half-finished repoint produces a running pod that redacts
    // every read. Refusing the mismatch at boot turns that into the crash the
    // other half already was.
    const reason = check({ OIDC_JWKS_URI: JWKS_PUBLIC, OPENFGA_OIDC_TOKEN_ENDPOINT: TOKEN_MESH });
    expect(reason).not.toBeNull();
    expect(reason).toContain('OPENFGA_OIDC_TOKEN_ENDPOINT');
    expect(reason).toContain('OIDC_JWKS_URI');
  });

  it('REFUSES the JWKS URI moved alone', () => {
    expect(check({ OIDC_JWKS_URI: JWKS_MESH, OPENFGA_OIDC_TOKEN_ENDPOINT: TOKEN_PUBLIC })).not.toBeNull();
  });

  it('says nothing when the token endpoint is unconfigured — that is not a half-repoint', () => {
    // OpenFGA unconfigured is a documented state with its own warning. Pairing
    // it with an agreement failure would report the wrong problem.
    expect(check({ OIDC_JWKS_URI: JWKS_MESH })).toBeNull();
    expect(check({ OIDC_JWKS_URI: JWKS_PUBLIC })).toBeNull();
  });

  it('leaves loopback alone, which is every fixture in this suite', () => {
    // The rule is anchored on MESH, not on strict equality of the three kinds:
    // a loopback fixture beside a public URL is a development shape, not a
    // partial migration, and refusing it would buy nothing.
    expect(check({ OIDC_JWKS_URI: JWKS_PUBLIC, OPENFGA_OIDC_TOKEN_ENDPOINT: 'http://127.0.0.1:9/token' })).toBeNull();
  });

  it('says nothing about a URL it cannot parse, leaving that to the resolver that reports it', () => {
    expect(check({ OIDC_JWKS_URI: 'not a url', OPENFGA_OIDC_TOKEN_ENDPOINT: TOKEN_MESH })).toBeNull();
  });
});
