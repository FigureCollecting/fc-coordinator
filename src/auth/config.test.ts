import { describe, expect, it } from 'vitest';
import { resolveAuthConfig } from './config.js';

const COMPLETE = {
  OIDC_ISSUER: 'https://auth.figurecollecting.com/application/o/fc-coordinator/',
  OIDC_AUDIENCE: 'fc-coordinator',
  OIDC_JWKS_URI: 'https://auth.figurecollecting.com/application/o/fc-coordinator/jwks/',
  COORDINATOR_PUBLIC_ORIGIN: 'https://api.figurecollecting.com',
};

describe('resolveAuthConfig', () => {
  it('resolves a complete environment with the documented defaults', () => {
    const config = resolveAuthConfig(COMPLETE);
    expect(config).toMatchObject({
      issuer: COMPLETE.OIDC_ISSUER,
      audience: 'fc-coordinator',
      origin: 'https://api.figurecollecting.com',
      proofMaxAgeSeconds: 30,
      clockSkewSeconds: 5,
      noncePeriodMs: 300_000,
      requireNonce: true,
    });
    expect(config.jwksUri.href).toBe(COMPLETE.OIDC_JWKS_URI);
  });

  it('DERIVES the jti window from the iat window so the two cannot drift apart', () => {
    const config = resolveAuthConfig({
      ...COMPLETE,
      DPOP_PROOF_MAX_AGE_SECONDS: '45',
      DPOP_CLOCK_SKEW_SECONDS: '10',
    });
    // The extra SECOND closes the granularity gap: `iat` is checked in floored
    // seconds, this window prunes in milliseconds, and without it a proof
    // replays for up to 999 ms after its jti is evicted (measured; see the
    // replay-hole test in dpop.test.ts, which pins this formula end to end).
    expect(config.jtiTtlMs).toBe((45 + 10) * 1000 + 1000);
  });

  it('keeps the jti window strictly longer than the widest iat window, at every setting', () => {
    for (const [maxAge, skew] of [
      ['1', '0'],
      ['30', '5'],
      ['45', '10'],
      ['300', '60'],
    ]) {
      const config = resolveAuthConfig({
        ...COMPLETE,
        DPOP_PROOF_MAX_AGE_SECONDS: maxAge,
        DPOP_CLOCK_SKEW_SECONDS: skew,
      });
      // The widest a proof can stay iat-valid is (maxAge + skew) seconds plus
      // the remainder of the second it was presented in.
      const widestIatWindowMs = (Number(maxAge) + Number(skew)) * 1000 + 999;
      expect(config.jtiTtlMs).toBeGreaterThan(widestIatWindowMs);
    }
  });

  it('names the missing variable rather than failing obscurely', () => {
    for (const key of Object.keys(COMPLETE)) {
      const partial = { ...COMPLETE, [key]: undefined };
      expect(() => resolveAuthConfig(partial)).toThrow(new RegExp(key));
    }
  });

  it('treats an empty string as missing', () => {
    expect(() => resolveAuthConfig({ ...COMPLETE, OIDC_AUDIENCE: '   ' })).toThrow(/OIDC_AUDIENCE/);
  });

  it('requires the JWKS to be fetched over HTTPS', () => {
    expect(() => resolveAuthConfig({ ...COMPLETE, OIDC_JWKS_URI: 'http://auth.example.com/jwks' })).toThrow(
      /https/i,
    );
  });

  it('allows plain HTTP to loopback, for a local test issuer', () => {
    for (const uri of ['http://127.0.0.1:9999/jwks', 'http://localhost:9999/jwks', 'http://[::1]:9999/jwks']) {
      expect(resolveAuthConfig({ ...COMPLETE, OIDC_JWKS_URI: uri }).jwksUri.href).toContain('/jwks');
    }
  });

  it('rejects a JWKS URI that is not a URL at all', () => {
    expect(() => resolveAuthConfig({ ...COMPLETE, OIDC_JWKS_URI: 'not a url' })).toThrow(/OIDC_JWKS_URI/);
  });

  it('requires the public origin to be an ORIGIN — no path, no query, no trailing slash', () => {
    for (const bad of ['https://api.example.com/', 'https://api.example.com/v1', 'https://api.example.com?x=1', 'nope']) {
      expect(() => resolveAuthConfig({ ...COMPLETE, COORDINATOR_PUBLIC_ORIGIN: bad })).toThrow(
        /COORDINATOR_PUBLIC_ORIGIN/,
      );
    }
  });

  it('REFUSES a symmetric or unsigned DPoP algorithm — the whole scheme depends on this', () => {
    for (const alg of ['HS256', 'none', 'HS256,ES256']) {
      expect(() => resolveAuthConfig({ ...COMPLETE, DPOP_ALGORITHMS: alg })).toThrow(/DPOP_ALGORITHMS/);
    }
  });

  it('refuses a symmetric algorithm for access tokens too', () => {
    expect(() => resolveAuthConfig({ ...COMPLETE, OIDC_ALGORITHMS: 'HS256' })).toThrow(/OIDC_ALGORITHMS/);
  });

  it('parses and trims an algorithm list', () => {
    expect(resolveAuthConfig({ ...COMPLETE, DPOP_ALGORITHMS: ' ES256 , PS256 ' }).dpopAlgorithms).toEqual([
      'ES256',
      'PS256',
    ]);
  });

  it('rejects an empty algorithm list rather than accepting everything', () => {
    expect(() => resolveAuthConfig({ ...COMPLETE, DPOP_ALGORITHMS: ' , ' })).toThrow(/DPOP_ALGORITHMS/);
  });

  it('rejects a numeric setting that is not a positive number', () => {
    for (const [key, value] of [
      ['DPOP_PROOF_MAX_AGE_SECONDS', '0'],
      ['DPOP_PROOF_MAX_AGE_SECONDS', 'soon'],
      ['DPOP_NONCE_PERIOD_SECONDS', '-1'],
      ['DPOP_JTI_MAX_ENTRIES', '1.5'],
      ['DEVICE_CACHE_TTL_SECONDS', 'NaN'],
    ]) {
      expect(() => resolveAuthConfig({ ...COMPLETE, [key!]: value })).toThrow(new RegExp(key!));
    }
  });

  it('allows a zero clock skew, which is a legitimate strict setting', () => {
    expect(resolveAuthConfig({ ...COMPLETE, DPOP_CLOCK_SKEW_SECONDS: '0' }).clockSkewSeconds).toBe(0);
  });

  it('can be told not to require a nonce, and says so explicitly', () => {
    expect(resolveAuthConfig({ ...COMPLETE, DPOP_REQUIRE_NONCE: 'false' }).requireNonce).toBe(false);
    expect(resolveAuthConfig({ ...COMPLETE, DPOP_REQUIRE_NONCE: 'true' }).requireNonce).toBe(true);
    expect(() => resolveAuthConfig({ ...COMPLETE, DPOP_REQUIRE_NONCE: 'maybe' })).toThrow(
      /DPOP_REQUIRE_NONCE/,
    );
  });
});

