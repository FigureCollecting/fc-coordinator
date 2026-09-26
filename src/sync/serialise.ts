// One task at a time per key, in arrival order, within this process. Push queues here per user
// before it takes a pooled connection, so a user whose writes wait on its advisory lock holds at
// most one connection per replica and cannot starve other users of the pool.
export class KeyedSerialiser {
  private readonly tails = new Map<string, Promise<void>>();

  /** Keys with a task running or queued; an idle key is forgotten, so nothing grows per user. */
  get activeKeys(): number {
    return this.tails.size;
  }

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => done);
    this.tails.set(key, tail);
    try {
      await previous;
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
