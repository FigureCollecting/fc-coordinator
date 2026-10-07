// import.proto OCCURRENCE IDS: a copy the import creates at ordinal k of MFC row `mfcId` is
// importOccIdFromMac(HMAC-SHA256(key, "{user_id}:mfc:{mfc_id}:{k}")). The key is the
// coordinator's alone: it is read once from the environment and never logged or sent.
import { createHmac } from 'node:crypto';
import { importOccIdFromMac, mfcImportOccName } from '@figurecollecting/fc-api-contract';

export function importOccId(key: Uint8Array, userId: string, mfcId: string, ordinal: number): string {
  return importOccIdFromMac(createHmac('sha256', key).update(mfcImportOccName(userId, mfcId, ordinal)).digest());
}

const KEY_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * IMPORT_OCC_ID_KEY: 32 bytes as 64 hex digits. Unset or blank -> null, and the import answers
 * UNAVAILABLE. Anything else refuses the process start, without repeating the value.
 */
export function resolveImportOccKey(env: NodeJS.ProcessEnv = process.env): Uint8Array | null {
  const raw = env['IMPORT_OCC_ID_KEY'] ?? '';
  if (raw.trim() === '') return null;
  if (!KEY_HEX.test(raw)) throw new Error('IMPORT_OCC_ID_KEY must be 64 hex digits (32 bytes), with nothing around them');
  return new Uint8Array(Buffer.from(raw, 'hex'));
}
