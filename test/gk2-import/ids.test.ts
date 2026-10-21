import { describe, expect, it } from 'vitest';
import { uuidV5 } from '../../scripts/gk2-import/ids.js';

const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const NS = '7d0c1d9e-5a43-4c52-9d4f-6f2a4b8f1c07';

describe('uuidV5', () => {
  it('matches the RFC 9562 vector: the DNS namespace and python.org', () => {
    expect(uuidV5(DNS, 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('is the same for the same namespace and name, and differs when either changes', () => {
    const id = uuidV5(NS, 'gk2:occ:owned-3:1');
    expect(uuidV5(NS, 'gk2:occ:owned-3:1')).toBe(id);
    expect(uuidV5(NS, 'gk2:occ:owned-3:2')).not.toBe(id);
    expect(uuidV5(DNS, 'gk2:occ:owned-3:1')).not.toBe(id);
  });

  it('writes a lowercase dashed version-5 variant-1 uuid, the spelling every facet key needs', () => {
    expect(uuidV5(NS, 'x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('refuses a namespace that is not a uuid', () => {
    expect(() => uuidV5('not-a-uuid', 'x')).toThrow(TypeError);
    expect(() => uuidV5(DNS.toUpperCase(), 'x')).toThrow(TypeError);
  });
});
