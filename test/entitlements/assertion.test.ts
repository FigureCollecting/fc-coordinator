/**
 * Entitlement assertion MINT tests (D6 U6), ported from fc-backend
 * tests/services/entitlements/assertion.test.ts with jest -> vitest and ESM
 * specifiers as the only changes.
 *
 * THE LOAD-BEARING TEST IS THE FIRST ONE: a token this module mints is fed to
 * a faithful port of the spine's deployed verifier (test/helpers/
 * entitlementVerifier.ts) and must come back `granted`. Everything else here
 * pins a way the mint could drift out of that agreement one field at a time.
 *
 * NO REAL KEY MATERIAL. Every keypair is generated per-test with
 * crypto.generateKeyPairSync('ed25519'); the production private key lives in
 * OpenBao and must never reach a test, a fixture or a log line.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  ENTITLEMENT_ALG,
  ENTITLEMENT_AUDIENCE,
  ENTITLEMENT_ISSUER,
  ENTITLEMENT_TTL_SECONDS,
  INVENTORY_LEVELS,
} from '@figurecollecting/ingest-contract/entitlement';
import {
  mintEntitlementAssertion,
  initEntitlementSigning,
  entitlementMintCounters,
  resetEntitlementSigningForTest,
} from '../../src/entitlements/assertion.js';
import {
  generateTestSigningKey,
  verifyEntitlementHeader,
  MAX_HEADER_BYTES,
} from '../helpers/entitlementVerifier.js';

const KID = 'ent-test-2026-09';
const SUB = '7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33';

const ENV_KEYS = [
  'ENTITLEMENT_SIGNING_KEY_PEM',
  'ENTITLEMENT_SIGNING_KEY_FILE',
  'ENTITLEMENT_SIGNING_KID',
  'ENTITLEMENT_SIGNING_ISSUER',
] as const;

let saved: Record<string, string | undefined> = {};
let warnSpy: MockInstance<typeof console.warn>;
let logSpy: MockInstance<typeof console.log>;
let tmpDir: string | null = null;

const decodePart = (token: string, index: 0 | 1): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[index] as string, 'base64url').toString('utf8'));

/** Everything any spy saw, as one string — for "this must not appear anywhere" assertions. */
const allLoggedText = (): string =>
  [...warnSpy.mock.calls, ...logSpy.mock.calls].map((args) => args.map(String).join(' ')).join('\n');

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  resetEntitlementSigningForTest();
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  warnSpy.mockRestore();
  logSpy.mockRestore();
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
  resetEntitlementSigningForTest();
});

describe('mintEntitlementAssertion — agreement with the spine verifier', () => {
  it('mints a token the spine verifier accepts, carrying the subject and the grant', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    const token = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] });
    expect(token).not.toBeNull();

    const verified = verifyEntitlementHeader(token, kp.keys);
    expect(verified.outcome).toBe('granted');
    expect(verified.sub).toBe(SUB);
    expect([...verified.grants]).toEqual([INVENTORY_LEVELS]);
    expect(verified.unknownNames).toBe(0);
  });

  it('is a compact JWS: three base64url segments and a 64-byte Ed25519 signature', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    const token = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string;
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(parts[2] as string, 'base64url')).toHaveLength(64);
  });

  it('pins the JOSE header: alg EdDSA, typ JWT, the configured kid, and NO crit', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    const header = decodePart(
      mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string,
      0,
    );
    expect(header['alg']).toBe(ENTITLEMENT_ALG);
    expect(header['typ']).toBe('JWT');
    expect(header['kid']).toBe(KID);
    // The spine refuses any `crit` it does not implement, which is all of them.
    expect(header['crit']).toBeUndefined();
  });

  it('pins the claim set: issuer, audience, subject, grants, and exp exactly TTL after iat', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    const claims = decodePart(
      mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string,
      1,
    );
    expect(claims['iss']).toBe(ENTITLEMENT_ISSUER);
    expect(claims['aud']).toBe(ENTITLEMENT_AUDIENCE);
    expect(claims['sub']).toBe(SUB);
    expect(claims['ent']).toEqual([INVENTORY_LEVELS]);
    expect(claims['kid']).toBe(KID);
    expect(Number.isSafeInteger(claims['iat'])).toBe(true);
    // Exactly the contract's TTL. The verifier refuses `exp - iat` greater than
    // this outright, so a "generous" mint is a mint nobody can use.
    expect((claims['exp'] as number) - (claims['iat'] as number)).toBe(ENTITLEMENT_TTL_SECONDS);
  });

  it('mints against an injected clock, so iat/exp are the callers notion of now', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    const nowMs = 1_800_000_000_000;

    const claims = decodePart(
      mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }, nowMs) as string,
      1,
    );
    expect(claims['iat']).toBe(Math.floor(nowMs / 1000));
    expect(claims['exp']).toBe(Math.floor(nowMs / 1000) + ENTITLEMENT_TTL_SECONDS);
  });

  it('fits well inside the verifiers header size bound', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    const token = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string;
    expect(Buffer.byteLength(token, 'utf8')).toBeLessThan(MAX_HEADER_BYTES / 2);
  });
});

