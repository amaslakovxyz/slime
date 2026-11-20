// Worker thread that evaluates shaping code in QuickJS. Plain JS (not TS) so it
// loads in a worker without a TypeScript loader. The parent kills this worker if
// it overruns its deadline: QuickJS's own interrupt can't stop a long native call
// such as 'x'.repeat(1e8), which would otherwise block the server.
import { parentPort } from 'node:worker_threads';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';

const qjs = await getQuickJS();
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', ({ id, code, timeoutMs, memoryBytes }) => {
  const started = performance.now();
  try {
    const result = qjs.evalCode(code, {
      shouldInterrupt: shouldInterruptAfterDeadline(Date.now() + timeoutMs),
      memoryLimitBytes: memoryBytes,
    });
    parentPort.postMessage({ id, ok: true, result, ms: performance.now() - started });
  } catch (err) {
    parentPort.postMessage({
      id,
      ok: false,
      name: err?.name ?? 'Error',
      message: err?.message ?? String(err),
      ms: performance.now() - started,
    });
  }
});
