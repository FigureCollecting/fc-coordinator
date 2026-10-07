// The sync smoke's keys are contract 0.3.0's (Ross, GR 2026-09-26): occ/{occ}/status with its
// occ/{occ}/head, never holding/*. They and their two payload schemas come from the installed
// package, held here to its golden key vectors.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { assertOccPayload, isOccSmokeKey, occKey, occPayload } from '../../scripts/phase2-client/occ030.js';

const require = createRequire(import.meta.url);
const installed = (rel: string): string => readFileSync(require.resolve(`@figurecollecting/fc-api-contract/${rel}`), 'utf8');

interface KeyVectors {
  valid: { key: string; parsed: { family: string; occId?: string } }[];
  invalid: { key: string }[];
  build: { input: { family: string; occId?: string }; key: string }[];
  buildRejects: { input: { family: string; occId?: string } }[];
}
const vectors = JSON.parse(installed('golden/key-vectors.json')) as KeyVectors;
const SMOKE_FAMILIES = new Set(['occ/head', 'occ/status']);

describe('the installed contract', () => {
  it('is 0.3.x, the release that defines the occurrence keys', () => {
    expect((JSON.parse(installed('package.json')) as { version: string }).version).toMatch(/^0\.3\.\d+$/);
  });
});

describe('the smoke key grammar', () => {
  it('accepts exactly the golden occ/head and occ/status keys among the valid vectors', () => {
    const accepted = vectors.valid.filter((v) => isOccSmokeKey(v.key));
    expect(accepted.map((v) => v.parsed.family).sort()).toEqual(['occ/head', 'occ/status']);
    for (const v of vectors.valid) expect(isOccSmokeKey(v.key), v.key).toBe(SMOKE_FAMILIES.has(v.parsed.family));
  });

  it('refuses every invalid vector, and the retired holding/* keys', () => {
    for (const v of vectors.invalid) expect(isOccSmokeKey(v.key), v.key).toBe(false);
    expect(isOccSmokeKey('holding/6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7/status')).toBe(false);
    expect(isOccSmokeKey('holding/6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7/count')).toBe(false);
    expect(isOccSmokeKey('occ/6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7/origin')).toBe(false);
    expect(isOccSmokeKey('occ/6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7/collection')).toBe(false);
  });

  it('builds keys the way the golden build vectors do, folding case, and refuses what they refuse', () => {
    for (const b of vectors.build.filter((v) => SMOKE_FAMILIES.has(v.input.family))) {
      expect(occKey(b.input.occId!, b.input.family.slice(4) as 'head' | 'status')).toBe(b.key);
    }
    for (const b of vectors.buildRejects.filter((v) => SMOKE_FAMILIES.has(v.input.family))) {
      expect(() => occKey(b.input.occId!, b.input.family.slice(4) as 'head' | 'status')).toThrow(/not an occurrence id/);
    }
    expect(occKey('6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7', 'head')).toBe('occ/6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7/head');
  });
});

describe('the smoke payloads', () => {
  const display = { editedAt: '2026-10-07T03:15:00.250Z', tz: 'America/Chicago' };

  it('are the closed 0.3.0 shapes, checked against the package schemas before they are pushed', () => {
    expect(JSON.parse(occPayload({ field: 'status', status: 'wished', ...display }))).toEqual({
      status: 'wished',
      edited_at: display.editedAt,
      tz: display.tz,
    });
    expect(JSON.parse(occPayload({ field: 'head', headId: '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b', ...display }))).toEqual({
      head_id: '5b0c7c7e-2f1d-4c1e-9a1b-3c4d5e6f7a8b',
      edited_at: display.editedAt,
      tz: display.tz,
    });
  });

  it('refuse what the schemas refuse', () => {
    expect(() => occPayload({ field: 'status', status: 'held' as 'wished', ...display })).toThrow(/occ\/status payload/);
    expect(() => occPayload({ field: 'head', headId: 'NOT-A-UUID', ...display })).toThrow(/occ\/head payload/);
    expect(() => occPayload({ field: 'status', status: 'owned', editedAt: '2026-10-07', tz: 'UTC' })).toThrow(/edited_at/);
    expect(() => assertOccPayload('status', '{"status":"owned"}')).toThrow("occ/status payload: / must have required property 'edited_at'");
  });
});