describe('mintEntitlementAssertion — when there is nothing to assert', () => {
  it('returns null with NO key configured, and never throws', () => {
    expect(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] })).toBeNull();
  });

  it('returns null for an empty grant list — an empty ent[] is a header that buys nothing', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(mintEntitlementAssertion({ sub: SUB, ent: [] })).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
  ])('returns null for a %s subject', (_label, sub) => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(mintEntitlementAssertion({ sub, ent: [INVENTORY_LEVELS] })).toBeNull();
  });
});

describe('the subject must be an Authentik uuid', () => {
  // The mint is exported, so it is an entry point in its own right. Guarding
  // only the Check would leave the promise "sub is an Authentik uuid" true by
  // convention rather than by construction — and it is the module's ONLY
  // statement about identity once the legacy glue is deleted at the port.
  it.each([
    ['a Mongo ObjectId', '68c1f0a9b2d4e5f6a7b8c9d0'],
    ['an email', 'ross@example.com'],
    ['a uuid with a stray prefix', 'user:7f3a1c62-9d44-4e51-8b0a-2c6d5e1f9a33'],
    ['a uuid missing a group', '7f3a1c62-9d44-4e51-8b0a'],
  ])('refuses to sign %s', (_label, sub) => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(mintEntitlementAssertion({ sub, ent: [INVENTORY_LEVELS] })).toBeNull();
    expect(entitlementMintCounters()['bad_subject']).toBeGreaterThanOrEqual(1);
  });

  it('refuses an oversized subject, which would mint a header the verifier rejects', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    // The verifier refuses anything over 4096 bytes as `oversized` — another
    // silent redaction. The uuid shape bounds the subject at 36 characters, so
    // this can never be reached through a valid subject; the assertion pins
    // that the bound is a consequence of the shape, not a coincidence.
    expect(mintEntitlementAssertion({ sub: 'a'.repeat(8192), ent: [INVENTORY_LEVELS] })).toBeNull();
  });

  it.each([
    ['a non-string subject', 12345],
    ['an undefined subject', undefined],
    ['a null subject', null],
  ])('refuses %s rather than throwing', (_label, sub) => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(() =>
      mintEntitlementAssertion({ sub: sub as unknown as string, ent: [INVENTORY_LEVELS] }),
    ).not.toThrow();
    expect(
      mintEntitlementAssertion({ sub: sub as unknown as string, ent: [INVENTORY_LEVELS] }),
    ).toBeNull();
  });

  it.each([
    ['a null grant list', null],
    ['a non-array grant list', 'inventory_levels'],
  ])('refuses %s rather than throwing', (_label, ent) => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(() =>
      mintEntitlementAssertion({ sub: SUB, ent: ent as unknown as (typeof INVENTORY_LEVELS)[] }),
    ).not.toThrow();
    expect(
      mintEntitlementAssertion({ sub: SUB, ent: ent as unknown as (typeof INVENTORY_LEVELS)[] }),
    ).toBeNull();
  });

  it('signs an uppercase uuid verbatim, never folded to lower case', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    const upper = SUB.toUpperCase();

    const token = mintEntitlementAssertion({ sub: upper, ent: [INVENTORY_LEVELS] }) as string;
    // An identifier that folds two spellings onto one makes two subjects into
    // one, which is the opposite of what a grant needs.
    expect(verifyEntitlementHeader(token, kp.keys).sub).toBe(upper);
  });
});

