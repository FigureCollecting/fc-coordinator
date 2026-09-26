// Per-event validation for Push (sync.proto PUSH_OUTCOME_REJECTED). The grammar, the key
// vocabulary and the payload schemas all come from fc-api-contract; nothing is restated here.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  MAX_FUTURE_SKEW_MS,
  SyncOp,
  USER_FACET_FIELDS,
  USER_FACET_PAYLOAD_SCHEMAS,
  parseUserFacetKey,
  parseVersion,
  type PushRejectReason,
  type SyncEvent,
  type UserFacetField,
} from '@figurecollecting/fc-api-contract';

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ strict: true, allErrors: false });
const validators = new Map<UserFacetField, ValidateFunction>(
  USER_FACET_FIELDS.map((field) => {
    const file = require.resolve(`@figurecollecting/fc-api-contract/${USER_FACET_PAYLOAD_SCHEMAS[field]}`);
    return [field, ajv.compile(JSON.parse(readFileSync(file, 'utf8')) as object)];
  }),
);

const SKEW_MICROS = BigInt(MAX_FUTURE_SKEW_MS) * 1000n;

export interface EventContext {
  /** The caller's DPoP-bound device, as the grammar spells it (32 lowercase hex). */
  deviceHex: string;
  /** The server clock, in epoch microseconds. */
  nowMicros: bigint;
}

export type Verdict =
  | { ok: true }
  /** userOwned: the key is one of the four user-owned forms, so `current` may be returned. */
  | { ok: false; reason: string; userOwned: boolean };

const reject = (code: PushRejectReason, detail: string, userOwned = true): Verdict => ({
  ok: false,
  reason: `${code}: ${detail}`,
  userOwned,
});

export function validateEvent(event: Pick<SyncEvent, 'facetKey' | 'version' | 'op' | 'payload'>, ctx: EventContext): Verdict {
  const key = parseUserFacetKey(event.facetKey);
  if (key === undefined) return reject('facet_key_not_user_owned', 'not one of the four user-owned key forms', false);

  const version = parseVersion(event.version);
  if (version === undefined || version.counter === null) {
    return reject('version_malformed', 'a user-owned facet needs <instant>#<counter>#<device>');
  }
  if (version.deviceId !== ctx.deviceHex) return reject('device_mismatch', 'the version names another device');
  if (version.micros > ctx.nowMicros + SKEW_MICROS) {
    return reject('version_future', `later than server_now + ${MAX_FUTURE_SKEW_MS / 1000}s`);
  }

  if (event.op === SyncOp.DELETE) {
    return event.payload === '' ? { ok: true } : reject('payload_invalid', 'a DELETE carries no payload');
  }
  if (event.op !== SyncOp.UPSERT) return reject('payload_invalid', 'unknown op');
  if (event.payload === '') return reject('payload_invalid', 'an UPSERT needs a payload');

  let value: unknown;
  try {
    value = JSON.parse(event.payload);
  } catch {
    return reject('payload_invalid', 'not JSON');
  }
  const validate = validators.get(key.field)!;
  if (!validate(value)) {
    const error = validate.errors![0]!;
    return reject('payload_invalid', `${error.instancePath || '/'} ${error.message}`);
  }
  return { ok: true };
}
