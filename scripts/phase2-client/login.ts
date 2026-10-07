// WK-11 skeleton: the behaviour lands in the next commit.
import type { Transport } from './transport.js';
export class LoginError extends Error {}
export interface Discovery {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}
export interface Pkce {
  verifier: string;
  challenge: string;
  state: string;
}
export interface TokenSet {
  accessToken: string;
  expiresAt: number;
  secrets: string[];
}
export interface CallbackListener {
  redirectUri: string;
  code: Promise<string>;
  close(): Promise<void>;
}
export function challengeFor(_verifier: string): string {
  throw new Error('not implemented: WK-11');
}
export function createPkce(): Pkce {
  throw new Error('not implemented: WK-11');
}
export function authorizationUrl(_d: Discovery, _p: { clientId: string; redirectUri: string; pkce: Pkce }): string {
  throw new Error('not implemented: WK-11');
}
export async function discover(_t: Transport, _issuer: string): Promise<Discovery> {
  throw new Error('not implemented: WK-11');
}
export async function exchangeCode(
  _t: Transport,
  _d: Discovery,
  _p: { code: string; verifier: string; redirectUri: string; clientId: string; now: () => number },
): Promise<TokenSet> {
  throw new Error('not implemented: WK-11');
}
export async function listenForCallback(_o: { redirectUri: URL; state: string; timeoutMs: number }): Promise<CallbackListener> {
  throw new Error('not implemented: WK-11');
}
