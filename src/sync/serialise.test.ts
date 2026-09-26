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

describe('KeyedSerialiser with a bound and a client that goes away', () => {
  it('refuses a task past the bound for its key, running or waiting, and takes other keys', async () => {
    const serialiser = new KeyedSerialiser(2);
    const held = gate();
    const a = serialiser.run('u1', () => held.wait);
    const b = serialiser.run('u1', async () => 'b');
    await expect(serialiser.run('u1', async () => 'c')).rejects.toMatchObject({ name: 'QueueFull' });
    expect(serialiser.depth('u1')).toBe(2);
    expect(await serialiser.run('u2', async () => 'other')).toBe('other');
    held.open();
    await a;
    expect(await b).toBe('b');
    expect(await serialiser.run('u1', async () => 'after')).toBe('after');
  });

  it('drops a waiting task whose signal aborts: it never runs, frees its place, and the next still waits its turn', async () => {
    const serialiser = new KeyedSerialiser(2);
    const log: string[] = [];
    const held = gate();
    const a = serialiser.run('u1', async () => {
      await held.wait;
      log.push('a');
    });
    const leaving = new AbortController();
    const dropped = serialiser.run('u1', async () => log.push('dropped'), leaving.signal);
    expect(serialiser.depth('u1')).toBe(2);

    leaving.abort(new Error('client went away'));
    await expect(dropped).rejects.toThrow('client went away');
    expect(serialiser.depth('u1')).toBe(1);

    const next = serialiser.run('u1', async () => log.push('next'));
    await tick();
    expect(log).toEqual([]);
    held.open();
    await Promise.all([a, next]);
    expect(log).toEqual(['a', 'next']);
    expect(serialiser.activeKeys).toBe(0);
  });

  it('refuses a task whose signal has already aborted without queueing it', async () => {
    const serialiser = new KeyedSerialiser();
    const gone = AbortSignal.abort(new Error('already gone'));
    let ran = false;
    await expect(
      serialiser.run('u1', async () => {
        ran = true;
      }, gone),
    ).rejects.toThrow('already gone');
    expect(ran).toBe(false);
    expect(serialiser.depth('u1')).toBe(0);
  });

  it('lets a running task finish when its signal aborts', async () => {
    const serialiser = new KeyedSerialiser();
    const leaving = new AbortController();
    const held = gate();
    const running = serialiser.run('u1', async () => {
      await held.wait;
      return 'committed';
    }, leaving.signal);
    await tick();
    leaving.abort();
    held.open();
    expect(await running).toBe('committed');
    expect(serialiser.depth('u1')).toBe(0);
  });
});
