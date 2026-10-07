// WK-11 skeleton: the behaviour lands in the next commit.
export const CONTRACT_030_PIN = { pr: '', commit: '', sha256: {} as Record<string, string> };
export const OCC_SMOKE_KEY = /$^/;
export type OccField = 'head' | 'status';
export type OccPayloadInput =
  | { field: 'status'; status: 'owned' | 'ordered' | 'wished' | 'former'; editedAt: string; tz: string }
  | { field: 'head'; headId: string; editedAt: string; tz: string };
export function isOccSmokeKey(_key: string): boolean {
  throw new Error('not implemented: WK-11');
}
export function occKey(_occId: string, _field: OccField): string {
  throw new Error('not implemented: WK-11');
}
export function assertOccPayload(_field: OccField, _payload: string): void {
  throw new Error('not implemented: WK-11');
}
export function occPayload(_input: OccPayloadInput): string {
  throw new Error('not implemented: WK-11');
}
