import { describe, expect, it } from 'vitest';
import { createJtiWindow } from './replay.js';

describe('createJtiWindow', () => {
  it('accepts a jti once and rejects the second presentation', () => {
    const window = createJtiWindow({ ttlMs: 60_000, maxEntries: 10 });
    expect(window.check('a')).toBe('fresh');
    expect(window.check('a')).toBe('replay');
    expect(window.size).toBe(1);
  });

  it('keeps distinct jtis apart', () => {
    const window = createJtiWindow({ ttlMs: 60_000, maxEntries: 10 });
    expect(window.check('a')).toBe('fresh');
    expect(window.check('b')).toBe('fresh');
    expect(window.size).toBe(2);
  });

  it('forgets an entry once it is older than the ttl', () => {
    const now = { value: 0 };
    const window = createJtiWindow({ ttlMs: 1_000, maxEntries: 10, now: () => now.value });
    expect(window.check('a')).toBe('fresh');
    now.value = 1_001;
    expect(window.check('a')).toBe('fresh');
    expect(window.size).toBe(1);
  });

  it('still rejects a replay at the very edge of the ttl', () => {
    const now = { value: 0 };
    const window = createJtiWindow({ ttlMs: 1_000, maxEntries: 10, now: () => now.value });
    window.check('a');
    now.value = 1_000;
    expect(window.check('a')).toBe('replay');
  });

  it('evicts the OLDEST entry when the cap is reached, never a recent one', () => {
    const now = { value: 0 };
    const window = createJtiWindow({ ttlMs: 60_000, maxEntries: 2, now: () => now.value });
    window.check('oldest');
    now.value += 1;
    window.check('middle');
    now.value += 1;
    window.check('newest');

    expect(window.size).toBe(2);
    expect(window.check('middle')).toBe('replay');
    expect(window.check('newest')).toBe('replay');
  });

  it('prunes expired entries without being asked, so the map cannot grow unbounded', () => {
    const now = { value: 0 };
    const window = createJtiWindow({ ttlMs: 1_000, maxEntries: 1_000, now: () => now.value });
    for (let i = 0; i < 50; i += 1) window.check(`old-${i}`);
    expect(window.size).toBe(50);
    now.value = 5_000;
    window.check('new');
    expect(window.size).toBe(1);
  });

  it('starts empty — the property the restart test asserts against', () => {
    expect(createJtiWindow({ ttlMs: 1_000, maxEntries: 10 }).size).toBe(0);
  });

  it('rejects a non-positive ttl or cap', () => {
    expect(() => createJtiWindow({ ttlMs: 0, maxEntries: 10 })).toThrow(/ttlMs/);
    expect(() => createJtiWindow({ ttlMs: 10, maxEntries: 0 })).toThrow(/maxEntries/);
  });
});
