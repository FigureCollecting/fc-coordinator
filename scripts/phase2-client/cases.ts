// The nine proof-level cases of the edge runbook's Phase 2 (fc-infra docs/EDGE-CUTOVER-RUNBOOK.md,
// "The cases"): B1-B4, B5b, B6-B8 and B9b, which need a real token and a bound key.
//
// Every rejection case changes ONE thing about an otherwise valid request, and most run a control
// beside it: the same request done right, which must succeed. The client only ever sees
// `invalid_dpop_proof` or `use_dpop_nonce` (the coordinator names its reason in its own log,
// never on the wire), so "rejected for THIS reason" rests on the control plus the verifier's
// fixed order (src/auth/dpop.ts): binding, then htm/htu, iat, ath, the nonce, and the jti last.
//
// A verdict is PASS, FAIL or INCONCLUSIVE, and only PASS is a pass.
import { createHash } from 'node:crypto';
import { fromJsonString } from '@bufbuild/protobuf';
import { CompareRequestSchema, CompareResponseSchema } from '@figurecollecting/fc-api-contract';
import { nonceParts, type ClientKey } from './dpop.js';
import { Session, type Exchange, type Target } from './session.js';
import type { Transport } from './transport.js';

export type Verdict = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface CaseResult {
  id: string;
  verdict: Verdict;
  detail: string;
}

export interface CaseContext {
  session: Session;
  primary: ClientKey;
  primaryDeviceId: string;
  generateKey: () => Promise<ClientKey>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Epoch ms. No refresh grant exists, so a case that would outlive the token says so. */
  tokenExpiresAt: number;
}

/** A guarded route that touches nothing but the device binding. */
export const SESSION_PATH = '/auth/session';
export const COMPARE_RPC = '/coordinator.v1.CompareService/Compare';
/** Leave this much of the token's life unused, so a case never ends on an expiry it caused. */
export const TOKEN_MARGIN_MS = 5_000;

const result = (id: string, verdict: Verdict, detail: string): CaseResult => ({ id, verdict, detail });
const said = (res: Exchange): string => `${res.status}${res.error !== undefined ? ` ${res.error}` : ''}`;
const refusedProof = (res: Exchange): boolean => res.status === 401 && res.error === 'invalid_dpop_proof';
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** No credentials at all: the coordinator answers 401 with a DPoP challenge and a DPoP-Nonce. */
export async function preflight(t: Transport, target: Target): Promise<CaseResult> {
  const res = await t.request({ method: 'GET', url: `${target.origin}${target.prefix}${SESSION_PATH}`, headers: {}, label: 'preflight' });
  const challenge = res.headers.get('www-authenticate') ?? '';
  if (res.status !== 401 || !/^DPoP\b/.test(challenge)) {
    return result('preflight', 'FAIL', `${target.origin}${target.prefix}${SESSION_PATH} answered ${res.status}, not the coordinator's 401 DPoP challenge: wrong target, or the edge is not routing it`);
  }
  if (res.headers.get('dpop-nonce') === null) {
    return result('preflight', 'FAIL', 'the 401 carries no DPoP-Nonce: something on the path strips it, and no request can ever succeed');
  }
  return result('preflight', 'PASS', '401 with a DPoP challenge and a DPoP-Nonce, before any credential was sent');
}

export async function caseB5b(ctx: CaseContext): Promise<CaseResult> {
  const first = await ctx.session.call({ label: 'B5b:no-nonce', path: SESSION_PATH, key: ctx.primary, nonce: null });
  if (first.status !== 401 || first.error !== 'use_dpop_nonce' || first.nonce === undefined) {
    return result('B5b', 'FAIL', `a proof with no nonce got ${said(first)}, not 401 use_dpop_nonce with a DPoP-Nonce`);
  }
  const retry = await ctx.session.call({ label: 'B5b:retry', path: SESSION_PATH, key: ctx.primary, nonce: first.nonce });
  if (retry.status !== 200) return result('B5b', 'FAIL', `the retry with the returned nonce and a fresh jti got ${said(retry)}`);
  return result('B5b', 'PASS', '401 use_dpop_nonce with a DPoP-Nonce, then 200 on the retry with that nonce and a fresh jti');
}

