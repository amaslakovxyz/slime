export interface CoalescedWork<T> {
  promise: Promise<T>;
  /** Another caller started this work; this one only waits for it. */
  isShared: boolean;
}

/** Concurrent calls with the same key share one run of the work, and its error. */
export class Coalescer<T> {
  readonly #inFlight = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): CoalescedWork<T> {
    const running = this.#inFlight.get(key);
    if (running) return { promise: running, isShared: true };

    const promise = work().finally(() => this.#inFlight.delete(key));
    // Followers still see the error; this only stops a failure nobody else awaits
    // from becoming an unhandled rejection, which would end the process.
    promise.catch(() => {});
    this.#inFlight.set(key, promise);
    return { promise, isShared: false };
  }
}