describe('key loading', () => {
  it('reads the key from a file and derives the kid from its basename', () => {
    const kp = generateTestSigningKey('ent-2026-09');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u6-key-'));
    const file = path.join(tmpDir, 'ent-2026-09.key');
    fs.writeFileSync(file, kp.privatePem, { mode: 0o600 });
    process.env['ENTITLEMENT_SIGNING_KEY_FILE'] = file;

    const token = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] });
    expect(verifyEntitlementHeader(token, kp.keys).outcome).toBe('granted');
    expect(decodePart(token as string, 0)['kid']).toBe('ent-2026-09');
  });

  it('lets ENTITLEMENT_SIGNING_KID override a filename-derived kid', () => {
    const kp = generateTestSigningKey('explicit-kid');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'u6-key-'));
    const file = path.join(tmpDir, 'ent-2026-09.key');
    fs.writeFileSync(file, kp.privatePem, { mode: 0o600 });
    process.env['ENTITLEMENT_SIGNING_KEY_FILE'] = file;
    process.env['ENTITLEMENT_SIGNING_KID'] = 'explicit-kid';

    expect(
      decodePart(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string, 0)[
        'kid'
      ],
    ).toBe('explicit-kid');
  });

  it('disables minting when an inline PEM has no kid to go with it', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;

    expect(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('ENTITLEMENT_SIGNING_KID');
  });

  it('refuses a key that is not Ed25519 rather than minting an algorithm the spine will not verify', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0]).toLowerCase()).toContain('ed25519');
  });

  it('disables minting when the key file is unreadable, and never throws', () => {
    process.env['ENTITLEMENT_SIGNING_KEY_FILE'] = '/nonexistent/u6/ent.key';
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('disables minting on a PEM that is not a private key, and never throws', () => {
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] =
      '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n';
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] })).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns exactly ONCE however many mints are attempted without a key', () => {
    for (let i = 0; i < 25; i++) {
      expect(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] })).toBeNull();
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('loads the key ONCE: a later env change is not picked up without a reset', () => {
    const first = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = first.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    const a = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string;

    const second = generateTestSigningKey('rotated');
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = second.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = 'rotated';
    const b = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string;

    expect(decodePart(b, 0)['kid']).toBe(KID);
    expect(verifyEntitlementHeader(b, first.keys).outcome).toBe('granted');
    expect(decodePart(a, 0)['kid']).toBe(KID);
  });
});

describe('initEntitlementSigning', () => {
  it('reports enabled and names the kid, without ever printing key material', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(initEntitlementSigning()).toBe(true);
    const text = allLoggedText();
    expect(text).toContain(KID);
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(kp.privatePem.trim());
  });

  it('reports disabled with ONE warning when no key is configured, and does not throw', () => {
    expect(initEntitlementSigning()).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // The operator must be told what the consequence is, not just that a var is missing.
    expect(String(warnSpy.mock.calls[0]?.[0]).toLowerCase()).toContain('redact');
  });

  it('does not warn a second time when a mint follows a disabled init', () => {
    expect(initEntitlementSigning()).toBe(false);
    mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] });
    mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('secret hygiene', () => {
  it('never puts the private key, or any PEM, into a minted token', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    const token = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string;
    const decoded = Buffer.from(token.split('.')[1] as string, 'base64url').toString('utf8');
    expect(token).not.toContain('PRIVATE');
    expect(decoded).not.toContain('PRIVATE');
    const body = kp.privatePem.split('\n').filter((l) => l && !l.startsWith('-----'))[0] as string;
    expect(token).not.toContain(body);
  });

  it('logs nothing at all on the minting path', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    const token = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string;
    // Not one line: the token is a bearer grant, and a log that carries it is a
    // log that hands the grant to anyone who can read logs.
    expect(allLoggedText()).not.toContain(token);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('counters', () => {
  it('counts mints and skips separately', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] });
    mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] });
    mintEntitlementAssertion({ sub: SUB, ent: [] });

    const counters = entitlementMintCounters();
    expect(counters['minted']).toBe(2);
    expect(counters['no_grants']).toBe(1);
  });

  it('counts the disabled path', () => {
    mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] });
    expect(entitlementMintCounters()['disabled']).toBe(1);
  });
});