export async function caseB1(ctx: CaseContext, b1: { request?: string | undefined; reference?: Uint8Array | undefined }): Promise<CaseResult> {
  if (b1.request === undefined) return result('B1', 'INCONCLUSIVE', 'no --b1-request: B1 replays the A7 request and compares its bytes');
  const res = await ctx.session.unary(ctx.primary, COMPARE_RPC, CompareRequestSchema, CompareResponseSchema, fromJsonString(CompareRequestSchema, b1.request), 'B1');
  if (!res.ok) return result('B1', 'FAIL', `Compare answered ${res.status} ${res.code}`.trimEnd());
  const got = new TextEncoder().encode(res.message.resultJson);
  const shape = `result_json ${got.byteLength} bytes sha256 ${sha256(got)}`;
  if (b1.reference === undefined) return result('B1', 'INCONCLUSIVE', `200, ${shape}; no --b1-reference to compare it with`);
  const ref = b1.reference;
  if (got.byteLength === ref.byteLength && got.every((byte, i) => byte === ref[i])) {
    return result('B1', 'PASS', `200; ${shape}, byte-identical to the reference`);
  }
  let at = 0;
  while (at < got.byteLength && at < ref.byteLength && got[at] === ref[at]) at += 1;
  return result('B1', 'FAIL', `200, but ${shape} differs from the reference (${ref.byteLength} bytes, sha256 ${sha256(ref)}) at byte ${at}`);
}

export async function caseB2(ctx: CaseContext): Promise<CaseResult> {
  const res = await ctx.session.call({ label: 'B2', path: SESSION_PATH });
  return refusedProof(res)
    ? result('B2', 'PASS', 'a valid token with no DPoP header: 401 invalid_dpop_proof')
    : result('B2', 'FAIL', `a valid token with no DPoP header got ${said(res)}, not 401 invalid_dpop_proof`);
}

export async function caseB3(ctx: CaseContext): Promise<CaseResult> {
  const first = await ctx.session.callRetrying({ label: 'B3:first', path: SESSION_PATH, key: ctx.primary });
  if (first.status !== 200) return result('B3', 'FAIL', `the first use of the jti got ${said(first)}, so its reuse proves nothing`);
  // A new proof (new iat, current nonce) carrying the same jti: only step 7 can refuse it.
  const replay = await ctx.session.callRetrying({ label: 'B3:replay', path: SESSION_PATH, key: ctx.primary, jti: first.jti });
  return refusedProof(replay)
    ? result('B3', 'PASS', 'a jti accepted once, then presented again in a new proof: 401 invalid_dpop_proof')
    : result('B3', 'FAIL', `the reused jti got ${said(replay)}, not 401 invalid_dpop_proof`);
}

export async function caseB4(ctx: CaseContext): Promise<CaseResult> {
  const control = await ctx.session.callRetrying({ label: 'B4:control', path: SESSION_PATH, key: ctx.primary });
  if (control.status !== 200) return result('B4', 'FAIL', `the control from the enrolled key got ${said(control)}`);
  const stray = await ctx.generateKey();
  const res = await ctx.session.call({ label: 'B4:stray', path: SESSION_PATH, key: stray });
  return refusedProof(res)
    ? result('B4', 'PASS', 'a proof signed by a key never enrolled: 401 invalid_dpop_proof (key_not_bound: the same request from the enrolled key got 200)')
    : result('B4', 'FAIL', `a proof signed by a key never enrolled got ${said(res)}, not 401 invalid_dpop_proof`);
}

export async function caseB9b(ctx: CaseContext): Promise<CaseResult> {
  const control = await ctx.session.callRetrying({ label: 'B9b:control', path: SESSION_PATH, key: ctx.primary });
  if (control.status !== 200) return result('B9b', 'FAIL', `the control with the right htu got ${said(control)}`);
  const www = new URL(ctx.session.url(SESSION_PATH));
  const host = www.host;
  www.hostname = `www.${www.hostname}`;
  // The URL setter silently refuses a name it cannot parse (www.127.0.0.1 reads as a bad IPv4
  // address), which would send the RIGHT htu and make this case measure nothing.
  if (www.host === host) return result('B9b', 'INCONCLUSIVE', `no www. form of ${host} exists to name in an htu (an IP-literal target?)`);
  const res = await ctx.session.call({ label: 'B9b:www', path: SESSION_PATH, key: ctx.primary, htu: www.toString() });
  return refusedProof(res)
    ? result('B9b', 'PASS', `a proof whose htu names ${www.host}: 401 invalid_dpop_proof (htu_mismatch: the same request with the right htu got 200)`)
    : result('B9b', 'FAIL', `a proof whose htu names ${www.host} got ${said(res)}, not 401 invalid_dpop_proof`);
}

