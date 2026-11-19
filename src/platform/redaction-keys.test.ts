// LG-C1 privacy gate: fc-shared's server logger and span exporter replaced this service's own
// redaction walk (logger.ts safeFields, telemetry.ts RedactingSpanExporter). Nothing the local
// copy redacted may print now.
//
// LEGACY_KEY_PATTERN is the key pattern the local copy applied, frozen here as it stood at
// f12b8db: fc-shared 1.7.0's DEFAULT_SENSITIVE_KEY_PATTERN plus the coordinator's DPoP
// extension. KEYS names at least one key for every alternative of it, in the spellings this
// service and its dependencies use. Each must still be masked at the three places a value can
// leave the process: a log field, a field nested in a logged object, and a span attribute.
import { trace } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createStructuredLogger } from './logger.js';
import { startTelemetry, type Telemetry } from './telemetry.js';

const LEGACY_KEY_PATTERN =
  /pass(?:word|wd)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|authorization|credential|cookie|session[-_]?id|bearer|otp|passphrase|\bpin\b|\bssn\b|\bmfa\b|(?:^|[.\-_])(?:dpop|nonce|dpop[-_]?nonce)$/i;

/** One or more keys per alternative of LEGACY_KEY_PATTERN, in source order. */
const KEYS: readonly string[] = [
  // pass(?:word|wd)?
  'pass', 'password', 'passwd', 'PGPASSWORD', 'db_password', 'newPassword',
  // secret
  'secret', 'signing_secret', 'SECRET',
  // token
  'token', 'access_token', 'refresh_token', 'id_token', 'accessToken', 'x-auth-token',
  // api[-_]?key
  'api_key', 'api-key', 'apikey', 'apiKey', 'x-api-key',
  // access[-_]?key
  'access_key', 'access-key', 'accesskey', 'aws_access_key_id',
  // private[-_]?key
  'private_key', 'private-key', 'privatekey', 'ENTITLEMENT_SIGNING_PRIVATE_KEY',
  // client[-_]?secret
  'client_secret', 'client-secret', 'clientsecret', 'clientSecret',
  // authorization
  'authorization', 'Authorization', 'proxy-authorization',
  // credential
  'credential', 'credentials', 'x-amz-credential',
  // cookie
  'cookie', 'set-cookie', 'Cookie',
  // session[-_]?id
  'session_id', 'session-id', 'sessionid', 'sessionId',
  // bearer
  'bearer', 'bearer_value',
  // otp
  'otp', 'otp_code', 'totp',
  // passphrase
  'passphrase', 'key_passphrase',
  // \bpin\b, \bssn\b, \bmfa\b
  'pin', 'ssn', 'mfa',
  // the coordinator's DPoP extension: (?:^|[.\-_])(?:dpop|nonce|dpop[-_]?nonce)$
  'dpop', 'DPoP', 'nonce', 'dpop_nonce', 'dpop-nonce', 'dpopnonce', 'dpopNonce', 'DPoP-Nonce',
  'app.dpop', 'app.dpop_nonce', 'app.nonce', 'oidc_nonce', 'request.dpop-nonce',
];

/**
 * Keys an operator has to be able to read: none names a secret, and a pattern that swallowed
 * them would hide the signal the redaction exists to protect.
 */
const LEGIBLE_KEYS: readonly string[] = [
  'auth_outcome', 'app.dpop.attempts', 'nonce_rotations', 'device_count', 'jti_seen', 'htu', 'latency_ms',
];

/** An opaque value no VALUE pattern matches, unique per key so a leak names its key. */
const secretFor = (index: number): string => `zq8Zr3kVn1xMpLb7TfGh${String(index).padStart(4, '0')}`;

let telemetry: Telemetry | undefined;

afterEach(async () => {
  await telemetry?.shutdown();
  telemetry = undefined;
});

describe('LG-C1: every key the local redaction masked is still masked', () => {
  it('the list covers the legacy pattern: every key in it was one the local copy redacted', () => {
    for (const key of KEYS) expect(LEGACY_KEY_PATTERN.test(key), key).toBe(true);
    for (const key of LEGIBLE_KEYS) expect(LEGACY_KEY_PATTERN.test(key), key).toBe(false);
  });

  it.each(KEYS.map((key, index) => [key, secretFor(index)] as const))(
    'log field %s: the value never reaches the line',
    (key, secret) => {
      const lines: string[] = [];
      const log = createStructuredLogger({ level: 'info', sink: (line) => lines.push(line) });

      log.info({ [key]: secret, auth_outcome: 'checked' }, 'top level');
      log.info({ detail: { [key]: secret, inner: [{ [key]: secret }] } }, 'nested');
      log.child({ [key]: secret }).info('bound on a child');

      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(line, key).not.toContain(secret);
        expect(line, key).toContain('[REDACTED]');
      }
      expect((JSON.parse(lines[0]!) as Record<string, unknown>)['auth_outcome']).toBe('checked');
    },
  );

  it('span attributes: no value under any of the keys is handed to the exporter', async () => {
    const exported: Record<string, unknown>[] = [];
    telemetry = startTelemetry({
      env: {},
      exporter: {
        export(spans: readonly { attributes: Record<string, unknown> }[], done: (result: ExportResult) => void): void {
          exported.push(...spans.map((span) => span.attributes));
          done({ code: ExportResultCode.SUCCESS });
        },
        shutdown: () => Promise.resolve(),
      } as never,
    });

    trace.getTracer('test').startActiveSpan('keys', (span) => {
      KEYS.forEach((key, index) => span.setAttribute(key, secretFor(index)));
      LEGIBLE_KEYS.forEach((key) => span.setAttribute(key, 'legible-value'));
      span.end();
    });
    await telemetry.forceFlush();

    expect(exported).toHaveLength(1);
    const attributes = exported[0]!;
    KEYS.forEach((key, index) => {
      expect(attributes[key], key).toBe('[REDACTED]');
      expect(JSON.stringify(attributes), key).not.toContain(secretFor(index));
    });
    for (const key of LEGIBLE_KEYS) expect(attributes[key], key).toBe('legible-value');
  });

  it('keeps the keys an operator reads legible on a log line', () => {
    const lines: string[] = [];
    const log = createStructuredLogger({ level: 'info', sink: (line) => lines.push(line) });

    log.info(Object.fromEntries(LEGIBLE_KEYS.map((key) => [key, 'legible-value'])), 'legible');

    expect(lines[0]).not.toContain('[REDACTED]');
    expect(lines[0]!.split('legible-value')).toHaveLength(LEGIBLE_KEYS.length + 1);
  });
});
