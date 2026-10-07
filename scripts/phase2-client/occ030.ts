// The sync smoke's keys and payloads, from fc-api-contract 0.3.0 (Ross, GR 2026-09-26: the smoke
// writes occ/{occ}/status with its occ/{occ}/head, never holding/*).
//
// 0.3.0 IS NOT PUBLISHED. It is FigureCollecting/fc-api-contract PR #8, open and green; GitHub
// Packages lists 0.1.0, 0.2.0 and 0.2.1 only (checked 2026-10-07). So the two key forms and their
// payload schemas are VENDORED from that PR's head, byte for byte, under vendor/, and pinned by
// sha256 below; test/phase2-client/occ030.test.ts holds them to the pin and to the golden key
// vectors. When WK-05b moves this repo to ^0.3.0, this file shrinks to imports from the package.
//
// The wire is unchanged from 0.2.1 for what the smoke sends (SyncEvent {facet_key, version, op,
// payload}; buf breaking vs v0.2.1 is clean per PR #8), so the installed 0.2.1 schemas carry it.
import { readFileSync } from 'node:fs';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';

export const CONTRACT_030_PIN = {
  pr: 'FigureCollecting/fc-api-contract#8',
  commit: '555a1075b5dfbd3b6af52bab8242d4f48cccbdcf',
  sha256: {
    'schemas/occ-head.schema.json': 'a389a044572c5b0d0d9bed272318ee09a08f853b76af2c02d692fd4af2cd5bfd',
    'schemas/occ-status.schema.json': '259762fdd23518d7b3b659167bbd778ecb8f462b3698054d9900598942ed19dc',
    'golden/key-vectors.json': 'bf82f7e960094be6fc41a2b9c779dbe504408e9931448f6516f210620174d805',
  } as Record<string, string>,
} as const;

/** sync-vocabulary.ts at the pin: a lowercase dashed uuid, as PostgreSQL renders one. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);

/** occ/{occ}/head and occ/{occ}/status, and nothing else: the two families the smoke writes. */
export const OCC_SMOKE_KEY = new RegExp(`^occ/(?<occ>${UUID})/(?<field>head|status)$`);

export type OccField = 'head' | 'status';

export type OccPayloadInput =
  | { field: 'status'; status: 'owned' | 'ordered' | 'wished' | 'former'; editedAt: string; tz: string }
  | { field: 'head'; headId: string; editedAt: string; tz: string };

export function isOccSmokeKey(key: string): boolean {
  return OCC_SMOKE_KEY.test(key);
}

/** The builder folds case, as the contract's does; anything that is not a uuid is refused. */
export function occKey(occId: string, field: OccField): string {
  const id = occId.toLowerCase();
  if (!UUID_RE.test(id)) throw new Error(`'${occId}' is not a uuid: an occurrence id is one`);
  return `occ/${id}/${field}`;
}

const ajv = new Ajv2020({ strict: true, allErrors: false });
const schema = (field: OccField): ValidateFunction =>
  ajv.compile(JSON.parse(readFileSync(new URL(`./vendor/fc-api-contract-0.3.0/schemas/occ-${field}.schema.json`, import.meta.url), 'utf8')) as object);
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
