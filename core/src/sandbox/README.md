# sandbox

## Overview

The `SandboxRunner` port (`types.ts`) and its one implementation,
`quickjs/`. Core builds its own QuickJS runner unless the host passes one to
`createSlime(config, { runner })` or `crystallize({ runner })`, so that many
engines in one process share one worker pool. `QuickJSRunner` is exported from
the main entry for that.

`quickjs/` runs a handler's generated `function shape(rows, input)` in QuickJS
(WebAssembly) inside worker threads (PLAN.md C3). The code gets rows and
input as JSON only: no database, network, files, timers or host functions.

Files in `quickjs/`:

- `quickjs-runner.ts`: `QuickJSRunner`, the `SandboxRunner` the engine uses.
  It keeps a pool of up to `MAX_WORKERS` (4) workers per runner: per Slime
  instance by default, per process when the host shares one.
- `shape-worker-client.ts`: `ShapeWorker`, one worker thread and its
  deadline.
- `shape-worker.ts`: the code inside the worker.
- `messages.ts`: the messages between the two.

## Interface

- `new QuickJSRunner()`, then `run({ code, rows, input }, { timeoutMs,
  memoryBytes }, stats?)`, which resolves to the function's return value or
  throws `SlimeError('SANDBOX_ERROR')`. `close()` kills every worker.
- `stats` (`SandboxStats`, optional): the runner sets `stats.waitMs` to the
  time it waited for a worker (starting one, or a free one in a busy pool)
  before the code ran. The engine reports it as `timingsMs.sandboxWait` and
  takes it out of `shape`. A host's own runner may leave it at 0.

## Invariants

- **Fresh runtime per call.** Every call is a new QuickJS evaluation, so
  nothing leaks between callers.
- **Two time limits:**
  - QuickJS interrupts the code at `timeoutMs`;
  - the parent kills the worker `KILL_GRACE_MS` (100 ms) later, because a
    single long native call (for example `'x'.repeat(1e8)`) can't be
    interrupted from inside QuickJS. A killed worker is replaced on the next
    call.
- **Memory limits.** QuickJS's memory is capped at `memoryBytes`, and each
  worker's V8 heap at `WORKER_HEAP_MB` (128).
- **Return value.** The function's result must be JSON; returning
  `undefined` is an error.
- **No relative value imports in the worker.** `shape-worker.ts` imports only
  types from this folder, because a worker started from source under tsx
  can't resolve relative `.js` imports.
- **Which worker file loads.** It is chosen from `import.meta.url`:
  `shape-worker.ts` when running from source, `shape-worker.js` in `dist/`.
  The `.js` file is exported as `@slime-cloud/core/shape-worker`, so bundlers
  (the runtime's Lambda build) find it without knowing this folder.

## Side Effects

- Starts worker threads on first use. They are `unref`'d, so they never keep
  the process alive on their own.

## Verification

- `test/sandbox/quickjs.test.ts`: return values, no host access, an infinite loop,
  a stuck native call, recovery after a kill, and a missing return value.
