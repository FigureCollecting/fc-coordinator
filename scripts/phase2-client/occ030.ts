// The sync smoke's keys and payloads, from fc-api-contract 0.3.0 (Ross, GR 2026-09-26: the smoke
// writes occ/{occ}/status with its occ/{occ}/head, never holding/*). The key builder, the parser
// and the two payload schemas are the installed package's; nothing is restated here.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { USER_FACET_PAYLOAD_SCHEMAS, occFacetKey, parseUserFacetKey } from '@figurecollecting/fc-api-contract';

export type OccField = 'head' | 'status';

export type OccPayloadInput =
  | { field: 'status'; status: 'owned' | 'ordered' | 'wished' | 'former'; editedAt: string; tz: string }
  | { field: 'head'; headId: string; editedAt: string; tz: string };

/** occ/{occ}/head and occ/{occ}/status, and nothing else: the two families the smoke writes. */
export function isOccSmokeKey(key: string): boolean {
  const family = parseUserFacetKey(key)?.family;
  return family === 'occ/head' || family === 'occ/status';
}

/** The contract's builder: it folds case and refuses anything that is not a uuid. */
export function occKey(occId: string, field: OccField): string {
  return occFacetKey(occId, field);
}

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ strict: true, allErrors: false });
const schema = (field: OccField): ValidateFunction =>
  ajv.compile(JSON.parse(readFileSync(require.resolve(`@figurecollecting/fc-api-contract/${USER_FACET_PAYLOAD_SCHEMAS[`occ/${field}`]}`), 'utf8')) as object);
const validators: Record<OccField, ValidateFunction> = { head: schema('head'), status: schema('status') };

/** The client checks a payload against its schema before it pushes (sync.proto, PAYLOADS). */
export function assertOccPayload(field: OccField, payload: string): void {
  const validate = validators[field];
  if (!validate(JSON.parse(payload))) {
    const error = validate.errors![0]!;
    throw new Error(`occ/${field} payload: ${error.instancePath || '/'} ${String(error.message)}`);
  }
}

export function occPayload(input: OccPayloadInput): string {
  const body =
    input.field === 'status'
      ? { status: input.status, edited_at: input.editedAt, tz: input.tz }
      : { head_id: input.headId, edited_at: input.editedAt, tz: input.tz };
  const payload = JSON.stringify(body);
  assertOccPayload(input.field, payload);
  return payload;
}
