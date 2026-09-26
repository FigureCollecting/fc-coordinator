// One task at a time per key, in arrival order, within this process. Push queues here per user
// before it takes a pooled connection, so a user whose writes wait on its advisory lock holds at
// most one connection per replica and cannot starve other users of the pool.

/** A key already has `limit` tasks running or waiting. */
export class QueueFull extends Error {
  override readonly name = 'QueueFull';

  constructor(readonly limit: number) {
    super(`at most ${limit} tasks may run or wait for one key`);
  }
}

interface Queue {
  tail: Promise<void>;
  depth: number;
}

/** Resolve at `previous`, or reject with the signal's reason if it aborts first. */
function turn(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) return previous;
  return new Promise((resolve, reject) => {
    const leave = () => reject(signal.reason);
    signal.addEventListener('abort', leave, { once: true });
    void previous.then(() => {
      signal.removeEventListener('abort', leave);
      resolve();
    });
  });
}

export class KeyedSerialiser {
  private readonly queues = new Map<string, Queue>();

  /** `limit` bounds the tasks one key may have running or waiting. */
  constructor(readonly limit = Number.POSITIVE_INFINITY) {}

  /** Keys with a task running or queued; an idle key is forgotten, so nothing grows per user. */
  get activeKeys(): number {
    return this.queues.size;
  }

  /** Tasks running or waiting for `key`. */
  depth(key: string): number {
    return this.queues.get(key)?.depth ?? 0;
  }

  /**
   * Run `task` after every earlier task for `key`. A task whose signal aborts while it waits is
   * dropped and frees its place; one already running is left to finish.
   */
  async run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let queue = this.queues.get(key);
    if (queue === undefined) {
      queue = { tail: Promise.resolve(), depth: 0 };
      this.queues.set(key, queue);
    }
    if (queue.depth >= this.limit) throw new QueueFull(this.limit);

    const previous = queue.tail;
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The next task waits for `previous` as well as this one, so a dropped task releases early.
    queue.tail = previous.then(() => done);
    queue.depth += 1;
    const leave = (): void => {
      release();
      queue.depth -= 1;
      if (queue.depth === 0) this.queues.delete(key);
    };

    try {
      await turn(previous, signal);
    } catch (reason) {
      leave();
      throw reason;
    }
    try {
      return await task();
    } finally {
      leave();
    }
  }
}
