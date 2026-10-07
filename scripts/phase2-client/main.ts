// The Phase-2 client (WK-11): the nine proof-level cases of the edge runbook's Phase 2 and a sync
// smoke, against a coordinator's public origin, with a real sign-in.
//
//   npm run phase2                                     # --plan: print the run, send nothing
//   npm run phase2 -- --target https://fc-api-canary.mindsignals1.com \
//                     --confirm fc-api-canary.mindsignals1.com \
//                     --b1-request '<A7 CompareRequest JSON>' --b1-reference <A7 result_json file>
//
// --plan is the default and sends ZERO requests: no discovery, no listener, no key. A live run
// needs --target and a --confirm that names its host, and it then asks one person to sign in.
//
// Exit codes: 0 every case and the smoke PASS; 1 anything else; 2 the run could not start or was
// cut off (bad arguments, a target that is not the coordinator, a failed sign-in, a network
// failure mid-run).
import { readFile } from 'node:fs/promises';
import {
  caseB1,
  caseB2,
  caseB3,
  caseB4,
  caseB5b,
  caseB6,
  caseB7,
  caseB8,
  caseB9b,
  preflight,
  type CaseContext,
  type CaseResult,
} from './cases.js';
import { generateClientKey, type ClientKey } from './dpop.js';
import { LoginError, authorizationUrl, createPkce, discover, exchangeCode, listenForCallback } from './login.js';
import { USAGE, parseOptions, type Options } from './options.js';
import { createSafeOutput, type SafeOutput, type Sink } from './output.js';
import { Session } from './session.js';
import { syncSmoke } from './smoke.js';
import { createFetchTransport, type Transport } from './transport.js';

export interface MainDeps {
  stdout: Sink;
  stderr: Sink;
  transport: Transport;
  /** The sign-in URL is printed first; live, this does nothing more and the person opens it. */
  openBrowser: (url: string) => Promise<void>;
  generateKey: () => Promise<ClientKey>;
  /** B7's restart is the operator's: live, the instruction is printed and the client polls. */
  awaitRestart: () => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
}

const LOGIN_TIMEOUT_MS = 5 * 60_000;
/** The coordinator's jti window at its defaults: (DPOP_PROOF_MAX_AGE_SECONDS 30 + DPOP_CLOCK_SKEW_SECONDS 5) s + 1 s. */
const JTI_WINDOW_MS = 36_000;
const CASES = ['B1', 'B2', 'B3', 'B4', 'B5b', 'B6', 'B7', 'B8', 'B9b'];

export function liveDeps(): MainDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    transport: createFetchTransport(),
    openBrowser: async () => {},
    generateKey: generateClientKey,
    awaitRestart: async () => {},
    readFile: async (path) => new Uint8Array(await readFile(path)),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pollMs: 5_000,
  };
}

const line = (r: CaseResult): string => `${r.id.padEnd(10)}${r.verdict} ${r.detail}`;

function printPlan(o: Options, io: SafeOutput): void {
  const p = o.prefix;
  const host = o.target === undefined ? undefined : new URL(o.target).host;
  const plan = [
    'PLAN: nothing is sent. This is what a live run does, in order.',
    '',
    `target    ${o.target ?? 'none: a live run needs --target <origin> --confirm <host>'}`,
    `issuer    ${o.issuer}`,
    `client    ${o.clientId} (public; authorization code + PKCE S256)`,
    `redirect  ${o.redirectUri.href} (served on loopback by this process)`,
    `prefix    ${p === '' ? '(root)' : p}`,
    '',
    `  preflight GET ${p}/auth/session with no credentials: 401, a DPoP challenge and a DPoP-Nonce, or stop`,
    '  sign-in   OIDC discovery, then one browser sign-in by a person, then the code exchange',
    `  enrol     POST ${p}/auth/devices with a fresh ES256 key held in memory (never exported)`,
    `  B5b       a proof with no nonce: 401 use_dpop_nonce; the retry with that nonce and a fresh jti: 200`,
    `  B1        Compare (${o.b1Request === undefined ? 'needs --b1-request' : 'the --b1-request'}): 200, result_json byte-identical to ${o.b1Reference ?? 'the --b1-reference (none given)'}`,
    '  B2        a valid token with no proof: 401 invalid_dpop_proof',
    '  B3        a jti accepted once, presented again: 401 invalid_dpop_proof',
    '  B4        a proof from a key never enrolled: 401 invalid_dpop_proof, beside a 200 control',
    '  B9b       a proof whose htu names the www. host: 401 invalid_dpop_proof, beside a 200 control',
    '  B8        enrol a second key, revoke it: it is refused while the first device still gets 200',
    `  smoke     Status; one Push of occ/<new occurrence uuid>/head and occ/<new occurrence uuid>/status (wished); Delta from the Status cursor shows both; then the status is tombstoned`,
    `  B6        hold a nonce until the next ${o.noncePeriodSeconds} s bucket: accepted, same epoch (waits up to one period)`,
    `  B7        the OPERATOR restarts the coordinator (up to ${o.restartTimeoutSeconds} s): an old-epoch nonce gets 401 use_dpop_nonce, and a pre-restart jti is accepted`,
    '  cleanup   revoke the run\'s first device',
    '',
    'a live run writes: two device rows (both revoked by the end), one occurrence (head + status, the status tombstoned), feed cursors',
    'the access token lives 10 minutes with no refresh: the whole run fits inside one sign-in',
    `to run it: --target ${o.target ?? '<origin>'} --confirm ${host ?? '<host>'}`,
  ];
  for (const text of plan) io.out(text);
}

