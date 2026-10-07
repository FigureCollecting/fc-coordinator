// One signed-in session against the coordinator: the access token, the target, and the most
// recent DPoP-Nonce. Every request is signed afresh, the way fc-mobile signs: a proof per call,
// for this method and this URL, with the latest nonce, refreshed from every answer.
//
// The cases need to break one rule at a time, so `call` lets a case choose the key (or none), the
// nonce (or none), the jti and the htu. Everything else stays correct, which is what makes a
// rejection attributable to the one thing the case changed.
import { fromBinary, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';
import { challengeError, signProof, type ClientKey } from './dpop.js';
import type { SafeOutput } from './output.js';
import type { Transport } from './transport.js';

export interface Target {
  /** The coordinator's public origin: the left-hand side of every htu. */
  origin: string;
  /** The route prefix it serves under; the edge forwards it unchanged. */
  prefix: string;
}

export interface CallOptions {
  label: string;
  /** Under the prefix, e.g. /auth/session. */
  path: string;
  method?: 'GET' | 'POST';
  /** The key that signs the proof. Undefined sends the token with NO proof (B2). */
  key?: ClientKey | undefined;
  /** Undefined: the latest nonce. null: none at all (B5b). */
  nonce?: string | null | undefined;
  jti?: string | undefined;
  /** Sign this htu instead of the request URL (B9b). */
  htu?: string | undefined;
  body?: string | Uint8Array | undefined;
  contentType?: string | undefined;
}

export interface Exchange {
  status: number;
  headers: Headers;
  body: Uint8Array;
  /** The DPoP challenge's error code, when the answer carries one. */
  error: string | undefined;
  /** The DPoP-Nonce this answer carried. */
  nonce: string | undefined;
  /** The jti of the proof this request carried. */
  jti: string | undefined;
}

export type UnaryResult<T> =
  | { ok: true; message: T; exchange: Exchange }
  | { ok: false; status: number; code: string; exchange: Exchange };

const text = (body: Uint8Array): string => new TextDecoder().decode(body);

export class Session {
  latestNonce: string | undefined;

  constructor(
    readonly transport: Transport,
    readonly target: Target,
    readonly accessToken: string,
    readonly output: SafeOutput,
  ) {
    output.secret(accessToken);
  }

  url(path: string): string {
    return `${this.target.origin}${this.target.prefix}${path}`;
  }

  async call(o: CallOptions): Promise<Exchange> {
    const method = o.method ?? 'GET';
    const url = this.url(o.path);
    const headers: Record<string, string> = { authorization: `DPoP ${this.accessToken}` };
    let jti: string | undefined;
    if (o.key !== undefined) {
      const nonce = o.nonce === null ? undefined : (o.nonce ?? this.latestNonce);
      const signed = await signProof(o.key, { htm: method, htu: o.htu ?? url, accessToken: this.accessToken, nonce, jti: o.jti });
      this.output.secret(signed.proof);
      headers['dpop'] = signed.proof;
      jti = signed.jti;
    }
    if (o.contentType !== undefined) headers['content-type'] = o.contentType;
    const res = await this.transport.request({ method, url, headers, ...(o.body !== undefined ? { body: o.body } : {}), label: o.label });
    const nonce = res.headers.get('dpop-nonce') ?? undefined;
    if (nonce !== undefined) {
      this.output.secret(nonce);
      this.latestNonce = nonce;
    }
    return { status: res.status, headers: res.headers, body: res.body, error: challengeError(res.headers.get('www-authenticate')), nonce, jti };
  }

  /**
   * The `use_dpop_nonce` round trip (RFC 9449 §8): retry ONCE with the nonce just supplied, and a
   * fresh jti unless the caller pinned one.
   */
  async callRetrying(o: CallOptions): Promise<Exchange> {
    const first = await this.call(o);
    if (first.status !== 401 || first.error !== 'use_dpop_nonce') return first;
    return this.call({ ...o, nonce: undefined });
  }

  /** POST /auth/devices: the key vouches for itself, signed like any other request. */
  async enrol(key: ClientKey, label: string): Promise<string> {
    const res = await this.callRetrying({ label, method: 'POST', path: '/auth/devices', key, body: '{}', contentType: 'application/json' });
    if (res.status !== 201 && res.status !== 200) throw new Error(`enrolment answered ${res.status}`);
    const deviceId = (JSON.parse(text(res.body)) as { deviceId?: unknown }).deviceId;
    if (typeof deviceId !== 'string') throw new Error('enrolment answered without a deviceId');
    return deviceId;
  }

  async revoke(key: ClientKey, deviceId: string, label: string): Promise<Exchange> {
    return this.callRetrying({ label, method: 'POST', path: `/auth/devices/${deviceId}/revoke`, key, body: '{}', contentType: 'application/json' });
  }

  /** The device id the coordinator bound this request to, from GET /auth/session. */
  static deviceOf(res: Exchange): string | undefined {
    try {
      const deviceId = (JSON.parse(text(res.body)) as { deviceId?: unknown }).deviceId;
      return typeof deviceId === 'string' ? deviceId : undefined;
    } catch {
      return undefined;
    }
  }

  /** A Connect unary call in the binary codec, so a newer server's extra fields are kept, not fatal. */
  async unary<I extends DescMessage, O extends DescMessage>(
    key: ClientKey,
    rpc: string,
    input: I,
    output: O,
    message: MessageShape<I>,
    label: string,
  ): Promise<UnaryResult<MessageShape<O>>> {
    const exchange = await this.callRetrying({
      label,
      method: 'POST',
      path: rpc,
      key,
      body: toBinary(input, message),
      contentType: 'application/proto',
    });
    if (exchange.status === 200) return { ok: true, message: fromBinary(output, exchange.body), exchange };
    let code = '';
    try {
      const parsed = (JSON.parse(text(exchange.body)) as { code?: unknown; error?: unknown });
      code = typeof parsed.code === 'string' ? parsed.code : typeof parsed.error === 'string' ? parsed.error : '';
    } catch {
      // Not a Connect error body; the status stands alone.
    }
    return { ok: false, status: exchange.status, code, exchange };
  }
}
