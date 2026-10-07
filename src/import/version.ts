// import.proto VERSIONING (0.3.0): every write of one import is versioned
// <instant>#<per-user import counter>#<reserved server device>, the instant being the server's
// clock when the import starts. Which side's change stands is decided by THE SERVER DECIDES, not
// by version, so each write is minted above the facet's current version: a device may hold a
// version up to five minutes past the server's clock (sync.proto rule 5, THE CLOCK).
import { MAX_HLC_COUNTER, SERVER_DEVICE_ID, canonicalVersion, compareVersion, parseVersion } from '@figurecollecting/fc-api-contract';

export function importVersion(instant: string, importNumber: number): string {
  return canonicalVersion({ instant, counter: importNumber, deviceId: SERVER_DEVICE_ID });
}

/** Epoch microseconds as the grammar's instant, "YYYY-MM-DDTHH:MM:SS.ffffffZ". */
function instantOf(micros: bigint): string {
  const iso = new Date(Number(micros / 1000n)).toISOString();
  return `${iso.slice(0, 23)}${(micros % 1000n).toString().padStart(3, '0')}Z`;
}

/** `version`, or when the facet already holds one at or above it, the least one above that. */
export function writeVersion(version: string, current: string | undefined): string {
  if (current === undefined || compareVersion(version, current) > 0) return version;
  const parsed = parseVersion(current)!;
  if (parsed.counter === null) return canonicalVersion({ instant: parsed.instant, counter: 0, deviceId: SERVER_DEVICE_ID });
  if (parsed.counter < MAX_HLC_COUNTER) return canonicalVersion({ instant: parsed.instant, counter: parsed.counter + 1, deviceId: SERVER_DEVICE_ID });
  return canonicalVersion({ instant: instantOf(parsed.micros + 1n), counter: 0, deviceId: SERVER_DEVICE_ID });
}
