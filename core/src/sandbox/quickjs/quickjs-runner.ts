// Generated shaping code runs in QuickJS (WebAssembly) in a worker thread. It
// gets rows and input as JSON only: no database, network, files or timers.
import { SlimeError } from '../../shared/errors.js';
import type { SandboxLimits, SandboxRunner, SandboxStats, ShapeJob } from '../types.js';
import { INTERRUPTED_MESSAGE, type ShapeReply } from './messages.js';
import { ShapeWorker, shapeTimeout } from './shape-worker-client.js';

const MAX_WORKERS = 4;

/** One pool per Slime instance; close() kills its workers. */
export class QuickJSRunner implements SandboxRunner {
  readonly #workers: ShapeWorker[] = [];
  readonly #waiting: ((worker: ShapeWorker) => void)[] = [];
  #nextTaskId = 1;

  async run(job: ShapeJob, { timeoutMs, memoryBytes }: SandboxLimits, stats?: SandboxStats): Promise<unknown> {
    const waitStartedAt = performance.now();
    const worker = await this.#acquire();
    let reply: ShapeReply;
    try {
      await worker.ready;
      if (stats) stats.waitMs = performance.now() - waitStartedAt;
      reply = await worker.run({ id: this.#nextTaskId++, program: toProgram(job), timeoutMs, memoryBytes });
    } finally {
      this.#release(worker);
    }
    return resultOf(reply, timeoutMs);
  }

  async close(): Promise<void> {
    for (const worker of this.#workers) worker.kill();
    this.#workers.length = 0;
  }

  async #acquire(): Promise<ShapeWorker> {
    this.#removeDeadWorkers();
    const idleWorker = this.#workers.find((worker) => !worker.isBusy);
    if (idleWorker) {
      idleWorker.isBusy = true;
      return idleWorker;
    }
    if (this.#workers.length < MAX_WORKERS) return this.#startWorker();
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release(worker: ShapeWorker): void {
    const nextInLine = this.#waiting.shift();
    if (worker.isDead) {
      this.#removeDeadWorkers();
      if (nextInLine) nextInLine(this.#startWorker());
    } else if (nextInLine) {
      nextInLine(worker);
    } else {
      worker.isBusy = false;
    }
  }

  #startWorker(): ShapeWorker {
    const worker = new ShapeWorker();
    worker.isBusy = true;
    this.#workers.push(worker);
    return worker;
  }

  #removeDeadWorkers(): void {
    const alive = this.#workers.filter((worker) => !worker.isDead);
    this.#workers.splice(0, this.#workers.length, ...alive);
  }
}

// JSON is valid JavaScript expression syntax, so rows and input are embedded as literals.
function toProgram({ code, rows, input }: ShapeJob): string {
  return `${code}\n;JSON.stringify(shape(${JSON.stringify(rows)}, ${JSON.stringify(input)}));`;
}

function resultOf(reply: ShapeReply, timeoutMs: number): unknown {
  if (!reply.isOk) {
    if (reply.errorMessage === INTERRUPTED_MESSAGE) throw shapeTimeout(timeoutMs);
    throw new SlimeError('SANDBOX_ERROR', `Shaping function threw: ${reply.errorName}: ${reply.errorMessage}`);
  }
  if (typeof reply.result !== 'string') {
    throw new SlimeError('SANDBOX_ERROR', 'Shaping function returned nothing (did it return undefined?).');
  }
  return JSON.parse(reply.result);
}