// ===========================================================================
// THE IdP MESH PATH (R7). The JWKS fetch may move onto the in-cluster Authentik
// mirror, where the hop inside the pod is cleartext and the Linkerd proxy
// supplies mTLS on the wire. The https rule above is relaxed for THAT host
// shape and nothing else, and relaxing it makes a second setting mandatory —
// see src/entitlements/idpEndpoint.ts and test/entitlements/idp-path.test.ts
// for the rule and its whole argument.
// ===========================================================================
describe('resolveAuthConfig and the in-cluster IdP mirror', () => {
  const MIRROR = 'http://authentik-mc-fc-ha.authz.svc.cluster.local:9000/application/o/fc-coordinator/jwks/';
  const PUBLIC_HOST = 'auth.mindsignals1.com';

  it('accepts cleartext to the mesh mirror when the public host is named', () => {
    const config = resolveAuthConfig({
      ...COMPLETE,
      OIDC_JWKS_URI: MIRROR,
      IDP_PUBLIC_HOST: PUBLIC_HOST,
    });
    expect(config.jwksUri.href).toBe(MIRROR);
    expect(config.jwksPath.kind).toBe('mesh');
    expect(config.jwksPath.headers).toEqual({ host: PUBLIC_HOST, 'x-forwarded-proto': 'https' });
  });

  it('REFUSES the mirror when IDP_PUBLIC_HOST is unset', () => {
    expect(() => resolveAuthConfig({ ...COMPLETE, OIDC_JWKS_URI: MIRROR })).toThrow(
      /IDP_PUBLIC_HOST/,
    );
  });

  it('REFUSES the mirror when IDP_PUBLIC_HOST is not a bare authority', () => {
    for (const bad of ['https://auth.mindsignals1.com', 'auth.mindsignals1.com/o', ' ']) {
      expect(() =>
        resolveAuthConfig({ ...COMPLETE, OIDC_JWKS_URI: MIRROR, IDP_PUBLIC_HOST: bad }),
      ).toThrow(/IDP_PUBLIC_HOST/);
    }
  });

  it('still refuses plain http to a PUBLIC host, with the message it always had', () => {
    // The rule that is NOT being relaxed, pinned against its own message so a
    // future edit that widens it has to change this line to do so.
    expect(() =>
      resolveAuthConfig({
        ...COMPLETE,
        OIDC_JWKS_URI: 'http://auth.example.com/jwks',
        IDP_PUBLIC_HOST: PUBLIC_HOST,
      }),
    ).toThrow("OIDC_JWKS_URI must use https (got 'http:') unless it is loopback");
  });

  it('leaves the public https path with no headers and says so in one line', () => {
    const config = resolveAuthConfig(COMPLETE);
    expect(config.jwksPath.kind).toBe('public');
    expect(config.jwksPath.headers).toEqual({});
    expect(config.jwksPath.description).toBe('public https auth.figurecollecting.com');
  });
});

