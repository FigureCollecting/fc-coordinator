// Per-event validation for Push (sync.proto PUSH_OUTCOME_REJECTED). The grammar, the key
// vocabulary and the payload schemas all come from fc-api-contract; nothing is restated here.
// 0.3.0 (rule 6): the schema is picked by the parsed key's family; a server-owned key (a copy's
// origin, the import's imp/*) and a retired 0.2.x holding/* key do not parse as user-owned.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import {
  MAX_FUTURE_SKEW_MS,
  MAX_PAYLOAD_BYTES,
  SyncOp,
  USER_FACET_FAMILIES,
  USER_FACET_PAYLOAD_SCHEMAS,
  parseUserFacetKey,
  parseVersion,
  type PushRejectReason,
  type SyncEvent,
  type UserFacetFamily,
} from '@figurecollecting/fc-api-contract';

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ strict: true, allErrors: false });
const validators = new Map<UserFacetFamily, ValidateFunction>(
  USER_FACET_FAMILIES.map((family) => {
    const file = require.resolve(`@figurecollecting/fc-api-contract/${USER_FACET_PAYLOAD_SCHEMAS[family]}`);
    return [family, ajv.compile(JSON.parse(readFileSync(file, 'utf8')) as object)];
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
  /** userOwned: the key is one of rule 6's user-owned forms, so `current` may be returned. */
  | { ok: false; reason: string; userOwned: boolean };

const reject = (code: PushRejectReason, detail: string, userOwned = true): Verdict => ({
  ok: false,
  reason: `${code}: ${detail}`,
  userOwned,
});

// sync.proto: the REJECTED checks run in the listed order, all before STALE, REVIEW or APPLIED
// routing, so a past-bound event is version_future whatever its key, device or stored version.
export function validateEvent(event: Pick<SyncEvent, 'facetKey' | 'version' | 'op' | 'payload'>, ctx: EventContext): Verdict {
  const key = parseUserFacetKey(event.facetKey);
  const userOwned = key !== undefined;

  const version = parseVersion(event.version);
  if (version === undefined || (userOwned && version.counter === null)) {
    return reject('version_malformed', 'not the grammar; a user-owned facet needs <instant>#<counter>#<device>', userOwned);
  }
  if (version.micros > ctx.nowMicros + SKEW_MICROS) {
    return reject('version_future', `later than server_now + ${MAX_FUTURE_SKEW_MS / 1000}s`, userOwned);
  }
  if (!userOwned) return reject('facet_key_not_user_owned', "not one of rule 6's user-owned key forms", false);
  if (version.deviceId !== ctx.deviceHex) return reject('device_mismatch', 'the version names another device');

  // Bounds what is parsed below; the cap is on UTF-8 bytes, not UTF-16 units.
  if (Buffer.byteLength(event.payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    return reject('payload_invalid', `payload over ${MAX_PAYLOAD_BYTES} bytes`);
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
  const validate = validators.get(key.family)!;
  if (!validate(value)) {
    const error = validate.errors![0]!;
    return reject('payload_invalid', `${error.instancePath || '/'} ${error.message}`);
  }
  return { ok: true };
}
