// WK-11 skeleton: the behaviour lands in the next commit.
import type { ClientKey } from './dpop.js';
import type { Sink } from './output.js';
import type { Transport } from './transport.js';
export interface MainDeps {
  stdout: Sink;
  stderr: Sink;
  transport: Transport;
  openBrowser: (url: string) => Promise<void>;
  generateKey: () => Promise<ClientKey>;
  awaitRestart: () => Promise<void>;
  readFile: (path: string) => Promise<Uint8Array>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
}
export async function main(_argv: string[], _deps: MainDeps): Promise<number> {
  throw new Error('not implemented: WK-11');
}
export function liveDeps(): MainDeps {
  throw new Error('not implemented: WK-11');
}
