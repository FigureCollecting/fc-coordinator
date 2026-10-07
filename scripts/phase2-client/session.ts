// WK-11 skeleton: the behaviour lands in the next commit.
import type { DescMessage, MessageShape } from '@bufbuild/protobuf';
import type { ClientKey } from './dpop.js';
import type { SafeOutput } from './output.js';
import type { Transport } from './transport.js';
export interface Target {
  origin: string;
  prefix: string;
}
export interface CallOptions {
  label: string;
  path: string;
  method?: 'GET' | 'POST';
  key?: ClientKey | undefined;
  nonce?: string | null | undefined;
  jti?: string | undefined;
  htu?: string | undefined;
  body?: string | Uint8Array | undefined;
  contentType?: string | undefined;
}
export interface Exchange {
  status: number;
  headers: Headers;
  body: Uint8Array;
  error: string | undefined;
  nonce: string | undefined;
  jti: string | undefined;
}
export type UnaryResult<T> =
  | { ok: true; message: T; exchange: Exchange }
  | { ok: false; status: number; code: string; exchange: Exchange };
export class Session {
  latestNonce: string | undefined;
  constructor(
    readonly transport: Transport,
    readonly target: Target,
    readonly accessToken: string,
    readonly output: SafeOutput,
  ) {}
  url(_path: string): string {
    throw new Error('not implemented: WK-11');
  }
  async call(_o: CallOptions): Promise<Exchange> {
    throw new Error('not implemented: WK-11');
  }
  async callRetrying(_o: CallOptions): Promise<Exchange> {
    throw new Error('not implemented: WK-11');
  }
  async enrol(_key: ClientKey, _label: string): Promise<string> {
    throw new Error('not implemented: WK-11');
  }
  async revoke(_key: ClientKey, _deviceId: string, _label: string): Promise<Exchange> {
    throw new Error('not implemented: WK-11');
  }
  async unary<I extends DescMessage, O extends DescMessage>(
    _key: ClientKey,
    _rpc: string,
    _input: I,
    _output: O,
    _message: MessageShape<I>,
    _label: string,
  ): Promise<UnaryResult<MessageShape<O>>> {
    throw new Error('not implemented: WK-11');
  }
}