export async function caseB8(ctx: CaseContext): Promise<CaseResult> {
  const second = await ctx.generateKey();
  let secondId: string;
  try {
    secondId = await ctx.session.enrol(second, 'B8:enrol-second');
  } catch (error) {
    return result('B8', 'FAIL', `the second device could not be enrolled: ${(error as Error).message}`);
  }
  const before = await ctx.session.callRetrying({ label: 'B8:second-before', path: SESSION_PATH, key: second });
  if (before.status !== 200 || Session.deviceOf(before) !== secondId) {
    return result('B8', 'FAIL', `the second device did not work before its revocation: ${said(before)}`);
  }
  const revoke = await ctx.session.revoke(ctx.primary, secondId, 'B8:revoke');
  if (revoke.status !== 200) return result('B8', 'FAIL', `revoke of the second device answered ${said(revoke)}`);
  // Single shot: a use_dpop_nonce here would mean the binding step PASSED, which is the failure.
  const after = await ctx.session.call({ label: 'B8:second-after', path: SESSION_PATH, key: second });
  const other = await ctx.session.callRetrying({ label: 'B8:primary-after', path: SESSION_PATH, key: ctx.primary });
  const halves = `revoked device ${said(after)}; other device ${said(other)}`;
  if (!refusedProof(after)) return result('B8', 'FAIL', `the revoked device was not refused: ${halves}`);
  if (other.status !== 200 || Session.deviceOf(other) !== ctx.primaryDeviceId) {
    return result('B8', 'FAIL', `the other device stopped working: ${halves}`);
  }
  return result('B8', 'PASS', `revoked device 401 invalid_dpop_proof (key_not_bound) while the same user's other device got 200`);
}

const MAX_B6_ATTEMPTS = 3;

/**
 * Capture a nonce (bucket b), wait until the coordinator is in bucket b+1, and present it. The
 * epoch and bucket are read off the nonces the coordinator hands out, so "previous bucket, same
 * epoch" is shown, not assumed from the clocks.
 */
export async function caseB6(ctx: CaseContext, o: { periodMs: number }): Promise<CaseResult> {
  const capture = await ctx.session.callRetrying({ label: 'B6:capture', path: SESSION_PATH, key: ctx.primary });
  if (capture.status !== 200) return result('B6', 'FAIL', `capturing a nonce got ${said(capture)}`);
  const captured = capture.nonce;
  const p0 = nonceParts(captured);
  if (p0 === undefined) return result('B6', 'INCONCLUSIVE', 'the answer carried no readable DPoP-Nonce to hold');
  const clockBucket = BigInt(Math.floor(ctx.now() / o.periodMs));
  if (clockBucket - p0.bucket > 1n || p0.bucket - clockBucket > 1n) {
    return result('B6', 'INCONCLUSIVE', `the nonce's bucket ${p0.bucket} is not this clock's ${clockBucket}: is --nonce-period-seconds the coordinator's period?`);
  }
  const margin = Math.min(5_000, o.periodMs / 4);
  const boundary = Number(p0.bucket + 1n) * o.periodMs;
  for (let attempt = 1; attempt <= MAX_B6_ATTEMPTS; attempt += 1) {
    const wait = Math.max(0, boundary + margin * attempt - ctx.now());
    if (ctx.now() + wait > ctx.tokenExpiresAt - TOKEN_MARGIN_MS) {
      return result('B6', 'INCONCLUSIVE', `the access token expires before bucket ${p0.bucket + 1n} begins; run again with a fresh sign-in`);
    }
    await ctx.sleep(wait);
    const res = await ctx.session.call({ label: 'B6', path: SESSION_PATH, key: ctx.primary, nonce: captured });
    const p1 = nonceParts(res.nonce);
    if (p1 === undefined) return result('B6', 'FAIL', `the answer carried no DPoP-Nonce (${said(res)})`);
    if (p1.epoch !== p0.epoch) return result('B6', 'INCONCLUSIVE', 'the coordinator restarted during B6 (a new nonce epoch)');
    if (p1.bucket === p0.bucket) continue;
    if (p1.bucket !== p0.bucket + 1n) {
      return result('B6', 'INCONCLUSIVE', `the coordinator was already two buckets on (${p1.bucket}) when the bucket-${p0.bucket} nonce arrived`);
    }
    return res.status === 200
      ? result('B6', 'PASS', `a nonce from bucket ${p0.bucket} presented in bucket ${p1.bucket}, same epoch: 200`)
      : result('B6', 'FAIL', `a nonce from bucket ${p0.bucket} presented in bucket ${p1.bucket}, same epoch, got ${said(res)}`);
  }
  return result('B6', 'INCONCLUSIVE', `the bucket did not roll past ${p0.bucket} in ${MAX_B6_ATTEMPTS} tries: is --nonce-period-seconds the coordinator's period?`);
}

