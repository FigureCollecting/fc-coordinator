import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { importOccId, resolveImportOccKey } from './occ.js';

const require = createRequire(import.meta.url);
const vectors = JSON.parse(readFileSync(require.resolve('@figurecollecting/fc-api-contract/golden/key-vectors.json'), 'utf8')) as {
  mfcImportOccTestKey: { hex: string };
  mfcImportOccIds: { userId: string; mfcId: string; ordinal: number; occId: string }[];
};
const TEST_KEY = Buffer.from(vectors.mfcImportOccTestKey.hex, 'hex');

describe('importOccId', () => {
  it('mints every golden occ id from the published test key', () => {
    expect(vectors.mfcImportOccIds.length).toBeGreaterThan(2);
    for (const v of vectors.mfcImportOccIds) expect(importOccId(TEST_KEY, v.userId, v.mfcId, v.ordinal)).toBe(v.occId);
  });

  it('depends on the key', () => {
    const v = vectors.mfcImportOccIds[0]!;
    expect(importOccId(Buffer.alloc(32, 7), v.userId, v.mfcId, v.ordinal)).not.toBe(v.occId);
  });
});

describe('resolveImportOccKey', () => {
  it('is off when IMPORT_OCC_ID_KEY is unset or blank', () => {
    expect(resolveImportOccKey({})).toBeNull();
    expect(resolveImportOccKey({ IMPORT_OCC_ID_KEY: '  ' })).toBeNull();
  });

  it('reads 32 bytes of hex, in either case', () => {
    expect(resolveImportOccKey({ IMPORT_OCC_ID_KEY: vectors.mfcImportOccTestKey.hex })).toEqual(new Uint8Array(TEST_KEY));
    expect(resolveImportOccKey({ IMPORT_OCC_ID_KEY: vectors.mfcImportOccTestKey.hex.toUpperCase() })).toEqual(new Uint8Array(TEST_KEY));
  });

  it('refuses any other value at boot without repeating it', () => {
    for (const bad of ['abc', 'zz'.repeat(32), '00'.repeat(31), '00'.repeat(33), ` ${'00'.repeat(32)}`]) {
      let message = '';
      try {
        resolveImportOccKey({ IMPORT_OCC_ID_KEY: bad });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/IMPORT_OCC_ID_KEY/);
      expect(message).not.toContain(bad.trim());
    }
  });
});
