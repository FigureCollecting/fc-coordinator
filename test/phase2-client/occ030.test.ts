// The sync smoke's keys are contract 0.3.0's (Ross, GR 2026-09-26): occ/{occ}/status with its
// occ/{occ}/head, never holding/*. 0.3.0 is unpublished (fc-api-contract PR #8), so the key shape
// and the two payload schemas are VENDORED from that PR's head, byte for byte, and pinned here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_030_PIN,
  OCC_SMOKE_KEY,
  isOccSmokeKey,
  occKey,
  occPayload,
} from '../../scripts/phase2-client/occ030.js';

const vendored = (rel: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`../../scripts/phase2-client/vendor/fc-api-contract-0.3.0/${rel}`, import.meta.url)));

interface KeyVectors {
  valid: { key: string; parsed: { family: string; occId?: string } }[];
  invalid: { key: string }[];
  build: { input: { family: string; occId?: string }; key: string }[];
  buildRejects: { input: { family: string; occId?: string } }[];
}
const vectors = JSON.parse(vendored('golden/key-vectors.json').toString('utf8')) as KeyVectors;
const SMOKE_FAMILIES = new Set(['occ/head', 'occ/status']);

describe('the vendored 0.3.0 files', () => {
  it('are byte-identical to fc-api-contract PR #8 at its pinned head', () => {
    expect(CONTRACT_030_PIN.commit).toBe('555a1075b5dfbd3b6af52bab8242d4f48cccbdcf');
    expect(CONTRACT_030_PIN.pr).toBe('FigureCollecting/fc-api-contract#8');
    for (const [rel, sha256] of Object.entries(CONTRACT_030_PIN.sha256)) {
      expect(createHash('sha256').update(vendored(rel)).digest('hex'), rel).toBe(sha256);
    }
    expect(Object.keys(CONTRACT_030_PIN.sha256).sort()).toEqual([
      'golden/key-vectors.json',
      'schemas/occ-head.schema.json',
      'schemas/occ-status.schema.json',
    ]);
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
    expect(OCC_SMOKE_KEY.source.startsWith('^occ/')).toBe(true);
  });

  it('builds keys the way the golden build vectors do, folding case, and refuses what they refuse', () => {
    for (const b of vectors.build.filter((v) => SMOKE_FAMILIES.has(v.input.family))) {
      expect(occKey(b.input.occId!, b.input.family.slice(4) as 'head' | 'status')).toBe(b.key);
    }
    for (const b of vectors.buildRejects.filter((v) => SMOKE_FAMILIES.has(v.input.family))) {
      expect(() => occKey(b.input.occId!, b.input.family.slice(4) as 'head' | 'status')).toThrow(/uuid/);
    }
    expect(occKey('6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7', 'head')).toBe('occ/6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7/head');
  });
});

describe('the smoke payloads', () => {
  const display = { editedAt: '2026-10-07T03:15:00.250Z', tz: 'America/Chicago' };

  it('are the closed 0.3.0 shapes, checked against the vendored schemas before they are pushed', () => {
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
  });
});
