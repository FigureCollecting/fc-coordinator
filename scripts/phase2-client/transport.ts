// WK-11 skeleton: the behaviour lands in the next commit.
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
  readonly count: number;
}
export function createFetchTransport(_options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Transport {
  throw new Error('not implemented: WK-11');
}
