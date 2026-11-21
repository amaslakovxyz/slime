/** Work off the request path (reviews, store writes); flush() waits for all of it (C15). */
export class BackgroundTasks {
  readonly #running = new Set<Promise<void>>();
  readonly #onError: (error: unknown) => void;

  constructor(onError: (error: unknown) => void) {
    this.#onError = onError;
  }

  run(task: () => Promise<void>): void {
    const running: Promise<void> = task()
      .catch(this.#onError)
      .finally(() => this.#running.delete(running));
    this.#running.add(running);
  }

  // A task can start another (an approved review saves the handler), so wait until none is left.
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
  }
}