// ===========================================================================
// THE TWO IdP URLs MUST AGREE (adversarial review of PR #10, SHOULD-3)
//
// resolveAuthConfig is where this is enforced because it is the boot-time
// resolver that already THROWS, and because it is the only one that sees both
// variables: the token endpoint's own module fails soft by contract — the mint
// returns null and every check denies — so a token endpoint moved to the
// mirror on its own produced a RUNNING pod that redacted every read. The JWKS
// half already crash-looped. Now both do.
// ===========================================================================
describe('resolveAuthConfig refuses a half-finished repoint', () => {
  const JWKS_MESH = 'http://authentik-mc-fc-ha.authz.svc.cluster.local:9000/application/o/fc-coordinator/jwks/';
  const TOKEN_MESH = 'http://authentik-mc-fc-ha.authz.svc.cluster.local:9000/application/o/token/';
  const TOKEN_PUBLIC = 'https://auth.mindsignals1.com/application/o/token/';
  const PUBLIC_HOST = 'auth.mindsignals1.com';

  it('throws when only the token endpoint names the mirror', () => {
    expect(() =>
      resolveAuthConfig({
        ...COMPLETE,
        IDP_PUBLIC_HOST: PUBLIC_HOST,
        OPENFGA_OIDC_TOKEN_ENDPOINT: TOKEN_MESH,
      }),
    ).toThrow(/OPENFGA_OIDC_TOKEN_ENDPOINT/);
  });

  it('throws when only the JWKS URI names the mirror', () => {
    expect(() =>
      resolveAuthConfig({
        ...COMPLETE,
        OIDC_JWKS_URI: JWKS_MESH,
        IDP_PUBLIC_HOST: PUBLIC_HOST,
        OPENFGA_OIDC_TOKEN_ENDPOINT: TOKEN_PUBLIC,
      }),
    ).toThrow(/OIDC_JWKS_URI/);
  });

  it('accepts both on the mirror together', () => {
    const config = resolveAuthConfig({
      ...COMPLETE,
      OIDC_JWKS_URI: JWKS_MESH,
      IDP_PUBLIC_HOST: PUBLIC_HOST,
      OPENFGA_OIDC_TOKEN_ENDPOINT: TOKEN_MESH,
    });
    expect(config.jwksPath.kind).toBe('mesh');
  });

  it('accepts both public together, which is today production', () => {
    expect(
      resolveAuthConfig({ ...COMPLETE, OPENFGA_OIDC_TOKEN_ENDPOINT: TOKEN_PUBLIC }).jwksPath.kind,
    ).toBe('public');
  });
});
