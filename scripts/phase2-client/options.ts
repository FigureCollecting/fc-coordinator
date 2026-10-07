// The Phase-2 client's arguments. --plan is the default and sends nothing. A live run needs an
// explicit --target AND --confirm naming that target's host (with its port, if it has one): the
// plan-mode rule for acceptance scripts, where nothing reaches a real system without a token
// that names it. Every other refusal here keeps a token off a cleartext or unintended hop.
import { parseArgs } from 'node:util';
import { fromJsonString } from '@bufbuild/protobuf';
import { CompareRequestSchema } from '@figurecollecting/fc-api-contract';
import { validateRoutePrefix } from '../../src/auth/config.js';

/** The fc-coordinator provider (fc-infra blueprints/fc-coordinator-oidc.yaml, issuer_mode per_provider). */
export const DEFAULT_ISSUER = 'https://auth.mindsignals1.com/application/o/fc-coordinator/';
/** The public PKCE client; `aud` on its access tokens is this same value. */
export const DEFAULT_CLIENT_ID = 'fc-coordinator';
/** Registered on the provider (strict matching), and the only loopback redirect it accepts. */
export const DEFAULT_REDIRECT_URI = 'http://localhost:5173/callback';
const DEFAULT_PREFIX = '/api';
const DEFAULT_NONCE_PERIOD_SECONDS = 300;
const DEFAULT_RESTART_TIMEOUT_SECONDS = 300;

export const USAGE = `usage: npm run phase2 -- [--plan] [--target <origin> --confirm <host>] [options]

  --plan                       print what a live run would do and send nothing (the default)
  --target <origin>            the coordinator's public origin, e.g. https://fc-api-canary.mindsignals1.com
  --confirm <host>             go live: must equal the target's host (and port), typed out again
  --issuer <url>               OIDC issuer (default ${DEFAULT_ISSUER})
  --client-id <id>             OIDC client (default ${DEFAULT_CLIENT_ID})
  --redirect-uri <url>         loopback redirect the listener serves (default ${DEFAULT_REDIRECT_URI})
  --prefix <path>              route prefix the coordinator serves under (default ${DEFAULT_PREFIX})
  --b1-request <json>          the CompareRequest the in-cluster A7 call made, as proto3 JSON
  --b1-reference <file>        that call's result_json bytes; B1 compares against them
  --nonce-period-seconds <n>   the coordinator's DPOP_NONCE_PERIOD_SECONDS (default ${DEFAULT_NONCE_PERIOD_SECONDS})
  --restart-timeout-seconds <n>  how long B7 waits for the operator's restart (default ${DEFAULT_RESTART_TIMEOUT_SECONDS})
  --help                       this text`;

export class UsageError extends Error {}

export interface Options {
  mode: 'plan' | 'live';
  help: boolean;
  /** A bare origin, or undefined when none was given (plan only). */
  target: string | undefined;
  issuer: string;
  clientId: string;
  redirectUri: URL;
  prefix: string;
  b1Request: string | undefined;
  b1Reference: string | undefined;
  noncePeriodSeconds: number;
  restartTimeoutSeconds: number;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** The redirect listener binds IPv4 loopback (login.ts). */
const REDIRECT_HOSTS = new Set(['127.0.0.1', 'localhost']);

function absolute(raw: string, flag: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new UsageError(`${flag} must be an absolute URL, got '${raw}'`);
  }
}

/** https, or http to loopback only: a token never crosses a cleartext hop off this machine. */
function secure(url: URL, flag: string): void {
  const ok = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname));
  if (!ok) throw new UsageError(`${flag} must be https (http only to loopback), got '${url.href}'`);
}

function positive(raw: string | undefined, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new UsageError(`${flag} must be a positive number, got '${raw}'`);
  return value;
}

function compareRequest(raw: string): string {
  let parsed;
  try {
    parsed = fromJsonString(CompareRequestSchema, raw);
  } catch {
    throw new UsageError('--b1-request must be a CompareRequest in proto3 JSON');
  }
  if (parsed.seed.case === undefined) throw new UsageError('--b1-request names no seed (gtin14 or headId)');
  if (parsed.nowIso === '') throw new UsageError('--b1-request needs the nowIso the A7 call used');
  return raw;
}

export function parseOptions(argv: string[]): Options {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        plan: { type: 'boolean' },
        target: { type: 'string' },
        confirm: { type: 'string' },
        issuer: { type: 'string' },
        'client-id': { type: 'string' },
        'redirect-uri': { type: 'string' },
        prefix: { type: 'string' },
        'b1-request': { type: 'string' },
        'b1-reference': { type: 'string' },
        'nonce-period-seconds': { type: 'string' },
        'restart-timeout-seconds': { type: 'string' },
        help: { type: 'boolean' },
      },
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  let target: string | undefined;
  if (values.target !== undefined) {
    const url = absolute(values.target, '--target');
    secure(url, '--target');
    if (url.origin !== values.target) {
      throw new UsageError(`--target must be the bare origin '${url.origin}' (no path, no trailing slash, no default port), got '${values.target}'`);
    }
    target = url.origin;
  }

  let mode: Options['mode'] = 'plan';
  if (values.confirm !== undefined) {
    if (target === undefined) throw new UsageError('--confirm needs --target: it confirms that target');
    if (values.plan === true) throw new UsageError('--plan and --confirm contradict each other');
    const host = new URL(target).host;
    if (values.confirm !== host) throw new UsageError(`--confirm '${values.confirm}' does not match the target host '${host}'`);
    mode = 'live';
  }

  const issuer = values.issuer ?? DEFAULT_ISSUER;
  secure(absolute(issuer, '--issuer'), '--issuer');

  const rawRedirect = values['redirect-uri'] ?? DEFAULT_REDIRECT_URI;
  const redirectUri = absolute(rawRedirect, '--redirect-uri');
  if (redirectUri.protocol !== 'http:' || !REDIRECT_HOSTS.has(redirectUri.hostname)) {
    throw new UsageError(`--redirect-uri must be http on loopback (the listener is on this machine), got '${redirectUri.href}'`);
  }
  // The provider matches the redirect strictly, port included; an elided port is a different URI.
  if (redirectUri.port === '') throw new UsageError(`--redirect-uri must name its port, and not http's default 80, which a URL drops: got '${rawRedirect}'`);

  let prefix: string;
  try {
    prefix = validateRoutePrefix(values.prefix ?? DEFAULT_PREFIX, '--prefix');
  } catch (error) {
    throw new UsageError((error as Error).message);
  }

  return {
    mode,
    help: values.help === true,
    target,
    issuer,
    clientId: values['client-id'] ?? DEFAULT_CLIENT_ID,
    redirectUri,
    prefix,
    b1Request: values['b1-request'] === undefined ? undefined : compareRequest(values['b1-request']),
    b1Reference: values['b1-reference'],
    noncePeriodSeconds: positive(values['nonce-period-seconds'], '--nonce-period-seconds', DEFAULT_NONCE_PERIOD_SECONDS),
    restartTimeoutSeconds: positive(values['restart-timeout-seconds'], '--restart-timeout-seconds', DEFAULT_RESTART_TIMEOUT_SECONDS),
  };
}
