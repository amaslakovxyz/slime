import { Worker } from 'node:worker_threads';
import { SlimeError } from '../../shared/errors.js';
import { READY_MESSAGE, type ShapeReply, type ShapeTask } from './messages.js';

const WORKER_HEAP_MB = 128;
// Past the QuickJS deadline the worker is stuck in a native call, so it is killed.
const KILL_GRACE_MS = 100;
// From source (tests run through tsx) the worker is .ts; the built package ships .js.
const WORKER_FILE = new URL(import.meta.url.endsWith('.ts') ? './shape-worker.ts' : './shape-worker.js', import.meta.url);

export function shapeTimeout(timeoutMs: number): SlimeError {
  return new SlimeError('SANDBOX_ERROR', `Shaping function ran longer than ${timeoutMs} ms.`);
}

export class ShapeWorker {
  readonly ready: Promise<void>;
  isBusy = false;
  isDead = false;
  readonly #worker: Worker;

  constructor() {
    this.#worker = new Worker(WORKER_FILE, { resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB } });
    this.#worker.unref();
    this.#worker.on('exit', () => {
      this.isDead = true;
    });
    this.ready = new Promise((resolve, reject) => {
      this.#worker.once('message', (message) => (message === READY_MESSAGE ? resolve() : reject(new Error('shape worker did not start'))));
      this.#worker.once('error', reject);
    });
  }

  run(task: ShapeTask): Promise<ShapeReply> {
    return new Promise((resolve, reject) => {
      const killTimer = setTimeout(() => {
        this.kill();
        reject(shapeTimeout(task.timeoutMs));
      }, task.timeoutMs + KILL_GRACE_MS);
      const onReply = (reply: ShapeReply): void => {
        if (reply.id !== task.id) return;
        clearTimeout(killTimer);
        this.#worker.off('message', onReply);
        resolve(reply);
      };
      this.#worker.on('message', onReply);
      this.#worker.postMessage(task);
    });
  }

  kill(): void {
    this.isDead = true;
    void this.#worker.terminate();
  }
}
