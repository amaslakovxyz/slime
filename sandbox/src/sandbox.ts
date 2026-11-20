// Runs the generated shaping function in QuickJS (WebAssembly) inside a worker thread.
// The function gets only rows and input as JSON: no database, network, files,
// timers or host functions. Each call is a fresh QuickJS runtime, so nothing
// leaks between callers. Limits:
//  - QuickJS interrupt after SHAPE_TIMEOUT_MS and a QuickJS memory cap;
//  - a hard wall-clock kill of the worker, because a single long native call
//    (e.g. a huge String.repeat) can't be interrupted from inside QuickJS.
import { Worker } from 'node:worker_threads';
import { config } from './config.js';
import { SlimeError } from './errors.js';

const MAX_WORKERS = 4;
const KILL_GRACE_MS = 100;

interface Reply {
  id: number;
  ok: boolean;
  result?: unknown;
  name?: string;
  message?: string;
  ms: number;
}

class ShapeWorker {
  readonly ready: Promise<void>;
  busy = false;
  dead = false;
  private worker: Worker;

  constructor() {
    this.worker = new Worker(new URL('./shape-worker.mjs', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    this.worker.unref(); // never keep the process alive on its own
    this.ready = new Promise((resolve, reject) => {
      this.worker.once('message', () => resolve());
      this.worker.once('error', reject);
    });
    this.worker.on('exit', () => (this.dead = true));
  }

  run(id: number, code: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dead = true;
        void this.worker.terminate();
        reject(new SlimeError('SANDBOX_ERROR', `Shaping function ran longer than ${config.shapeTimeoutMs} ms (worker killed).`));
      }, config.shapeTimeoutMs + KILL_GRACE_MS);
      const onMessage = (reply: Reply) => {
        if (reply.id !== id) return;
        clearTimeout(timer);
        this.worker.off('message', onMessage);
        resolve(reply);
      };
      this.worker.on('message', onMessage);
      this.worker.postMessage({ id, code, timeoutMs: config.shapeTimeoutMs, memoryBytes: config.shapeMemoryBytes });
    });
  }
}

const pool: ShapeWorker[] = [];
const waiting: ((w: ShapeWorker) => void)[] = [];
let nextId = 1;

export async function warmSandbox(): Promise<void> {
  if (!pool.length) pool.push(new ShapeWorker());
  await pool[0].ready;
}

async function acquire(): Promise<ShapeWorker> {
  for (let i = pool.length - 1; i >= 0; i--) if (pool[i].dead) pool.splice(i, 1);
  const idle = pool.find((w) => !w.busy);
  if (idle) {
    idle.busy = true;
    return idle;
  }
  if (pool.length < MAX_WORKERS) {
    const w = new ShapeWorker();
    w.busy = true;
    pool.push(w);
    return w;
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(w: ShapeWorker) {
  if (w.dead) {
    const i = pool.indexOf(w);
    if (i >= 0) pool.splice(i, 1);
    const next = waiting.shift();
    if (next) {
      const fresh = new ShapeWorker();
      fresh.busy = true;
      pool.push(fresh);
      next(fresh);
    }
    return;
  }
  const next = waiting.shift();
  if (next) next(w);
  else w.busy = false;
}

export async function runShape(
  shapeJs: string,
  rows: unknown[],
  input: Record<string, unknown>,
): Promise<{ data: unknown; ms: number }> {
  // Rows and input are embedded as JSON literals; JSON is valid JS expression syntax.
  const code = `${shapeJs}\n;JSON.stringify(shape(${JSON.stringify(rows)}, ${JSON.stringify(input)}));`;
  const started = performance.now();
  const worker = await acquire();
  let reply: Reply;
  try {
    await worker.ready;
    reply = await worker.run(nextId++, code);
  } finally {
    release(worker);
  }
  if (!reply.ok) {
    if (reply.message === 'interrupted') {
      throw new SlimeError('SANDBOX_ERROR', `Shaping function ran longer than ${config.shapeTimeoutMs} ms.`);
    }
    throw new SlimeError('SANDBOX_ERROR', `Shaping function threw: ${reply.name}: ${reply.message}`);
  }
  if (typeof reply.result !== 'string') {
    throw new SlimeError('SANDBOX_ERROR', 'Shaping function returned nothing (did it return undefined?).');
  }
  return { data: JSON.parse(reply.result), ms: performance.now() - started };
}
