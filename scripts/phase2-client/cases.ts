// WK-11 skeleton: the behaviour lands in the next commit.
import type { ClientKey } from './dpop.js';
import type { Session, Target } from './session.js';
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
  tokenExpiresAt: number;
}
const todo = (): never => {
  throw new Error('not implemented: WK-11');
};
export async function preflight(_t: Transport, _target: Target): Promise<CaseResult> {
  return todo();
}
export async function caseB1(_ctx: CaseContext, _b1: { request?: string | undefined; reference?: Uint8Array | undefined }): Promise<CaseResult> {
  return todo();
}
export async function caseB2(_ctx: CaseContext): Promise<CaseResult> {
  return todo();
}
export async function caseB3(_ctx: CaseContext): Promise<CaseResult> {
  return todo();
}
export async function caseB4(_ctx: CaseContext): Promise<CaseResult> {
  return todo();
}
export async function caseB5b(_ctx: CaseContext): Promise<CaseResult> {
  return todo();
}
export async function caseB6(_ctx: CaseContext, _o: { periodMs: number }): Promise<CaseResult> {
  return todo();
}
export async function caseB7(
  _ctx: CaseContext,
  _o: { awaitRestart: () => Promise<void>; timeoutMs: number; pollMs: number; jtiWindowMs: number },
): Promise<CaseResult> {
  return todo();
}
export async function caseB8(_ctx: CaseContext): Promise<CaseResult> {
  return todo();
}
export async function caseB9b(_ctx: CaseContext): Promise<CaseResult> {
  return todo();
}
