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
