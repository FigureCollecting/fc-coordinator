// The Phase-2 client's ONE door to the network. Every request it sends, to the identity provider
// or to the coordinator, goes through `request`, and `count` says how many it tried. That counter
// is what lets --plan assert it sent nothing (WK-11 acceptance (b)).
//
// This is the CLIENT hop, the one fc-mobile makes: the public edge over HTTPS, Connect-Web on
// the coordinator side. It is not a component-to-component hop and adds none.
//
// It never follows a redirect. A 3xx carrying a token's request to another place is answered,
// not obeyed: the caller decides what a redirect means, and none of them is followed.

/** One outbound request. `label` names the step it belongs to and never goes on the wire. */
export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  label: string;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface Transport {
  request(req: HttpRequest): Promise<HttpResponse>;
  /** Requests attempted, failed ones included. */
  readonly count: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

export function createFetchTransport(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Transport {
  const send = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let count = 0;
  return {
    get count() {
      return count;
    },
    async request(req) {
      count += 1;
      const res = await send(req.url, {
        method: req.method,
        headers: req.headers,
        // A copy, so the body is a plain ArrayBuffer view whatever buffer the caller's sat on.
        ...(req.body !== undefined ? { body: typeof req.body === 'string' ? req.body : new Uint8Array(req.body) } : {}),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, headers: res.headers, body: new Uint8Array(await res.arrayBuffer()) };
    },
  };
}
