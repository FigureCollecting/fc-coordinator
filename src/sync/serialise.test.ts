import { describe, expect, it } from 'vitest';
import { KeyedSerialiser } from './serialise.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function gate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

describe('KeyedSerialiser', () => {
  it('runs the tasks of one key one at a time, in arrival order', async () => {
    const serialiser = new KeyedSerialiser();
    const log: string[] = [];
    const first = gate();
    const a = serialiser.run('u1', async () => {
      log.push('a start');
      await first.wait;
      log.push('a end');
      return 'a';
    });
    const b = serialiser.run('u1', async () => {
      log.push('b');
      return 'b';
    });
    const c = serialiser.run('u1', async () => {
      log.push('c');
      return 'c';
    });
    await tick();
    expect(log).toEqual(['a start']);
    first.open();
    expect(await Promise.all([a, b, c])).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a start', 'a end', 'b', 'c']);
  });

  it('runs different keys side by side', async () => {
    const serialiser = new KeyedSerialiser();
    const held = gate();
    const slow = serialiser.run('u1', () => held.wait);
    let other = false;
    await serialiser.run('u2', async () => {
      other = true;
    });
    expect(other).toBe(true);
    expect(serialiser.activeKeys).toBe(1);
    held.open();
    await slow;
  });

  it('passes a failure to its caller and still runs the next task', async () => {
    const serialiser = new KeyedSerialiser();
    const failed = serialiser.run('u1', async () => {
      throw new Error('boom');
    });
    const next = serialiser.run('u1', async () => 'next');
    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('next');
  });

  it('forgets a key once nothing is running or queued for it', async () => {
    const serialiser = new KeyedSerialiser();
    const held = gate();
    const a = serialiser.run('u1', () => held.wait);
    const b = serialiser.run('u1', async () => undefined);
    expect(serialiser.activeKeys).toBe(1);
    held.open();
    await Promise.all([a, b]);
    expect(serialiser.activeKeys).toBe(0);
  });
});