export async function main(argv: string[], deps: MainDeps): Promise<number> {
  const io = createSafeOutput(deps.stdout, deps.stderr);
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    // parseOptions throws only UsageError; whatever it is, the arguments are what failed.
    io.err((error as Error).message);
    io.err(USAGE);
    return 2;
  }
  if (options.help) {
    io.out(USAGE);
    return 0;
  }
  if (options.mode === 'plan') {
    printPlan(options, io);
    io.out(`requests sent: ${deps.transport.count}`);
    return 0;
  }
  try {
    return await live(options, deps, io);
  } catch (error) {
    io.err(error instanceof LoginError ? `sign-in failed: ${error.message}` : `aborted: ${(error as Error).message}`);
    io.out(`requests sent: ${deps.transport.count}`);
    return 2;
  }
}

async function live(o: Options, deps: MainDeps, io: SafeOutput): Promise<number> {
  const target = { origin: o.target!, prefix: o.prefix };

  let reference: Uint8Array | undefined;
  if (o.b1Reference !== undefined) {
    try {
      reference = await deps.readFile(o.b1Reference);
    } catch (error) {
      io.err(`cannot read --b1-reference ${o.b1Reference}: ${(error as Error).message}`);
      return 2;
    }
  }

  io.out(`LIVE against ${target.origin}${target.prefix} (confirmed)`);
  const pre = await preflight(deps.transport, target);
  io.out(line(pre));
  if (pre.verdict !== 'PASS') {
    io.out(`requests sent: ${deps.transport.count}`);
    return 2;
  }

  const discovery = await discover(deps.transport, o.issuer);
  const pkce = createPkce();
  io.secret(pkce.verifier);
  const listener = await listenForCallback({ redirectUri: o.redirectUri, state: pkce.state, timeoutMs: LOGIN_TIMEOUT_MS });
  let code: string;
  try {
    const url = authorizationUrl(discovery, { clientId: o.clientId, redirectUri: listener.redirectUri, pkce });
    io.err('sign in: open this URL in a browser on this machine and sign in once');
    io.err(url);
    await deps.openBrowser(url);
    code = await listener.code;
  } finally {
    await listener.close();
  }
  io.secret(code);
  const tokens = await exchangeCode(deps.transport, discovery, { code, verifier: pkce.verifier, redirectUri: listener.redirectUri, clientId: o.clientId, now: deps.now });
  for (const secret of tokens.secrets) io.secret(secret);
  const session = new Session(deps.transport, target, tokens.accessToken, io);
  io.out(`signed in; the access token expires in ${Math.round((tokens.expiresAt - deps.now()) / 1000)} s`);

  const generateKey = async (): Promise<ClientKey> => {
    const key = await deps.generateKey();
    io.secret(key.publicJwk.x);
    io.secret(key.publicJwk.y);
    io.secret(key.jkt);
    return key;
  };
  const primary = await generateKey();
  const primaryDeviceId = await session.enrol(primary, 'enrol');
  io.out(`device enrolled: ${primaryDeviceId}`);

  const ctx: CaseContext = { session, primary, primaryDeviceId, generateKey, now: deps.now, sleep: deps.sleep, tokenExpiresAt: tokens.expiresAt };
  const results: CaseResult[] = [];
  const record = (r: CaseResult): void => {
    results.push(r);
    io.out(line(r));
  };

  record(await caseB5b(ctx));
  record(await caseB1(ctx, { request: o.b1Request, reference }));
  record(await caseB2(ctx));
  record(await caseB3(ctx));
  record(await caseB4(ctx));
  record(await caseB9b(ctx));
  record(await caseB8(ctx));
  const smoke = await syncSmoke(ctx);
  record(smoke);
  io.out(`B6: holding a nonce until the coordinator's next ${o.noncePeriodSeconds} s bucket`);
  record(await caseB6(ctx, { periodMs: o.noncePeriodSeconds * 1000 }));
  io.err(`B7: RESTART THE COORDINATOR NOW (operator), e.g. kubectl -n figurecollecting rollout restart deploy/fc-coordinator; polling for a new nonce epoch for up to ${o.restartTimeoutSeconds} s`);
  record(
    await caseB7(ctx, {
      awaitRestart: deps.awaitRestart,
      timeoutMs: o.restartTimeoutSeconds * 1000,
      pollMs: deps.pollMs,
      jtiWindowMs: JTI_WINDOW_MS,
    }),
  );

  const revoke = await session.revoke(primary, primaryDeviceId, 'cleanup');
  record({
    id: 'cleanup',
    verdict: revoke.status === 200 ? 'PASS' : 'FAIL',
    detail: revoke.status === 200 ? `the run's first device ${primaryDeviceId} revoked` : `revoking the run's first device ${primaryDeviceId} answered ${revoke.status}`,
  });

  const passed = results.filter((r) => CASES.includes(r.id) && r.verdict === 'PASS').length;
  io.out(`${passed} of ${CASES.length} cases PASS; the sync smoke ${smoke.verdict}`);
  io.out(`requests sent: ${deps.transport.count}`);
  return results.every((r) => r.verdict === 'PASS') ? 0 : 1;
}
