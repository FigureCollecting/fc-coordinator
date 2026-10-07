// WK-11 skeleton: the behaviour lands in the next commit.
export const DEFAULT_ISSUER = '';
export const DEFAULT_CLIENT_ID = '';
export const DEFAULT_REDIRECT_URI = '';
export const USAGE = '';
export class UsageError extends Error {}
export interface Options {
  mode: 'plan' | 'live';
  help: boolean;
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
export function parseOptions(_argv: string[]): Options {
  throw new Error('not implemented: WK-11');
}