/**
 * A request the old process accepts (its jti J goes into that process's replay window), then the
 * operator restarts the coordinator. Poll with the old epoch's nonce until an answer comes from a
 * new epoch. Both halves are asserted, as the runbook demands:
 *   1. that first new-epoch answer is 401 use_dpop_nonce: REJECTED ON THE NONCE CHECK;
 *   2. J, presented again with the new nonce, is ACCEPTED: the replay cache is empty.
 * Half 2 proves the empty cache only while J would still be inside the old window; past it the
 * old process would have forgotten J anyway, and the case says INCONCLUSIVE.
 */
export async function caseB7(
  ctx: CaseContext,
  o: { awaitRestart: () => Promise<void>; timeoutMs: number; pollMs: number; jtiWindowMs: number },
): Promise<CaseResult> {
  const before = await ctx.session.callRetrying({ label: 'B7:before', path: SESSION_PATH, key: ctx.primary });
  const p0 = nonceParts(before.nonce);
  if (before.status !== 200 || p0 === undefined) return result('B7', 'FAIL', `the request before the restart got ${said(before)}`);
  let accepted = { jti: before.jti!, at: ctx.now() };

  await o.awaitRestart();

  const waitedFrom = ctx.now();
  const deadline = Math.min(waitedFrom + o.timeoutMs, ctx.tokenExpiresAt - TOKEN_MARGIN_MS);
  let first: Exchange | undefined;
  while (first === undefined) {
    if (ctx.now() > deadline) return result('B7', 'INCONCLUSIVE', `no restart observed (no new nonce epoch) within ${Math.round((deadline - waitedFrom) / 1000)} s`);
    let res: Exchange;
    try {
      res = await ctx.session.call({ label: 'B7:poll', path: SESSION_PATH, key: ctx.primary });
    } catch {
      await ctx.sleep(o.pollMs);
      continue;
    }
    const parts = nonceParts(res.nonce);
    if (parts !== undefined && parts.epoch !== p0.epoch) {
      first = res;
      break;
    }
    if (parts !== undefined && res.status === 200) accepted = { jti: res.jti!, at: ctx.now() };
    await ctx.sleep(o.pollMs);
  }

  const onNonce = first.status === 401 && first.error === 'use_dpop_nonce';
  if (!onNonce) return result('B7', 'FAIL', `the new process answered an old-epoch nonce with ${said(first)}, not 401 use_dpop_nonce`);
  const replay = await ctx.session.call({ label: 'B7:replayed-jti', path: SESSION_PATH, key: ctx.primary, jti: accepted.jti });
  const age = ctx.now() - accepted.at;
  if (replay.status !== 200) {
    return result('B7', 'FAIL', `a jti the old process accepted ${Math.round(age / 1000)} s earlier got ${said(replay)}: the replay cache did not start empty`);
  }
  if (age >= o.jtiWindowMs) {
    return result('B7', 'INCONCLUSIVE', `both halves held, but the replayed jti was ${Math.round(age / 1000)} s old, past the ${Math.round(o.jtiWindowMs / 1000)} s jti window, so its acceptance says nothing about the cache`);
  }
  return result('B7', 'PASS', `an old-epoch nonce got 401 use_dpop_nonce (rejected on the nonce check); a jti the old process accepted ${Math.round(age / 1000)} s earlier got 200 (replay cache empty)`);
}