// ===========================================================================
// THE ISSUER PIN — added by the slice-1b port, from the image-track review.
//
// fc-aggregation's verifier pins `iss` and rejects a mismatch the way it
// rejects everything else: SILENTLY, with empty grants and a normal 200. That
// makes a wrong issuer indistinguishable from a user with no grant, so the
// failure mode has to be visible SOMEWHERE, and the only place left is here.
// ===========================================================================
describe('the iss claim', () => {
  it('defaults to the contract issuer, which is what the deployed verifier expects', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    const token = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string;
    expect(decodePart(token, 1)['iss']).toBe(ENTITLEMENT_ISSUER);
    // The whole point of the default: it verifies today, unchanged.
    expect(verifyEntitlementHeader(token, kp.keys).outcome).toBe('granted');
    // And it is not a change anyone has to be told about.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   '],
  ])('falls back to the contract issuer when the variable is %s', (_label, value) => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    if (value !== undefined) process.env['ENTITLEMENT_SIGNING_ISSUER'] = value;

    const token = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string;
    expect(decodePart(token, 1)['iss']).toBe(ENTITLEMENT_ISSUER);
  });

  it('mints under a configured issuer when one is set', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    process.env['ENTITLEMENT_SIGNING_ISSUER'] = 'fc-coordinator';

    expect(
      decodePart(mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string, 1)[
        'iss'
      ],
    ).toBe('fc-coordinator');
  });

  it('a mismatched issuer is REJECTED BY THE VERIFIER, silently, with no grants', () => {
    // THE FAILURE THIS FILE EXISTS TO MAKE VISIBLE. The token is perfectly well
    // formed and correctly signed; the verifier still hands back nothing, and
    // says so only as `wrong_issuer` — which at the spine is a normal 200.
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    process.env['ENTITLEMENT_SIGNING_ISSUER'] = 'fc-coordinator';

    const token = mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] }) as string;
    const verified = verifyEntitlementHeader(token, kp.keys);

    expect(verified.outcome).toBe('wrong_issuer');
    expect([...verified.grants]).toEqual([]);
    // Not an error, not a throw — the read still succeeds, redacted.
    expect(verified.sub).toBeUndefined();
  });

  it('warns ONCE when the issuer is not the contract default, naming the consequence', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;
    process.env['ENTITLEMENT_SIGNING_ISSUER'] = 'fc-coordinator';

    for (let i = 0; i < 5; i++) mintEntitlementAssertion({ sub: SUB, ent: [INVENTORY_LEVELS] });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const text = String(warnSpy.mock.calls[0]?.[0]).toLowerCase();
    expect(text).toContain('fc-coordinator');
    // The symptom, not just the setting: an operator chasing missing numbers
    // has to be able to find this line by what they are seeing.
    expect(text).toContain('redact');
    expect(text).toContain('silent');
  });

  it('does not warn about the issuer when minting is disabled anyway', () => {
    // No key: the mint is off, so an issuer it will never use is not news.
    process.env['ENTITLEMENT_SIGNING_ISSUER'] = 'fc-coordinator';
    expect(initEntitlementSigning()).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('no signing key configured');
  });

  it('names the issuer in the boot line, so the deployed value is observable', () => {
    const kp = generateTestSigningKey(KID);
    process.env['ENTITLEMENT_SIGNING_KEY_PEM'] = kp.privatePem;
    process.env['ENTITLEMENT_SIGNING_KID'] = KID;

    expect(initEntitlementSigning()).toBe(true);
    expect(allLoggedText()).toContain(`iss=${ENTITLEMENT_ISSUER}`);
  });
});
