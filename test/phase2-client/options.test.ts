// The Phase-2 client's arguments: --plan by default, and a live run only with an explicit
// --target plus a confirmation token that names that target's host (the plan-mode rule for
// acceptance scripts). Every refusal here is a guard on sending a token somewhere it should not go.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_ISSUER,
  DEFAULT_REDIRECT_URI,
  UsageError,
  parseOptions,
} from '../../scripts/phase2-client/options.js';

const CANARY = 'https://fc-api-canary.mindsignals1.com';

describe('parseOptions', () => {
  it('defaults to --plan with the registered client, issuer and loopback redirect', () => {
    const o = parseOptions([]);
    expect(o.mode).toBe('plan');
    expect(o.target).toBeUndefined();
    expect(o.issuer).toBe(DEFAULT_ISSUER);
    expect(DEFAULT_ISSUER).toBe('https://auth.mindsignals1.com/application/o/fc-coordinator/');
    expect(o.clientId).toBe(DEFAULT_CLIENT_ID);
    expect(DEFAULT_CLIENT_ID).toBe('fc-coordinator');
    expect(o.redirectUri.toString()).toBe(DEFAULT_REDIRECT_URI);
    expect(DEFAULT_REDIRECT_URI).toBe('http://localhost:5173/callback');
    expect(o.prefix).toBe('/api');
    expect(o.noncePeriodSeconds).toBe(300);
    expect(o.restartTimeoutSeconds).toBe(300);
    expect(o.help).toBe(false);
  });

  it('stays in plan mode with a --target and no confirmation', () => {
    const o = parseOptions(['--target', CANARY]);
    expect(o.mode).toBe('plan');
    expect(o.target).toBe(CANARY);
  });

  it('goes live only when --confirm names the target host exactly', () => {
    const o = parseOptions(['--target', CANARY, '--confirm', 'fc-api-canary.mindsignals1.com']);
    expect(o.mode).toBe('live');
    expect(o.target).toBe(CANARY);
  });

  it('refuses a confirmation that names another host', () => {
    expect(() => parseOptions(['--target', CANARY, '--confirm', 'figurecollecting.com'])).toThrow(UsageError);
    expect(() => parseOptions(['--target', CANARY, '--confirm', 'figurecollecting.com'])).toThrow(/does not match/);
  });

  it('counts the port as part of the host the confirmation must name', () => {
    expect(() => parseOptions(['--target', 'https://x.example:8443', '--confirm', 'x.example'])).toThrow(/does not match/);
    expect(parseOptions(['--target', 'https://x.example:8443', '--confirm', 'x.example:8443']).mode).toBe('live');
  });

  it('refuses a confirmation with no target, and --plan with a confirmation', () => {
    expect(() => parseOptions(['--confirm', 'x.example'])).toThrow(/--confirm needs --target/);
    expect(() => parseOptions(['--plan', '--target', CANARY, '--confirm', 'fc-api-canary.mindsignals1.com'])).toThrow(
      /contradict/,
    );
  });

  it('keeps an explicit --plan in plan mode', () => {
    expect(parseOptions(['--plan', '--target', CANARY]).mode).toBe('plan');
  });

  it('refuses cleartext to anything but loopback, for the target and the issuer', () => {
    expect(() => parseOptions(['--target', 'http://fc-api-canary.mindsignals1.com'])).toThrow(/https/);
    expect(() => parseOptions(['--issuer', 'http://auth.mindsignals1.com/application/o/fc-coordinator/'])).toThrow(/https/);
    expect(() => parseOptions(['--target', 'ftp://x.example'])).toThrow(/https/);
    for (const loopback of ['http://127.0.0.1:5052', 'http://localhost:5052', 'http://[::1]:5052']) {
      expect(parseOptions(['--target', loopback]).target).toBe(loopback);
    }
    expect(parseOptions(['--issuer', 'http://127.0.0.1:9000/application/o/fc-coordinator/']).issuer).toBe(
      'http://127.0.0.1:9000/application/o/fc-coordinator/',
    );
  });

  it('refuses a target that is not a bare origin, or not a URL', () => {
    expect(() => parseOptions(['--target', `${CANARY}/api`])).toThrow(/bare origin/);
    expect(() => parseOptions(['--target', `${CANARY}/`])).toThrow(/bare origin/);
    expect(() => parseOptions(['--target', 'not a url'])).toThrow(/absolute URL/);
    expect(() => parseOptions(['--issuer', 'not a url'])).toThrow(/absolute URL/);
  });

  it('accepts only a loopback http redirect, because the listener is local', () => {
    expect(() => parseOptions(['--redirect-uri', 'https://figurecollecting.com/callback'])).toThrow(/loopback/);
    expect(() => parseOptions(['--redirect-uri', 'http://192.168.1.5:5173/callback'])).toThrow(/loopback/);
    expect(() => parseOptions(['--redirect-uri', 'nope'])).toThrow(/absolute URL/);
    expect(parseOptions(['--redirect-uri', 'http://127.0.0.1:0/callback']).redirectUri.port).toBe('0');
    expect(() => parseOptions(['--redirect-uri', 'http://[::1]:5173/callback'])).toThrow(/loopback/);
    expect(() => parseOptions(['--redirect-uri', 'http://localhost/callback'])).toThrow(/must name its port/);
  });

  it("validates the prefix with the coordinator's own rule", () => {
    expect(() => parseOptions(['--prefix', 'api'])).toThrow(/must start with/);
    expect(parseOptions(['--prefix', '']).prefix).toBe('');
  });

  it('takes positive numbers only', () => {
    expect(() => parseOptions(['--nonce-period-seconds', '0'])).toThrow(/positive/);
    expect(() => parseOptions(['--nonce-period-seconds', 'abc'])).toThrow(/positive/);
    expect(() => parseOptions(['--restart-timeout-seconds=-1'])).toThrow(/positive/);
    expect(() => parseOptions(['--restart-timeout-seconds', '-1'])).toThrow(UsageError);
    expect(parseOptions(['--nonce-period-seconds', '1.5']).noncePeriodSeconds).toBe(1.5);
    expect(parseOptions(['--restart-timeout-seconds', '60']).restartTimeoutSeconds).toBe(60);
  });

  it('reads the B1 request as a CompareRequest and refuses one with no seed or no clock', () => {
    const o = parseOptions(['--b1-request', '{"gtin14":"04573102591234","nowIso":"2026-09-14T12:00:00.000Z"}', '--b1-reference', '/x/a7.bin']);
    expect(o.b1Request).toBe('{"gtin14":"04573102591234","nowIso":"2026-09-14T12:00:00.000Z"}');
    expect(o.b1Reference).toBe('/x/a7.bin');
    expect(() => parseOptions(['--b1-request', '{'])).toThrow(/CompareRequest/);
    expect(() => parseOptions(['--b1-request', '{"nowIso":"2026-09-14T12:00:00.000Z"}'])).toThrow(/seed/);
    expect(() => parseOptions(['--b1-request', '{"gtin14":"04573102591234"}'])).toThrow(/nowIso/);
  });

  it('refuses an unknown flag and a missing value, and reports --help', () => {
    expect(() => parseOptions(['--live'])).toThrow(UsageError);
    expect(() => parseOptions(['--target'])).toThrow(UsageError);
    expect(() => parseOptions(['stray'])).toThrow(UsageError);
    expect(parseOptions(['--help']).help).toBe(true);
  });
});
