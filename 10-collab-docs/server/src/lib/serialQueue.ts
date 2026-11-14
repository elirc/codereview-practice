/** Runs async tasks one at a time in the order they were submitted. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /** Schedules a task after every task submitted before it and returns its result. */
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }

  /** Resolves once every task submitted so far, and any submitted meanwhile, has settled. */
  async drain(): Promise<void> {
    let observed: Promise<unknown>;
    do {
      observed = this.tail;
      await observed;
    } while (observed !== this.tail);
  }
}
