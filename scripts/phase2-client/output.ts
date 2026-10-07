// WK-11 skeleton: the behaviour lands in the next commit.
export const REDACTED = '[redacted]';
export const MIN_SECRET_LENGTH = 8;
export interface Sink {
  write(chunk: string): unknown;
}
export interface SafeOutput {
  out(line: string): void;
  err(line: string): void;
  secret(value: string | undefined): void;
  readonly redactions: number;
}
export function createSafeOutput(_stdout: Sink, _stderr: Sink): SafeOutput {
  throw new Error('not implemented: WK-11');
}
