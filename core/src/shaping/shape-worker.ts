// Runs in a worker thread so the parent can kill it: QuickJS's own interrupt
// can't stop a long native call such as 'x'.repeat(1e8).
import { parentPort } from 'node:worker_threads';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
// Type-only imports: a worker started from source under tsx can't resolve
// relative .js imports, so this file imports no values of its own.
import type { ReadyMessage, ShapeReply, ShapeTask } from './messages.js';

const READY_MESSAGE: ReadyMessage = 'ready';

if (!parentPort) throw new Error('shape-worker must run in a worker thread');
const port = parentPort;
const quickJS = await getQuickJS();

port.on('message', (task: ShapeTask) => port.postMessage(evaluate(task)));
port.postMessage(READY_MESSAGE);

function evaluate({ id, program, timeoutMs, memoryBytes }: ShapeTask): ShapeReply {
  try {
    const result = quickJS.evalCode(program, {
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + timeoutMs),
      memoryLimitBytes: memoryBytes,
    });
    return { id, isOk: true, result };
  } catch (error) {
    return { id, isOk: false, errorName: errorField(error, 'name') ?? 'Error', errorMessage: errorField(error, 'message') ?? String(error) };
  }
}

// QuickJS throws plain objects with name and message, not Error instances.
function errorField(error: unknown, field: 'name' | 'message'): string | undefined {
  const value = error && typeof error === 'object' ? (error as Record<string, unknown>)[field] : undefined;
  return typeof value === 'string' ? value : undefined;
}
