# Request trace drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the admin Requests log, a click on a request opens a drawer that shows which harness layers the request passed, where it was stopped and why, and the route it took — measured by the engine.

**Architecture:** core records a `Trace` of layer spans while it answers (`QueryMeta.trace`, or `SlimeError.trace` on failure). The runtime feed stores the trace, refused requests, intent, input names and — for generations only — the generated code; a new route serves a hit's code. The admin turns one feed event into 12 layer rows (pure, tested) and renders them as Layers, Route map and Waterfall in a non-modal drawer.

**Tech Stack:** TypeScript, Node ≥ 22 `node:test` + `tsx`, Hono (runtime), Next.js App Router + React (admin).

Spec: [2026-11-22-request-trace-drawer-design.md](2026-11-22-request-trace-drawer-design.md). Visual reference: [mockups/2026-11-22-request-trace-drawer.html](mockups/2026-11-22-request-trace-drawer.html).

## Global Constraints

- Layer ids and order, exactly: `edge`, `key`, `route`, `limits`, `generate`, `lint`, `cost`, `execute`, `shape`, `output`, `cache`, `review`.
- Layer statuses in core: `pass` | `skip` | `stop` | `pending`. The admin adds `unreached` and `unknown`.
- Never store or show input **values** or result rows anywhere in a trace, note or feed event. Input **names** are allowed. Stop notes use `repairMessage(error)` (value-free).
- The trace travels on `SlimeError.trace` and `SlimeError.handlerKey` — never inside `details` (`toJSON()` must stay byte-for-byte unchanged).
- A span note is at most 200 characters; span `ms` is rounded to 2 decimals.
- `RequestEvent` changes are additive and optional; events written before this change still list and render.
- The feed never fails a request; tracing never replaces the engine's own error (code, status, message, `retryable`, `details` stay the same).
- Generated code (`sql`, `shapeJs`, `assumptions`) is stored in the feed only on events with `cache: 'miss'`.
- Intent stored in the feed: first 200 characters. Input names: sorted.
- Requests rejected before the route (auth) are not recorded. A body over 16 KB is recorded with `stopAt: 'edge'`; invalid JSON with `stopAt: 'key'`.
- Import direction in core (`core/test/architecture.test.ts`): `shared` imports nothing; `engine` may import `shared`.
- Repo rules: work only in this worktree on `feat/request-trace-drawer`; pre-commit hooks must pass, never `--no-verify`; one concern per commit; English code, comments and commit messages.
- Package commands: core `npm test -w @slime-cloud/core` and `npm run typecheck -w @slime-cloud/core` (repo root); runtime `cd platform/runtime && npm test && npm run typecheck`; admin `cd platform/admin && npm test && npm run typecheck`. The runtime uses core through `file:../../core` — run `npm run build -w @slime-cloud/core` (repo root) after a core change before runtime tests.

---

### Task 1: core trace types and recorder

**Files:**
- Create: `core/src/shared/trace.ts`
- Create: `core/src/engine/trace.ts`
- Modify: `core/src/shared/errors.ts` (add two fields to `SlimeError`)
- Modify: `core/src/index.ts` (export the types and `LAYER_IDS`)
- Test: `core/test/engine/trace.test.ts`

**Interfaces:**
- Produces (shared): `LAYER_IDS`, `type LayerId`, `type LayerStatus`, `interface LayerSpan`, `layerOfError(error: SlimeError): LayerId`.
- Produces (engine): `class Trace { spans; add(layer, status, extra?); time(layer, work, opts?); addExecution(execution, attempt?); fail(error, attempt?); attach(error, handlerKey?): unknown }`.
- Produces (errors): `SlimeError.trace?: LayerSpan[]`, `SlimeError.handlerKey?: string`.

- [ ] **Step 1: Write the failing test** — `core/test/engine/trace.test.ts`

```ts
// The per-request trace: spans per layer, value-free stop notes, and errors that carry it (design T1–T4).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeError } from '../../src/shared/errors.js';
import { LAYER_IDS, layerOfError } from '../../src/shared/trace.js';
import { Trace } from '../../src/engine/trace.js';

describe('layerOfError', () => {
  const cases: [SlimeError, string][] = [
    [new SlimeError('INVALID_REQUEST', 'x'), 'key'],
    [new SlimeError('GENERATION_RATE_LIMITED', 'x'), 'limits'],
    [new SlimeError('GENERATION_FAILED', 'x'), 'generate'],
    [new SlimeError('GENERATION_TIMEOUT', 'x'), 'generate'],
    [new SlimeError('INTENT_UNSATISFIABLE', 'x'), 'generate'],
    [new SlimeError('WRITE_REFUSED', 'x', { details: { enforcedBy: 'model' } }), 'generate'],
    [new SlimeError('WRITE_REFUSED', 'x', { details: { enforcedBy: 'lint' } }), 'lint'],
    [new SlimeError('WRITE_REFUSED', 'x', { details: { enforcedBy: 'database' } }), 'execute'],
    [new SlimeError('INVALID_HANDLER', 'Step "a" calls x'), 'lint'],
    [new SlimeError('INVALID_HANDLER', 'The handler returned 9 rows, but input.limit is 5.'), 'output'],
    [new SlimeError('QUERY_TOO_LARGE', 'x'), 'cost'],
    [new SlimeError('QUERY_TOO_EXPENSIVE', 'x'), 'cost'],
    [new SlimeError('QUERY_ERROR', 'x'), 'execute'],
    [new SlimeError('EXECUTION_TIMEOUT', 'x'), 'execute'],
    [new SlimeError('SOURCE_ERROR', 'x'), 'execute'],
    [new SlimeError('ACCESS_DENIED', 'x'), 'execute'],
    [new SlimeError('SANDBOX_ERROR', 'x'), 'shape'],
    [new SlimeError('SHAPE_MISMATCH', 'x'), 'output'],
    [new SlimeError('HANDLER_NOT_FOUND', 'x'), 'route'],
  ];
  for (const [error, layer] of cases) {
    test(`${error.code} (${String(error.details?.['enforcedBy'] ?? error.message)}) stops at ${layer}`, () => {
      assert.equal(layerOfError(error), layer);
    });
  }

  test('the layer order is fixed', () => {
    assert.deepEqual([...LAYER_IDS], ['edge', 'key', 'route', 'limits', 'generate', 'lint', 'cost', 'execute', 'shape', 'output', 'cache', 'review']);
  });
});

describe('Trace', () => {
  test('time() records a pass with its ms and note, and returns the result', async () => {
    const trace = new Trace();
    const result = await trace.time('lint', () => 42, { attempt: 1, note: (n) => `got ${n}` });
    assert.equal(result, 42);
    assert.equal(trace.spans.length, 1);
    const [span] = trace.spans;
    assert.deepEqual({ ...span, ms: undefined }, { layer: 'lint', status: 'pass', note: 'got 42', attempt: 1, ms: undefined });
    assert.equal(typeof span!.ms, 'number');
  });

  test('time() records a value-free stop and rethrows the same error', async () => {
    const trace = new Trace();
    const error = new SlimeError('QUERY_ERROR', `invalid input syntax for type integer: "secret-value"`);
    await assert.rejects(trace.time('execute', () => { throw error; }), (e) => e === error);
    assert.equal(trace.spans[0]!.status, 'stop');
    assert.equal(trace.spans[0]!.note, 'QUERY_ERROR: invalid input syntax for type integer: <value>');
  });

  test('notes are cut at 200 characters and ms rounded to 2 decimals', () => {
    const trace = new Trace();
    trace.add('route', 'pass', { ms: 1.23456, note: 'x'.repeat(300) });
    assert.equal(trace.spans[0]!.note!.length, 200);
    assert.equal(trace.spans[0]!.ms, 1.23);
  });

  test('addExecution() adds execute, shape and output spans without values', () => {
    const trace = new Trace();
    trace.addExecution({ data: [{ secret: 'v' }], truncated: false, runMs: 12.5, shapeMs: 1.5, steps: [{ name: 'main', source: 'postgres', rows: 5, ms: 12 }] }, 2);
    assert.deepEqual(trace.spans.map((s) => [s.layer, s.status, s.attempt]), [['execute', 'pass', 2], ['shape', 'pass', 2], ['output', 'pass', 2]]);
    assert.equal(trace.spans[0]!.note, '1 step · 5 rows');
    assert.ok(!JSON.stringify(trace.spans).includes('secret'));
  });

  test('addExecution() marks shape skipped when there is no shape function', () => {
    const trace = new Trace();
    trace.addExecution({ data: [], truncated: true, runMs: 3, shapeMs: 0 });
    assert.deepEqual(trace.spans.map((s) => [s.layer, s.status]), [['execute', 'pass'], ['shape', 'skip'], ['output', 'pass']]);
    assert.equal(trace.spans[0]!.note, '1 query · cut at the row cap');
  });

  test('attach() returns a copy carrying this request\'s trace and key; toJSON() is unchanged', () => {
    const trace = new Trace();
    trace.add('key', 'pass');
    const original = new SlimeError('GENERATION_RATE_LIMITED', 'cap', { retryable: true, details: { a: 1 } });
    const attached = trace.attach(original, 'k1') as SlimeError;
    assert.notEqual(attached, original, 'a shared (coalesced) error must not be mutated');
    assert.equal(attached.code, 'GENERATION_RATE_LIMITED');
    assert.equal(attached.status, 429);
    assert.equal(attached.retryable, true);
    assert.deepEqual(attached.toJSON(), original.toJSON());
    assert.equal(attached.handlerKey, 'k1');
    assert.deepEqual(attached.trace!.map((s) => [s.layer, s.status]), [['key', 'pass'], ['limits', 'stop']]);
    assert.equal(original.trace, undefined);
  });

  test('attach() does not add a second stop when the last span already stopped at that layer', () => {
    const trace = new Trace();
    trace.add('cost', 'stop', { note: 'QUERY_TOO_EXPENSIVE: ...' });
    const attached = trace.attach(new SlimeError('QUERY_TOO_EXPENSIVE', 'x')) as SlimeError;
    assert.equal(attached.trace!.filter((s) => s.status === 'stop').length, 1);
  });

  test('attach() passes non-Slime errors through untouched', () => {
    const error = new TypeError('boom');
    assert.equal(new Trace().attach(error), error);
  });

  test('fail() adds a stop at the error\'s layer', () => {
    const trace = new Trace();
    trace.fail(new SlimeError('SANDBOX_ERROR', 'Shaping function threw: TypeError: x'), 1);
    assert.deepEqual(trace.spans, [{ layer: 'shape', status: 'stop', note: 'SANDBOX_ERROR: the shape function threw a TypeError', attempt: 1 }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @slime-cloud/core -- --test-name-pattern="layerOfError|Trace"` (from repo root)
Expected: FAIL — cannot find module `../../src/shared/trace.js`.

- [ ] **Step 3: Write `core/src/shared/trace.ts`**

```ts
// A request's walk through the harness: one span per layer it reached (request trace design T1–T4).
// Types and the error → layer map only; the engine records spans (engine/trace.ts).
import type { ErrorCode, SlimeError } from './errors.js';

/** Every layer, in the order a request meets them. Hosts add `edge`; the engine records the rest. */
export const LAYER_IDS = ['edge', 'key', 'route', 'limits', 'generate', 'lint', 'cost', 'execute', 'shape', 'output', 'cache', 'review'] as const;
export type LayerId = (typeof LAYER_IDS)[number];
export type LayerStatus = 'pass' | 'skip' | 'stop' | 'pending';

/** What one layer did with the request. Notes carry counts, names and limits, never input values or rows. */
export interface LayerSpan {
  layer: LayerId;
  status: LayerStatus;
  ms?: number;
  note?: string;
  /** 1-based generation attempt, on the layers a repair repeats (generate … output). */
  attempt?: number;
}

const LAYER_BY_CODE: Record<ErrorCode, LayerId> = {
  INVALID_REQUEST: 'key',
  HANDLER_NOT_FOUND: 'route',
  GENERATION_RATE_LIMITED: 'limits',
  GENERATION_FAILED: 'generate',
  GENERATION_TIMEOUT: 'generate',
  INTENT_UNSATISFIABLE: 'generate',
  WRITE_REFUSED: 'lint',
  INVALID_HANDLER: 'lint',
  QUERY_TOO_LARGE: 'cost',
  QUERY_TOO_EXPENSIVE: 'cost',
  QUERY_ERROR: 'execute',
  EXECUTION_TIMEOUT: 'execute',
  SOURCE_ERROR: 'execute',
  ACCESS_DENIED: 'execute',
  SANDBOX_ERROR: 'shape',
  SHAPE_MISMATCH: 'output',
};
// R6 (execution/output-limit.ts) reuses INVALID_HANDLER after the run; its message names input.limit.
const R6_MESSAGE = /input\.limit/;

/** The layer that refused a request with this error. */
export function layerOfError(error: SlimeError): LayerId {
  if (error.code === 'WRITE_REFUSED') {
    const enforcedBy = error.details?.['enforcedBy'];
    return enforcedBy === 'model' ? 'generate' : enforcedBy === 'lint' ? 'lint' : 'execute';
  }
  if (error.code === 'INVALID_HANDLER' && R6_MESSAGE.test(error.message)) return 'output';
  return LAYER_BY_CODE[error.code];
}
```

- [ ] **Step 4: Add the fields to `SlimeError`** in `core/src/shared/errors.ts` — add the import at the top and two fields under `readonly details`:

```ts
import type { LayerSpan } from './trace.js';
```

```ts
  /** The layers this request passed before it failed (request trace T3). Set by the engine; never in toJSON(). */
  trace?: LayerSpan[];
  /** The request's handler key, when it was computed before the failure. */
  handlerKey?: string;
```

- [ ] **Step 5: Write `core/src/engine/trace.ts`**

```ts
// Records a request's LayerSpans while the engine answers it (request trace design T1–T4).
import { SlimeError } from '../shared/errors.js';
import { layerOfError, type LayerId, type LayerSpan, type LayerStatus } from '../shared/trace.js';
import type { Execution } from './execution/execute.js';
import { repairMessage } from './generation/repair-message.js';

const NOTE_MAX = 200;
const MS_PRECISION = 100;

export interface SpanExtra {
  ms?: number | undefined;
  note?: string | undefined;
  attempt?: number | undefined;
}

export interface TimeOptions<T> {
  attempt?: number | undefined;
  /** The pass note, from the layer's result. */
  note?: (result: T) => string | undefined;
}

export class Trace {
  readonly spans: LayerSpan[] = [];

  add(layer: LayerId, status: LayerStatus, { ms, note, attempt }: SpanExtra = {}): void {
    const span: LayerSpan = { layer, status };
    if (ms !== undefined) span.ms = Math.round(ms * MS_PRECISION) / MS_PRECISION;
    if (note) span.note = note.slice(0, NOTE_MAX);
    if (attempt !== undefined) span.attempt = attempt;
    this.spans.push(span);
  }

  /** Runs one layer's work: a pass span with its time, or a value-free stop span, then the same error again. */
  async time<T>(layer: LayerId, work: () => T | Promise<T>, { attempt, note }: TimeOptions<T> = {}): Promise<T> {
    const startedAt = performance.now();
    try {
      const result = await work();
      this.add(layer, 'pass', { ms: performance.now() - startedAt, note: note?.(result), attempt });
      return result;
    } catch (error) {
      this.add(layer, 'stop', { ms: performance.now() - startedAt, note: stopNote(error), attempt });
      throw error;
    }
  }

  /** A run that passed: the steps, the shape and the output check. Counts only. */
  addExecution(execution: Execution, attempt?: number): void {
    const { steps, truncated, runMs, shapeMs } = execution;
    const ran = steps ? `${steps.length} step${steps.length === 1 ? '' : 's'} · ${steps.reduce((n, s) => n + s.rows, 0)} rows` : '1 query';
    this.add('execute', 'pass', { ms: runMs, note: truncated ? `${ran} · cut at the row cap` : ran, attempt });
    if (shapeMs > 0) this.add('shape', 'pass', { ms: shapeMs, note: 'shape ran', attempt });
    else this.add('shape', 'skip', { note: 'no shape function', attempt });
    this.add('output', 'pass', { note: 'matches the output shape', attempt });
  }

  /** A failure inside a layer that was not timed: a stop span at the error's layer. */
  fail(error: unknown, attempt?: number): void {
    const layer = error instanceof SlimeError ? layerOfError(error) : 'execute';
    this.add(layer, 'stop', { note: stopNote(error), attempt });
  }

  /**
   * The error to throw for this request: a copy that carries this request's spans (ending in a
   * stop) and its key. A copy, because coalesced requests share one error object.
   */
  attach(error: unknown, handlerKey?: string): unknown {
    if (!(error instanceof SlimeError)) return error;
    const layer = layerOfError(error);
    const last = this.spans.at(-1);
    if (!(last?.status === 'stop' && last.layer === layer)) this.add(layer, 'stop', { note: stopNote(error) });
    const copy = new SlimeError(error.code, error.message, { retryable: error.retryable, ...(error.details ? { details: error.details } : {}) });
    if (error.stack) copy.stack = error.stack;
    copy.trace = [...this.spans];
    if (handlerKey) copy.handlerKey = handlerKey;
    return copy;
  }
}

function stopNote(error: unknown): string {
  return error instanceof SlimeError ? repairMessage(error) : 'unexpected error';
}
```

- [ ] **Step 6: Export the public types** — in `core/src/index.ts`, next to the `SlimeError` export line add:

```ts
export { LAYER_IDS, type LayerId, type LayerSpan, type LayerStatus } from './shared/trace.js';
```

- [ ] **Step 7: Run the tests and typecheck**

Run: `npm test -w @slime-cloud/core && npm run typecheck -w @slime-cloud/core` (repo root)
Expected: PASS, including `test/architecture.test.ts` and `test/package.test.ts` (if `package.test.ts` lists exports, add the new ones there).

- [ ] **Step 8: Commit**

```bash
git add core/src/shared/trace.ts core/src/engine/trace.ts core/src/shared/errors.ts core/src/index.ts core/test/engine/trace.test.ts
git commit -m "feat(core): per-request trace of harness layers

Spans per layer with value-free stop notes, so a host can show which gates a
request passed and where it was refused. The trace rides on SlimeError.trace,
not details, so error bodies stay unchanged."
```

---

### Task 2: core engine records the trace on every route

**Files:**
- Modify: `core/src/engine/slime-engine.ts` (`#answer`, `#resolve`, `#generate`, `#runSaved`)
- Modify: `core/src/engine/generation/generate.ts` (per-attempt spans)
- Modify: `core/src/engine/crystal/answer.ts` (accept the trace)
- Modify: `core/src/engine/meta.ts` (`MetaParts.trace`, copied into meta)
- Modify: `core/src/engine/types.ts` (`QueryMeta.trace?: LayerSpan[]`)
- Modify: `core/src/engine/README.md` (one invariant line)
- Test: `core/test/engine/trace-engine.test.ts`

**Interfaces:**
- Consumes (Task 1): `Trace`, `LayerSpan`, `layerOfError`, `SlimeError.trace`, `SlimeError.handlerKey`.
- Produces: `QueryMeta.trace` set on every answer; every `SlimeError` thrown by `slime.query()` carries `trace` (ending in a stop) and `handlerKey` when the key was computed. `GenerationJob.trace?: Trace`. `CrystalAnswer.trace: Trace`.

Span content by route (the tests below pin these):

| Route | route note | limits | generate | lint / cost | execute… output | cache | review |
|---|---|---|---|---|---|---|---|
| Crystal | `Crystal <key 12>` | skip `no model call` | skip `frozen code` | skip `checked before freezing` | `addExecution` | skip `Crystal: nothing to promote` | from `crystal.review` |
| hit | `cache hit · <tier>` | skip `no model call` | skip `code written <YYYY-MM-DD>` | skip `checked when generated` | `addExecution` | progress note | from record |
| coalesced | `same request already generating → joined it` | skip `joined a generation in flight` | skip, `ms` = wait, `waited for the same request's generation` | skip `checked in the shared generation` | `addExecution` | progress note | from record |
| miss | `cache miss → generate` | pass `<n> of <max> this hour` | per attempt pass `<tokens> tokens` | per attempt (lint pass `read-only · params mapped · <n> step(s)`; cost pass `cost <max cost> of <limit>` or skip `no SQL steps`) | per attempt `addExecution` | `kept as Gas · <runs> of <gasToLiquidRuns> runs to Liquid` | from record |

Progress note: Gas `<runs> of <gasToLiquidRuns> runs to Liquid`; Liquid `<runs> of <crystalReadyRuns> runs to Crystal-ready`.
Review span: `approved` → pass `approved`; `rejected` → skip `rejected — stays Gas`; `pending` → pending `review running in the background`; `none` → skip, note `review starts at <gasToLiquidRuns> runs` when a reviewer is configured, else `no reviewer configured`.
Key span: pass, note `inputs: <names comma-separated>` or `no inputs`. A Crystal that drifted and fell back: the final route note starts with `Crystal failed (<CODE>) → ` followed by the normal route note.

- [ ] **Step 1: Write the failing test** — `core/test/engine/trace-engine.test.ts`

```ts
// The engine records which layers each request passed, on every route and every refusal (request trace design).
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { SlimeConfig, type SlimeOptions } from '../../src/config/slime-config.js';
import { createSlime } from '../../src/create-slime.js';
import type { Slime } from '../../src/engine/types.js';
import { SlimeError } from '../../src/shared/errors.js';
import type { LayerSpan } from '../../src/shared/trace.js';
import type { SlimeRequest } from '../../src/request/parse.js';
import { memoryStore } from '../../src/stores/memory-store.js';
import { artifact, fakeConnector, stubGenerator, stubReviewer } from '../../src/testing/fakes.js';

const ROWS = [{ name: 'Acme' }, { name: 'Globex' }];
const REQUEST: SlimeRequest = { intent: 'accounts in a country', input: { country: 'DE-SECRET' }, output: [{ name: 'string' }] };
const GOOD = artifact('SELECT name FROM accounts WHERE country = $1', ['country']);

const open: Slime[] = [];
after(() => Promise.all(open.map((s) => s.close())));
async function start(options: Partial<SlimeOptions> = {}): Promise<Slime> {
  const slime = await createSlime(new SlimeConfig({ connector: fakeConnector({ rows: ROWS }), store: memoryStore(), generator: stubGenerator(() => GOOD), ...options }));
  open.push(slime);
  return slime;
}
const pairs = (spans: LayerSpan[] | undefined) => (spans ?? []).map((s) => `${s.layer}:${s.status}${s.attempt ? `#${s.attempt}` : ''}`);
async function refusal(slime: Slime, request: SlimeRequest = REQUEST): Promise<SlimeError> {
  try {
    await slime.query(request);
  } catch (error) {
    assert.ok(error instanceof SlimeError);
    return error;
  }
  throw new Error('expected a refusal');
}

describe('engine trace: answered requests', () => {
  test('a miss records every layer of the generation, with attempt numbers', async () => {
    const slime = await start();
    const { meta } = await slime.query(REQUEST);
    assert.deepEqual(pairs(meta.trace), ['key:pass', 'route:pass', 'limits:pass', 'generate:pass#1', 'lint:pass#1', 'cost:pass#1', 'execute:pass#1', 'shape:skip#1', 'output:pass#1', 'cache:pass', 'review:skip']);
    const notes = Object.fromEntries(meta.trace!.map((s) => [s.layer, s.note]));
    assert.equal(notes['key'], 'inputs: country');
    assert.equal(notes['route'], 'cache miss → generate');
    assert.match(notes['limits']!, /^1 of 200 this hour$/);
    assert.equal(notes['cost'], 'cost 1 of 1000000');
    assert.equal(notes['cache'], 'kept as Gas · 1 of 3 runs to Liquid');
    assert.equal(notes['review'], 'no reviewer configured');
  });

  test('a repaired attempt stays in the trace', async () => {
    let calls = 0;
    // Attempt 1 binds a parameter that is not an input name: INVALID_HANDLER at lint, which a repair can fix.
    const generator = stubGenerator(() => (++calls === 1 ? artifact('SELECT name FROM accounts WHERE country = $1', ['nope']) : GOOD));
    const slime = await start({ generator });
    const { meta } = await slime.query(REQUEST);
    const attempts = pairs(meta.trace).filter((p) => /#\d/.test(p));
    assert.deepEqual(attempts.slice(0, 2), ['generate:pass#1', 'lint:stop#1']);
    assert.ok(attempts.includes('output:pass#2'));
  });

  test('a hit skips generation and reports the Gas progress', async () => {
    const slime = await start();
    await slime.query(REQUEST);
    const { meta } = await slime.query(REQUEST);
    assert.deepEqual(pairs(meta.trace), ['key:pass', 'route:pass', 'limits:skip', 'generate:skip', 'lint:skip', 'cost:skip', 'execute:pass', 'shape:skip', 'output:pass', 'cache:pass', 'review:skip']);
    assert.equal(meta.trace!.find((s) => s.layer === 'route')!.note, 'cache hit · gas');
    assert.equal(meta.trace!.find((s) => s.layer === 'cache')!.note, '2 of 3 runs to Liquid');
  });

  test('a coalesced request records the wait as a skipped generate', async () => {
    const slime = await start({ generator: stubGenerator(() => GOOD, 30) });
    const [, second] = await Promise.all([slime.query(REQUEST), slime.query(REQUEST)]);
    assert.equal(second.meta.cache, 'coalesced');
    const generate = second.meta.trace!.find((s) => s.layer === 'generate')!;
    assert.equal(generate.status, 'skip');
    assert.ok((generate.ms ?? 0) > 0);
    assert.equal(second.meta.trace!.find((s) => s.layer === 'route')!.note, 'same request already generating → joined it');
  });

  test('a configured reviewer shows when the review starts', async () => {
    const slime = await start({ reviewer: stubReviewer(['approve']) });
    const { meta } = await slime.query(REQUEST);
    assert.equal(meta.trace!.find((s) => s.layer === 'review')!.note, 'review starts at 3 runs');
  });

  test('no trace note carries an input value', async () => {
    const slime = await start();
    const { meta } = await slime.query(REQUEST);
    assert.ok(!JSON.stringify(meta.trace).includes('DE-SECRET'));
  });
});

describe('engine trace: refused requests', () => {
  test('a write the model refuses stops at generate, with the key', async () => {
    const generator = stubGenerator(() => ({ ...GOOD, unsatisfiable: 'this would delete rows' }));
    const error = await refusal(await start({ generator }));
    assert.equal(error.code, 'WRITE_REFUSED');
    assert.equal(error.trace!.at(-1)!.layer, 'generate');
    assert.equal(error.trace!.at(-1)!.status, 'stop');
    assert.ok(error.handlerKey);
    assert.equal(JSON.stringify(error.toJSON()).includes('trace'), false, 'toJSON is unchanged');
  });

  test('SQL that writes stops at lint', async () => {
    const generator = stubGenerator(() => artifact('DELETE FROM accounts WHERE country = $1', ['country']));
    const error = await refusal(await start({ generator }));
    assert.equal(error.code, 'WRITE_REFUSED');
    assert.deepEqual(pairs(error.trace).slice(-2), ['generate:pass#1', 'lint:stop#1']);
  });

  test('an expensive plan stops at cost on every attempt', async () => {
    const error = await refusal(await start({ connector: fakeConnector({ rows: ROWS, cost: 5_000_000 }) }));
    assert.equal(error.code, 'QUERY_TOO_EXPENSIVE');
    assert.deepEqual(pairs(error.trace).filter((p) => p.startsWith('cost')), ['cost:stop#1', 'cost:stop#2']);
    assert.equal(error.trace!.at(-1)!.layer, 'cost');
  });

  test('the hourly generation cap stops at limits before any model call', async () => {
    const slime = await start({ limits: { maxGenerationsPerHour: 1 } } as Partial<SlimeOptions>);
    await slime.query(REQUEST);
    const error = await refusal(slime, { ...REQUEST, intent: 'another intent' });
    assert.equal(error.code, 'GENERATION_RATE_LIMITED');
    assert.deepEqual(pairs(error.trace), ['key:pass', 'route:pass', 'limits:stop']);
  });

  test('a bad request stops at key, without a handler key', async () => {
    const error = await refusal(await start(), { intent: '', input: {}, output: [{ name: 'string' }] } as SlimeRequest);
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.deepEqual(pairs(error.trace), ['key:stop']);
    assert.equal(error.handlerKey, undefined);
  });

  test('coalesced requests that fail together each get their own trace', async () => {
    const generator = stubGenerator(() => ({ ...GOOD, unsatisfiable: 'this would delete rows' }), 20);
    const slime = await start({ generator });
    const [a, b] = await Promise.allSettled([slime.query(REQUEST), slime.query(REQUEST)]);
    assert.equal(a.status, 'rejected');
    assert.equal(b.status, 'rejected');
    const ea = (a as PromiseRejectedResult).reason as SlimeError;
    const eb = (b as PromiseRejectedResult).reason as SlimeError;
    assert.notEqual(ea, eb);
    assert.ok(pairs(ea.trace).includes('limits:pass'));
    assert.ok(pairs(eb.trace).includes('limits:skip'));
  });
});
```

Notes for the implementer: check `SlimeOptions` for the real way to override `limits` (the cast above is a placeholder only if `limits` is a partial option; use the real option shape and remove the cast). If `stubReviewer`'s verdict literal differs from `'approve'`, use the one in `core/src/testing/fakes.ts`. If `parseRequest` accepts an empty intent, use another invalid body that `parseRequest` refuses (look at `core/test/request/`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -w @slime-cloud/core -- --test-name-pattern="engine trace"`
Expected: FAIL — `meta.trace` is undefined.

- [ ] **Step 3: Carry the trace in meta** — `core/src/engine/types.ts`: import `type LayerSpan` from `../shared/trace.js` and add to `QueryMeta`:

```ts
  /** Which harness layers answered this request, in order (request trace design). */
  trace?: LayerSpan[];
```

`core/src/engine/meta.ts`: add `trace?: LayerSpan[]` to `MetaParts`, destructure it in `queryMeta`, and spread `...(trace ? { trace } : {})` into the returned object.

- [ ] **Step 4: Per-attempt spans in `generate.ts`** — add `trace?: Trace` to `GenerationJob`; in `generateHandler`, `const trace = job.trace ?? new Trace();` (revisions from the review loop pass none). Replace the loop body and `tryArtifact` with:

```ts
  for (let attempt = 0; attempt <= deps.limits.maxRepairs && deadline - Date.now() >= MIN_ATTEMPT_MS; attempt++) {
    const attemptNo = attempt + 1;
    const generation = await trace.time(
      'generate',
      async () => {
        const result = await deps.generator.generate(
          { context: deps.dictionaryText, intent: request.intent, params: paramTypesForModel(paramTypes), output: request.output, ...(previous ? { previous } : {}) },
          { timeoutMs: deadline - Date.now() },
        );
        addUsage(usage, result);
        deadline += result.waitMs; // provider rate-limit waits don't count against the budget
        assertSatisfiable(result.artifact);
        return result;
      },
      { attempt: attemptNo, note: (g) => `${g.inputTokens + g.outputTokens} tokens` },
    );
    const { artifact } = generation;
    try {
      const execution = await tryArtifact(deps, artifact, request, trace, attemptNo);
      return { record: newRecord({ deps, key, request, artifact, paramTypes }), execution, usage };
    } catch (error) {
      lastError = asSlimeError(error);
      if (FINAL_CODES.has(lastError.code)) throw lastError;
      previous = { artifact, error: repairMessage(lastError) };
    }
  }
```

```ts
async function tryArtifact(deps: GenerationDeps, artifact: Artifact, request: ParsedRequest, trace: Trace, attempt: number): Promise<Execution> {
  const { sqlSourceName, apiSchemas } = deps;
  const stepCount = artifact.steps.length;
  await trace.time('lint', () => lintSteps(artifact, { sqlSourceName, apiSchemas, input: request.input, maxSteps: deps.limits.maxSteps }), {
    attempt,
    note: () => `read-only · params mapped · ${stepCount} step${stepCount === 1 ? '' : 's'}`,
  });
  const sqlSteps = artifact.steps.filter((step): step is SqlStep => 'sql' in step);
  if (sqlSteps.length === 0) trace.add('cost', 'skip', { note: 'no SQL steps', attempt });
  else {
    const costs = await trace.time('cost', () => Promise.all(sqlSteps.map((step) => assertAffordable(deps, step.sql, bindParams(step.params, request.input)))), {
      attempt,
      note: (all) => `cost ${Math.max(0, ...all.map((c) => c ?? 0))} of ${deps.limits.maxQueryCost}`,
    });
    void costs;
  }
  try {
    const execution = await executeArtifact(deps, { artifact, output: request.output, input: request.input });
    trace.addExecution(execution, attempt);
    return execution;
  } catch (error) {
    trace.fail(error, attempt);
    throw error;
  }
}

async function assertAffordable(deps: GenerationDeps, sql: string, params: unknown[]): Promise<number | null> {
  const plan = await deps.connector.check(sql, params, queryLimits(deps.limits));
  if (plan.cost !== null && plan.cost > deps.limits.maxQueryCost) {
    throw new SlimeError('QUERY_TOO_EXPENSIVE', `Query cost ${plan.cost} is above the limit of ${deps.limits.maxQueryCost}.`);
  }
  return plan.cost;
}
```

Keep the original sequential cost checks if the order matters for an existing test (then collect costs in a loop inside the timed function instead of `Promise.all`). Import `Trace` from `../trace.js` and `type SqlStep` from `../../artifact/artifact.js`. Drop the `void costs;` line if the linter or typecheck does not need it.

- [ ] **Step 5: Record the routes in `slime-engine.ts`** — rewrite `#answer`, `#resolve`, `#generate`, `#runSaved` as below (keep everything else). Add `import { Trace } from './trace.js';`.

```ts
  async #answer(raw: unknown): Promise<QueryResult> {
    const startedAt = performance.now();
    const trace = new Trace();
    let key: string | undefined;
    try {
      const request = await trace.time('key', () => parseRequest(raw), { note: (r) => inputsNote(r.input) });
      key = requestKey(request);
      const crystal = this.#parts.config.crystal ? this.#parts.config.crystal[key] : undefined;
      let fallbackWarning: string | undefined;
      let routePrefix = '';
      if (crystal) {
        try {
          return await answerFromCrystal(this.#parts, { key, crystal, request, startedAt, trace });
        } catch (error) {
          if (!isCrystalDrift(error)) throw error;
          fallbackWarning = this.#crystalFailed(key, error);
          routePrefix = `Crystal failed (${error.code}) → `;
        }
      }
      const { record, cache, firstRun, generateMs } = await this.#resolve(key, request, trace, routePrefix);
      const execution = firstRun ?? (await this.#runSaved(record, request.input, trace));
      const { tier, review, artifact, intent } = record;
      this.#traceAfterRun(trace, record, cache);
      const meta = queryMeta({ handlerKey: key, tier, cache, review, execution, code: { sql: sqlOf(artifact), shapeJs: artifact.shapeJs, assumptions: artifact.assumptions }, intent, totalMs: performance.now() - startedAt, trace: trace.spans, ...(generateMs === undefined ? {} : { generateMs }) });
      if (fallbackWarning) meta.warnings.push(fallbackWarning);
      return { data: execution.data, meta };
    } catch (error) {
      throw trace.attach(error, key);
    }
  }

  async #resolve(key: string, request: ParsedRequest, trace: Trace, routePrefix: string): Promise<ResolvedHandler> {
    const found = await this.#cache.find(key);
    if (found) {
      trace.add('route', 'pass', { note: `${routePrefix}cache hit · ${found.tier}` });
      return { record: found, cache: 'hit' };
    }
    const waitStartedAt = performance.now();
    const { promise, isShared } = this.#generations.run(key, () => this.#generate(this.#parts.config.generator, key, request, trace));
    if (isShared) {
      trace.add('route', 'pass', { note: `${routePrefix}same request already generating → joined it` });
      trace.add('limits', 'skip', { note: 'joined a generation in flight' });
      const outcome = await promise;
      trace.add('generate', 'skip', { ms: performance.now() - waitStartedAt, note: "waited for the same request's generation" });
      trace.add('lint', 'skip', { note: 'checked in the shared generation' });
      trace.add('cost', 'skip', { note: 'checked in the shared generation' });
      return { record: outcome.record, cache: 'coalesced' };
    }
    const outcome = await promise;
    return { record: outcome.record, cache: 'miss', firstRun: outcome.execution, generateMs: outcome.usage.ms };
  }

  async #generate(generator: Generator, key: string, request: ParsedRequest, trace: Trace): Promise<GenerationOutcome> {
    trace.add('route', 'pass', { note: 'cache miss → generate' });
    const { maxGenerationsPerHour } = this.#parts.config.limits;
    const releaseSlot = await trace.time('limits', () => this.#limits.acquire(), { note: () => `${this.#limits.generationsThisHour} of ${maxGenerationsPerHour} this hour` });
    try {
      const outcome = await generateHandler(generationDeps(this.#parts, generator), { key, request, trace });
      this.#cache.addGas(outcome.record);
      this.#emit(generatedEvent(outcome.record, outcome.usage));
      this.#promotion.afterRun(outcome.record);
      return outcome;
    } finally {
      releaseSlot();
    }
  }

  async #runSaved(record: HandlerRecord, input: InputValues, trace: Trace): Promise<Execution> {
    if (!trace.spans.some((s) => s.layer === 'generate')) {
      trace.add('limits', 'skip', { note: 'no model call' });
      trace.add('generate', 'skip', { note: `code written ${record.createdAt.slice(0, 10)}` });
      trace.add('lint', 'skip', { note: 'checked when generated' });
      trace.add('cost', 'skip', { note: 'checked when generated' });
    }
    try {
      record.paramTypes = checkParamTypes(record.paramTypes, input);
      const execution = await executeArtifact(executionDeps(this.#parts), { artifact: record.artifact, output: record.output, input });
      trace.addExecution(execution);
      this.#promotion.recordRun(record, input);
      return execution;
    } catch (error) {
      trace.fail(error);
      throw error;
    }
  }

  /** The cache and review spans, after the run counted. */
  #traceAfterRun(trace: Trace, record: HandlerRecord, cache: CacheOutcome): void {
    const { gasToLiquidRuns, crystalReadyRuns } = this.#parts.config.tiers;
    const progress = record.tier === 'liquid' ? `${record.runs} of ${crystalReadyRuns} runs to Crystal-ready` : `${record.runs} of ${gasToLiquidRuns} runs to Liquid`;
    trace.add('cache', 'pass', { note: cache === 'miss' ? `kept as Gas · ${progress}` : progress });
    traceReview(trace, record.review, Boolean(this.#parts.config.reviewer), gasToLiquidRuns);
  }
```

Module-level helpers in `slime-engine.ts` (exported `traceReview` is reused by `crystal/answer.ts`; if that import direction trips `architecture.test.ts`, move `traceReview` into `engine/trace.ts` instead):

```ts
function inputsNote(input: InputValues): string {
  const names = Object.keys(input);
  return names.length ? `inputs: ${names.join(', ')}` : 'no inputs';
}

export function traceReview(trace: Trace, review: ReviewStatus, hasReviewer: boolean, gasToLiquidRuns: number): void {
  if (review === 'approved') trace.add('review', 'pass', { note: 'approved' });
  else if (review === 'rejected') trace.add('review', 'skip', { note: 'rejected — stays Gas' });
  else if (review === 'pending') trace.add('review', 'pending', { note: 'review running in the background' });
  else trace.add('review', 'skip', { note: hasReviewer ? `review starts at ${gasToLiquidRuns} runs` : 'no reviewer configured' });
}
```

Prefer placing `traceReview` in `core/src/engine/trace.ts` from the start (taking `ReviewStatus` from `../handler/record.js`), so both the engine and `crystal/answer.ts` import it from one place.

In the coalesced follower `#runSaved` sees a `generate` span already and does not add the hit skips. For the miss path `firstRun` exists, so `#runSaved` is not called.

- [ ] **Step 6: Crystal spans in `crystal/answer.ts`** — add `trace: Trace` to `CrystalAnswer`; in `answerFromCrystal`:

```ts
  trace.add('route', 'pass', { note: `Crystal ${key.slice(0, 12)}` });
  trace.add('limits', 'skip', { note: 'no model call' });
  trace.add('generate', 'skip', { note: 'frozen code' });
  trace.add('lint', 'skip', { note: 'checked before freezing' });
  trace.add('cost', 'skip', { note: 'checked before freezing' });
  checkParamTypes(crystal.paramTypes, request.input);
  // ... existing runCrystal call, wrapped:
  let execution;
  try {
    execution = await runCrystal({ connector, runner, limits, sources }, crystal, request.input);
  } catch (error) {
    trace.fail(error);
    throw error;
  }
  trace.addExecution(execution);
  trace.add('cache', 'skip', { note: 'Crystal: nothing to promote' });
  traceReview(trace, crystal.review, false, 0);
```

and pass `trace: trace.spans` to `queryMeta`. A drift fallback continues in `#answer` with the same `Trace`: remove the Crystal's spans first so the fallback's route reads cleanly — in `#answer`'s drift branch call `trace.spans.length = 1` (keeps only the `key` span) before `#resolve`. Add a test: a Crystal whose query fails with `QUERY_ERROR` falls back and its final `route` note starts with `Crystal failed (QUERY_ERROR) → ` (use the Crystal setup from `core/test/engine/crystal.test.ts`).

- [ ] **Step 7: Run the whole core suite and typecheck**

Run: `npm test -w @slime-cloud/core && npm run typecheck -w @slime-cloud/core`
Expected: PASS — the new file and every existing test (existing tests that deep-equal a whole `meta` may need `trace` ignored; change those assertions to pick the fields they test, never delete the assertion).

- [ ] **Step 8: Document the invariant** — in `core/src/engine/README.md` under Invariants add:

```md
- **Trace.** Every answer has `meta.trace`, one span per harness layer in the
  order `key → route → limits → generate → lint → cost → execute → shape →
  output → cache → review`; every refusal from `query()` carries the same on
  `SlimeError.trace` (ending in a stop) and the key on `SlimeError.handlerKey`.
  Notes hold counts, names and limits, never input values or rows.
```

- [ ] **Step 9: Commit**

```bash
git add core/src core/test/engine/trace-engine.test.ts
git commit -m "feat(core): record which layers answered or refused each request

Every route (Crystal, hit, joined generation, miss with repairs) fills
meta.trace; every refusal carries the partial trace and the handler key, so
the admin can show where a request was stopped without guessing."
```

---

### Task 3: runtime feed records traces and refusals

**Files:**
- Modify: `platform/runtime/src/events.ts`
- Modify: `platform/runtime/src/app.ts` (`/v0/query`, `/v0/e/:key`, body limit)
- Modify: `platform/runtime/README.md` (feed contract)
- Test: `platform/runtime/test/feed-trace.test.ts`

**Interfaces:**
- Consumes: `QueryMeta.trace`, `SlimeError.trace`, `SlimeError.handlerKey`, `LayerSpan`, `LayerId` from `@slime-cloud/core` (rebuild core first: `npm run build -w @slime-cloud/core` at repo root, then `cd platform/runtime && npm ci` if the copied package is stale).
- Produces: `RequestEvent` with optional `status`, `code`, `stopAt`, `intent`, `inputs`, `trace`, `generated`; `tier` and `cache` become optional. `RequestFeed.record(meta, route?, request?)` and new `RequestFeed.recordFailure(failure, route?, request?)`. Types `RequestInfo { body?: unknown; edge: LayerSpan }`, `RequestFailure { status: number; code: string; ms: number; handlerKey?: string; trace: LayerSpan[] }`.

Event rules:
- `trace` = `[edge, ...meta.trace]` on success, `[edge, ...(error.trace ?? [fallback stop])]` on refusal. Fallback stop layer for runtime-made errors: `INVALID_REQUEST` → `key`, `HANDLER_NOT_FOUND` → `route`, anything else → `execute`; note `<CODE>: <message>` (these messages are built from names only).
- `stopAt` = layer of the last `stop` span of `trace`; absent on success.
- `status` = 200 on success, `error.status` for a `SlimeError`, 500 with `code: 'INTERNAL'` otherwise (no trace then besides edge).
- `intent` = `body.intent.slice(0, 200)` when it is a string; on the Crystal route the Crystal's intent.
- `inputs` = `Object.keys(body.input).sort()` when `input` is a plain object.
- `generated` only when `meta.cache === 'miss'` and `meta.sql` is a string: `{ sql, assumptions: meta.assumptions ?? [], shapeJs? }`.
- Edge span: `{ layer: 'edge', status: 'pass', note: '<API key|Crystal token> · body <n> B' }`, `n` from the `content-length` header (omit `· body …` when absent). Over 16 KB: `{ layer: 'edge', status: 'stop', note: 'INVALID_REQUEST: Body larger than 16 KB.' }`.

- [ ] **Step 1: Write the failing test** — `platform/runtime/test/feed-trace.test.ts`

```ts
// The feed keeps each request's trace, refused requests too, and never an input value (request trace design T4–T6).
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlimeError, type QueryMeta, type Slime } from '@slime-cloud/core';
import { createApp } from '../src/app.js';
import { RecentRequests } from '../src/events.js';

const connector = { safetyCheck: async () => ({ ok: true }) } as never;
const BODY = { intent: 'accounts in a country', input: { country: 'DE-SECRET', limit: 5 }, output: [{ name: 'string' }] };
const TRACE = [{ layer: 'key', status: 'pass' }, { layer: 'route', status: 'pass', note: 'cache miss → generate' }];

function slimeAnswering(meta: Partial<QueryMeta>): Slime {
  return { query: async () => ({ data: [], meta: { handlerKey: 'k1', tier: 'gas', cache: 'miss', timingsMs: { total: 5, run: 1, shape: 0 }, sql: 'SELECT 1', assumptions: ['a'], trace: TRACE, ...meta } }) } as unknown as Slime;
}
function slimeRefusing(error: unknown): Slime {
  return { query: async () => { throw error; } } as unknown as Slime;
}
const post = (body: string, headers: Record<string, string> = {}) => ({ method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });

describe('feed: answered requests', () => {
  test('a generation keeps intent, input names, the trace behind edge, and the code', async () => {
    const events = new RecentRequests();
    const app = createApp({ slime: slimeAnswering({}), connector, events });
    const body = JSON.stringify(BODY);
    await app.request('/v0/query', post(body, { 'content-length': String(body.length) }));
    const [e] = events.list().events;
    assert.equal(e!.status, 200);
    assert.equal(e!.intent, BODY.intent);
    assert.deepEqual(e!.inputs, ['country', 'limit']);
    assert.deepEqual(e!.trace!.map((s) => s.layer), ['edge', 'key', 'route']);
    assert.equal(e!.trace![0]!.note, `API key · body ${body.length} B`);
    assert.deepEqual(e!.generated, { sql: 'SELECT 1', assumptions: ['a'] });
    assert.equal(e!.stopAt, undefined);
    assert.ok(!JSON.stringify(e).includes('DE-SECRET'));
  });

  test('a hit stores no code', async () => {
    const events = new RecentRequests();
    await createApp({ slime: slimeAnswering({ cache: 'hit' }), connector, events }).request('/v0/query', post(JSON.stringify(BODY)));
    assert.equal(events.list().events[0]!.generated, undefined);
  });

  test('the intent is cut at 200 characters', async () => {
    const events = new RecentRequests();
    await createApp({ slime: slimeAnswering({}), connector, events }).request('/v0/query', post(JSON.stringify({ ...BODY, intent: 'x'.repeat(500) })));
    assert.equal(events.list().events[0]!.intent!.length, 200);
  });
});

describe('feed: refused requests', () => {
  test('a refusal from the engine keeps its code, stop layer, key and trace', async () => {
    const error = new SlimeError('WRITE_REFUSED', 'reads as a write', { details: { enforcedBy: 'lint' } });
    error.trace = [{ layer: 'key', status: 'pass' }, { layer: 'lint', status: 'stop', note: 'WRITE_REFUSED: reads as a write', attempt: 1 }];
    error.handlerKey = 'k9';
    const events = new RecentRequests();
    const res = await createApp({ slime: slimeRefusing(error), connector, events }).request('/v0/query', post(JSON.stringify(BODY)));
    assert.equal(res.status, 403);
    const [e] = events.list().events;
    assert.equal(e!.status, 403);
    assert.equal(e!.code, 'WRITE_REFUSED');
    assert.equal(e!.stopAt, 'lint');
    assert.equal(e!.handlerKey, 'k9');
    assert.equal(e!.tier, undefined);
    assert.deepEqual(e!.trace!.map((s) => `${s.layer}:${s.status}`), ['edge:pass', 'key:pass', 'lint:stop']);
    assert.deepEqual(await res.json(), { error: error.toJSON() }, 'the response body is unchanged');
  });

  test('invalid JSON stops at key', async () => {
    const events = new RecentRequests();
    await createApp({ slime: slimeAnswering({}), connector, events }).request('/v0/query', post('{nope'));
    const [e] = events.list().events;
    assert.equal(e!.code, 'INVALID_REQUEST');
    assert.equal(e!.stopAt, 'key');
  });

  test('a body over 16 KB stops at edge', async () => {
    const events = new RecentRequests();
    const big = JSON.stringify({ ...BODY, intent: 'x'.repeat(17 * 1024) });
    const res = await createApp({ slime: slimeAnswering({}), connector, events }).request('/v0/query', post(big, { 'content-length': String(big.length) }));
    assert.equal(res.status, 413);
    const [e] = events.list().events;
    assert.equal(e!.stopAt, 'edge');
    assert.equal(e!.status, 413);
  });

  test('an unexpected error is recorded as INTERNAL', async () => {
    const events = new RecentRequests();
    const res = await createApp({ slime: slimeRefusing(new TypeError('boom')), connector, events }).request('/v0/query', post(JSON.stringify(BODY)));
    assert.equal(res.status, 500);
    assert.equal(events.list().events[0]!.code, 'INTERNAL');
  });
});
```

Also extend the Crystal route tests in `platform/runtime/test/local.test.ts`: a Crystal request records `route: 'crystal'`, the Crystal's intent, and an edge note starting `Crystal token`; a missing input name records `code: 'INVALID_REQUEST'`, `stopAt: 'key'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform/runtime && node --import tsx --test test/feed-trace.test.ts`
Expected: FAIL — `e.status` is undefined.

- [ ] **Step 3: Extend `events.ts`** — new fields and helpers (keep `RecentRequests`/`StoredRequests` storage logic as is):

```ts
import type { LayerId, LayerSpan, QueryMeta } from '@slime-cloud/core';

export interface RequestEvent {
  at: string;
  /** Empty when the request was refused before it had a key. */
  handlerKey: string;
  /** Absent on refused requests. */
  tier?: QueryMeta['tier'];
  cache?: QueryMeta['cache'];
  ms: number;
  route?: 'crystal';
  /** HTTP status; absent on events written before traces (they were all 200). */
  status?: number;
  code?: string;
  stopAt?: LayerId;
  intent?: string;
  /** Input names only, sorted; never values. */
  inputs?: string[];
  trace?: LayerSpan[];
  /** The generated code, on generations (`cache: 'miss'`) only. */
  generated?: { sql: string; shapeJs?: string; assumptions: string[] };
}

/** What the route knows about the request besides the engine's answer. */
export interface RequestInfo {
  body?: unknown;
  edge: LayerSpan;
}

export interface RequestFailure {
  status: number;
  code: string;
  ms: number;
  handlerKey?: string;
  trace: LayerSpan[];
}

const INTENT_MAX = 200;

function describeRequest(body: unknown): Pick<RequestEvent, 'intent' | 'inputs'> {
  if (!body || typeof body !== 'object') return {};
  const { intent, input } = body as { intent?: unknown; input?: unknown };
  return {
    ...(typeof intent === 'string' ? { intent: intent.slice(0, INTENT_MAX) } : {}),
    ...(input && typeof input === 'object' && !Array.isArray(input) ? { inputs: Object.keys(input).sort() } : {}),
  };
}

function toEvent(meta: QueryMeta, route?: 'crystal', request?: RequestInfo): RequestEvent {
  const generated = meta.cache === 'miss' && typeof meta.sql === 'string'
    ? { generated: { sql: meta.sql, assumptions: meta.assumptions ?? [], ...(meta.shapeJs ? { shapeJs: meta.shapeJs } : {}) } }
    : {};
  return {
    at: new Date().toISOString(),
    handlerKey: meta.handlerKey,
    tier: meta.tier,
    cache: meta.cache,
    ms: meta.timingsMs.total,
    ...(route ? { route } : {}),
    status: 200,
    ...describeRequest(request?.body),
    ...(request ? { trace: [request.edge, ...(meta.trace ?? [])] } : meta.trace ? { trace: meta.trace } : {}),
    ...generated,
  };
}

function toFailedEvent(failure: RequestFailure, route?: 'crystal', request?: RequestInfo): RequestEvent {
  const stop = [...failure.trace].reverse().find((s) => s.status === 'stop');
  return {
    at: new Date().toISOString(),
    handlerKey: failure.handlerKey ?? '',
    ms: Math.round(failure.ms * 100) / 100,
    ...(route ? { route } : {}),
    status: failure.status,
    code: failure.code,
    ...(stop ? { stopAt: stop.layer } : {}),
    ...describeRequest(request?.body),
    trace: failure.trace,
  };
}
```

Add `recordFailure(failure, route?, request?)` to the `RequestFeed` interface and to both classes (same bookkeeping as `record`, using `toFailedEvent`); change `record(meta, route?, request?)` to pass `request` through. Existing callers that pass two arguments keep working.

- [ ] **Step 4: Record in `app.ts`** — add helpers and rewrite the two data routes and the body limit:

```ts
import { SlimeError, type LayerSpan } from '@slime-cloud/core';
import type { RequestFailure } from './events.js';

function edgeSpan(contentLength: string | undefined, credential: 'API key' | 'Crystal token'): LayerSpan {
  return { layer: 'edge', status: 'pass', note: contentLength ? `${credential} · body ${contentLength} B` : credential };
}

const FALLBACK_STOP: Record<string, LayerSpan['layer']> = { INVALID_REQUEST: 'key', HANDLER_NOT_FOUND: 'route' };

function failureOf(error: unknown, ms: number, edge: LayerSpan): RequestFailure {
  if (!(error instanceof SlimeError)) return { status: 500, code: 'INTERNAL', ms, trace: [edge] };
  const trace = error.trace ?? [{ layer: FALLBACK_STOP[error.code] ?? 'execute', status: 'stop' as const, note: `${error.code}: ${error.message}`.slice(0, 200) }];
  return { status: error.status, code: error.code, ms, trace: [edge, ...trace], ...(error.handlerKey ? { handlerKey: error.handlerKey } : {}) };
}
```

`/v0/query` handler:

```ts
    async (c) => {
      const startedAt = performance.now();
      const edge = edgeSpan(c.req.header('content-length'), 'API key');
      let body: unknown;
      try {
        body = await c.req.json().catch(() => {
          throw new SlimeError('INVALID_REQUEST', 'Body must be valid JSON.');
        });
        const { data, meta } = await slime.query(body);
        onQuery?.(meta);
        events?.record(meta, undefined, { body, edge });
        c.header('Server-Timing', `total;dur=${meta.timingsMs.total}, generate;dur=${meta.timingsMs.generate ?? 0}`);
        logLine({ at: new Date().toISOString(), handler: meta.handlerKey, tier: meta.tier, cache: meta.cache, ms: meta.timingsMs });
        return c.json({ data, meta });
      } catch (error) {
        events?.recordFailure(failureOf(error, performance.now() - startedAt, edge), undefined, { body, edge });
        throw error;
      }
    },
```

The body limit: `bodyLimit` runs before the handler, so record there — make `limitBody` take the credential and route:

```ts
  const limitBody = (credential: 'API key' | 'Crystal token', route?: 'crystal') =>
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => {
        const message = 'Body larger than 16 KB.';
        const edge: LayerSpan = { layer: 'edge', status: 'stop', note: `INVALID_REQUEST: ${message}` };
        events?.recordFailure({ status: 413, code: 'INVALID_REQUEST', ms: 0, trace: [edge] }, route);
        return c.json({ error: { code: 'INVALID_REQUEST', message, retryable: false } }, 413);
      },
    });
```

Use `limitBody('API key')` on `/v0/query` and `limitBody('Crystal token', 'crystal')` on `/v0/e/:key`. Wrap the Crystal route body the same way as `/v0/query` (edge credential `'Crystal token'`, `route` `'crystal'`, record `{ body: { intent: handler.intent, input }, edge }`; on its INVALID_REQUEST/HANDLER_NOT_FOUND throws record the failure before rethrowing). Keep every existing response body and status exactly as they are.

- [ ] **Step 5: Run the runtime suite and typecheck**

Run: `cd platform/runtime && npm test && npm run typecheck`
Expected: PASS (fix any test that builds a `RequestEvent` or calls a custom `RequestFeed` without `recordFailure`).

- [ ] **Step 6: Document** — in `platform/runtime/README.md`, where `GET /v0/events` is described, add: events now also cover refused requests (`status`, `code`, `stopAt`), carry `intent`, input names, the layer `trace` (with `edge` first) and, on generations only, `generated` code; never input values; old events lack these fields.

- [ ] **Step 7: Commit**

```bash
git add platform/runtime/src/events.ts platform/runtime/src/app.ts platform/runtime/test platform/runtime/README.md
git commit -m "feat(runtime): feed keeps each request's layer trace and refusals

Refused requests used to vanish from the Requests log; now they are recorded
with the layer that stopped them. Generations keep their code so a Gas
handler's SQL is visible even from another Lambda instance."
```

---

### Task 4: runtime serves a handler's code

**Files:**
- Modify: `platform/runtime/src/app.ts` (route + `RuntimeParts.handlerCode`)
- Modify: `platform/runtime/src/endpoint-runtime.ts` (implement `handlerCode`)
- Create: `platform/runtime/src/handler-code.ts`
- Test: `platform/runtime/test/handler-code.test.ts`

**Interfaces:**
- Consumes: the Crystal registry passed to `createApp` (`crystal`), the endpoint store (`handlers` namespace), live records via `slimeInternals(slime).liveRecords()` from `@slime-cloud/core/tooling`.
- Produces: `GET /v0/handlers/:key/code` → `200 { key, tier, sql, shapeJs?, assumptions }` or `404 { error: { code: 'HANDLER_NOT_FOUND', ... } }`. Type `HandlerCode { key: string; tier: 'gas' | 'liquid' | 'crystal'; sql: string; shapeJs?: string; assumptions: string[] }`. `RuntimeParts.handlerCode?: (key: string) => Promise<HandlerCode | undefined>`.

Lookup order: Crystal (`sql`, or the steps' SQL joined with `;\n\n`; `shapeJs` = `String(shape)` when it is a string) → live record on this instance → saved record in the store. A stored record's artifact is either the current form (`{ steps, shapeJs, assumptions }`) or the legacy single-query form (`{ sql, shapeJs?, assumptions? }`); handle both.

- [ ] **Step 1: Write the failing test** — `platform/runtime/test/handler-code.test.ts`

```ts
import './setup.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { codeOfRecord, codeOfCrystal } from '../src/handler-code.js';
import { createApp } from '../src/app.js';

const connector = { safetyCheck: async () => ({ ok: true }) } as never;
const slime = { handlers: () => [] } as never;

describe('handler code', () => {
  test('a stored record in the current form joins its SQL steps', () => {
    const code = codeOfRecord({ key: 'k', tier: 'liquid', artifact: { steps: [{ name: 'a', source: 'postgres', sql: 'SELECT 1', params: [] }, { name: 'b', source: 'films', operation: 'list' }, { name: 'c', source: 'postgres', sql: 'SELECT 2', params: [] }], shapeJs: '(r) => r', assumptions: ['x'] } });
    assert.deepEqual(code, { key: 'k', tier: 'liquid', sql: 'SELECT 1;\n\nSELECT 2', shapeJs: '(r) => r', assumptions: ['x'] });
  });

  test('a legacy single-query record', () => {
    assert.deepEqual(codeOfRecord({ key: 'k', tier: 'gas', artifact: { sql: 'SELECT 3' } }), { key: 'k', tier: 'gas', sql: 'SELECT 3', assumptions: [] });
  });

  test('a Crystal', () => {
    assert.deepEqual(codeOfCrystal('k', { sql: 'SELECT 4', shape: '(r) => r' } as never), { key: 'k', tier: 'crystal', sql: 'SELECT 4', shapeJs: '(r) => r', assumptions: [] });
  });

  test('GET /v0/handlers/:key/code answers 200 or 404', async () => {
    const app = createApp({ slime, connector, handlerCode: async (key) => (key === 'k' ? { key, tier: 'gas', sql: 'SELECT 1', assumptions: [] } : undefined) });
    const ok = await app.request('/v0/handlers/k/code');
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { sql: string }).sql, 'SELECT 1');
    const missing = await app.request('/v0/handlers/nope/code');
    assert.equal(missing.status, 404);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'HANDLER_NOT_FOUND');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform/runtime && node --import tsx --test test/handler-code.test.ts`
Expected: FAIL — cannot find module `../src/handler-code.js`.

- [ ] **Step 3: Write `platform/runtime/src/handler-code.ts`**

```ts
// The code behind a handler, for the Requests log's trace drawer (request trace design T6).
// Hits load it here; generations already carry it in their feed event.
import type { CrystalHandler } from '@slime-cloud/core';

export interface HandlerCode {
  key: string;
  tier: 'gas' | 'liquid' | 'crystal';
  sql: string;
  shapeJs?: string;
  assumptions: string[];
}

interface StoredArtifact {
  steps?: { sql?: unknown }[];
  sql?: unknown;
  shapeJs?: unknown;
  assumptions?: unknown;
}

const joinSql = (steps: { sql?: unknown }[]) => steps.flatMap((s) => (typeof s.sql === 'string' ? [s.sql] : [])).join(';\n\n');

export function codeOfRecord(record: { key: string; tier: 'gas' | 'liquid'; artifact: StoredArtifact }): HandlerCode {
  const { artifact } = record;
  const sql = Array.isArray(artifact.steps) ? joinSql(artifact.steps) : typeof artifact.sql === 'string' ? artifact.sql : '';
  return {
    key: record.key,
    tier: record.tier,
    sql,
    ...(typeof artifact.shapeJs === 'string' && artifact.shapeJs ? { shapeJs: artifact.shapeJs } : {}),
    assumptions: Array.isArray(artifact.assumptions) ? artifact.assumptions.filter((a): a is string => typeof a === 'string') : [],
  };
}

export function codeOfCrystal(key: string, crystal: CrystalHandler): HandlerCode {
  const c = crystal as { sql?: unknown; steps?: { sql?: unknown }[]; shape?: unknown };
  const sql = Array.isArray(c.steps) ? joinSql(c.steps) : typeof c.sql === 'string' ? c.sql : '';
  return { key, tier: 'crystal', sql, ...(typeof c.shape === 'string' ? { shapeJs: c.shape } : {}), assumptions: [] };
}
```

- [ ] **Step 4: Route in `app.ts`** — add `handlerCode?: (key: string) => Promise<HandlerCode | undefined>` to `RuntimeParts` (documented like its neighbours) and, next to `/v0/handlers`:

```ts
  if (handlerCode) {
    app.get('/v0/handlers/:key/code', async (c) => {
      const code = await handlerCode(c.req.param('key'));
      if (!code) throw new SlimeError('HANDLER_NOT_FOUND', 'No handler with this key on this instance or in the store.');
      return c.json(code);
    });
  }
```

- [ ] **Step 5: Implement in `endpoint-runtime.ts`** — where the `createApp` parts are assembled, add:

```ts
    handlerCode: async (key) => {
      const crystalHandler = crystal && Object.hasOwn(crystal, key) ? crystal[key] : undefined;
      if (crystalHandler) return codeOfCrystal(key, crystalHandler);
      const live = slimeInternals(slime).liveRecords().find((r) => r.key === key);
      if (live) return codeOfRecord(live as never);
      const saved = store ? ((await store.get(HANDLERS_NS, key)) as Parameters<typeof codeOfRecord>[0] | undefined) : undefined;
      return saved ? codeOfRecord(saved) : undefined;
    },
```

Use the variable names this file already has for the Crystal registry and store; import `slimeInternals` from `@slime-cloud/core/tooling` (check the export name in `core/src/tooling.ts`). The `HANDLERS_NS` constant already exists in this file.

- [ ] **Step 6: Run the runtime suite and typecheck**

Run: `cd platform/runtime && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add platform/runtime/src/handler-code.ts platform/runtime/src/app.ts platform/runtime/src/endpoint-runtime.ts platform/runtime/test/handler-code.test.ts
git commit -m "feat(runtime): GET /v0/handlers/:key/code for the trace drawer

A hit's feed event carries no code; the drawer loads it from the Crystal,
this instance's live record, or the store."
```

---

### Task 5: admin trace model

**Files:**
- Create: `platform/admin/lib/request-trace.ts`
- Modify: `platform/admin/lib/lifecycle.ts` (`RuntimeEvent` fields; `readHandlerCode`)
- Test: `platform/admin/test/request-trace.test.ts`

**Interfaces:**
- Consumes: the runtime event JSON (Task 3) and `GET /v0/handlers/:key/code` (Task 4).
- Produces (all exported from `lib/request-trace.ts`):
  - `LAYERS: { id: LayerId; name: string; guard: string }[]` — 12 entries in the global order.
  - `type RowStatus = 'pass' | 'skip' | 'stop' | 'pending' | 'unreached' | 'unknown'`.
  - `interface TraceRow { id: LayerId; name: string; guard: string; status: RowStatus; ms?: number; note?: string; attempts: { attempt: number; status: RowStatus; note?: string }[] }`.
  - `traceRows(event: RuntimeEvent): TraceRow[] | null` — `null` when the event has no `trace` (old event).
  - `verdictOf(event: RuntimeEvent, rows: TraceRow[] | null): { ok: boolean; passed: number; skipped: number; stopAt?: LayerId; code?: string }`.
  - `routeOf(event: RuntimeEvent, rows: TraceRow[]): { lit: NodeId[]; stop?: NodeId; background: NodeId[]; tier?: Tier }` with `type NodeId = 'app' | 'edge' | 'router' | 'crystal' | 'cache' | 'gen' | 'guard' | 'db' | 'exec' | 'review' | 'shape' | 'out' | 'answer'`.
  - `waterfallOf(event: RuntimeEvent): { label: string; start: number; ms: number; kind: 'pass' | 'stop' | 'skip' | 'background' }[]`.
- Produces (`lib/lifecycle.ts`): `RuntimeEvent` gains optional `status`, `code`, `stopAt`, `intent`, `inputs`, `trace`, `generated`; `tier` and `cache` become optional. `readHandlerCode(ep: Endpoint, key: string): Promise<HandlerCode | null>`; `HandlerCode` as in Task 4.

Rules:
- Row status = the **last** span for that layer (attempts included). `attempts` lists every span with an `attempt` for that layer, in order, when there is more than one distinct attempt.
- A layer with no span: `unreached` when `event.stopAt` is set and the layer comes after `stopAt` in `LAYERS`; else `skip` with note `not on this route`.
- Unknown span `status` or `layer` strings → the row status `unknown` (unknown layers are ignored).
- `verdictOf`: `ok` = `event.code` is absent and `(event.status ?? 200) < 400`; `passed`/`skipped` count rows.
- `routeOf().lit` is always ordered as `app, edge, router, crystal, cache, gen, guard, exec, db, shape, out, answer` (filtered). It lights: `app` always, `edge`, `router` when they passed; `crystal` when `event.route === 'crystal'` or the route note starts with `Crystal ` (no `failed`); `cache` when the route note contains `cache hit`; `gen` when `generate` passed or was skipped with `ms` (joined); `guard` when `lint` or `cost` passed on the last attempt; `exec`+`db` when `execute` passed; `shape` when `shape` passed; `out` when `output` passed; `answer` when ok. `stop` = the node of `stopAt` (`edge`→edge, `key`/`route`→router, `limits`/`generate`→gen, `lint`/`cost`→guard, `execute`→exec, `shape`→shape, `output`→out). `background` = `['review']` when the review row is `pending`, plus `cache` on a miss. `tier` = `event.tier`.
- `waterfallOf`: one bar per span in trace order except `cache` and `review`; `start` = sum of previous bars' `ms` (missing `ms` = 0); `kind` = `stop` for stop spans, `skip` for skip spans, else `pass`; label `layer` or `layer · attempt N`. A `review` span with status `pending` appends `{ label: 'review (background)', kind: 'background', ms: 0 }` at the end.
- Guard captions (core defaults, `core/src/config/defaults.ts`): edge `API key · body ≤ 16 KB`; key `intent · input types · output shape → key`; route `Crystal → cache → in-flight → generate`; limits `≤ 200 / hour · ≤ 2 concurrent`; generate `model writes steps + shape · ≤ 1 repair · 25 s`; lint `read-only SQL · $n → input · no literals · ≤ 4 steps`; cost `EXPLAIN cost ≤ 1,000,000`; execute `read-only DB user · 2 s statement · row cap 1,000`; shape `QuickJS · 32 MiB · 200 ms`; output `matches output shape · ≤ input.limit`; cache `Gas 1 h · 3 runs → Liquid`; review `background · ≤ 2 reviews`. Names: Edge, Parse & key, Route, Generation limits, Generate, Lint, Cost check, Execute, Shape in QuickJS, Output check, Cache, Review.

- [ ] **Step 1: Write the failing test** — `platform/admin/test/request-trace.test.ts`. Build seven events mirroring the mockup's `REQUESTS` (r1 miss with a repaired attempt, r2 coalesced, r3 WRITE_REFUSED at lint, r4 Liquid hit, r5 Crystal, r6 QUERY_TOO_EXPENSIVE at cost on two attempts, r7 GENERATION_RATE_LIMITED at limits) plus one old event without `trace`. Assert at least:

```ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LAYERS, routeOf, traceRows, verdictOf, waterfallOf } from '../lib/request-trace';
import type { RuntimeEvent } from '../lib/lifecycle';

const span = (layer: string, status: string, extra: Record<string, unknown> = {}) => ({ layer, status, ...extra });
const MISS: RuntimeEvent = {
  at: '2026-11-22T14:32:08.412Z', handlerKey: 'a3f9c1e07d', tier: 'gas', cache: 'miss', ms: 2214.6, status: 200,
  intent: 'Top customers by revenue', inputs: ['days', 'limit'],
  trace: [span('edge', 'pass'), span('key', 'pass'), span('route', 'pass', { note: 'cache miss → generate' }), span('limits', 'pass'),
    span('generate', 'pass', { attempt: 1, ms: 1000 }), span('lint', 'stop', { attempt: 1, note: 'INVALID_HANDLER: copies an input value' }),
    span('generate', 'pass', { attempt: 2, ms: 1049 }), span('lint', 'pass', { attempt: 2 }), span('cost', 'pass', { attempt: 2 }),
    span('execute', 'pass', { attempt: 2, ms: 121 }), span('shape', 'pass', { attempt: 2, ms: 3 }), span('output', 'pass', { attempt: 2 }),
    span('cache', 'pass'), span('review', 'pending')] as RuntimeEvent['trace'],
  generated: { sql: 'SELECT 1', assumptions: [] },
};
const REFUSED: RuntimeEvent = {
  at: '2026-11-22T14:31:52.077Z', handlerKey: '7be2104a9c', ms: 1318, status: 403, code: 'WRITE_REFUSED', stopAt: 'lint',
  trace: [span('edge', 'pass'), span('key', 'pass'), span('route', 'pass'), span('limits', 'pass'), span('generate', 'pass', { attempt: 1 }), span('lint', 'stop', { attempt: 1 })] as RuntimeEvent['trace'],
};

describe('traceRows', () => {
  test('12 rows in the fixed order', () => {
    assert.deepEqual(traceRows(MISS)!.map((r) => r.id), LAYERS.map((l) => l.id));
    assert.equal(LAYERS.length, 12);
  });
  test('the last attempt decides a row; earlier attempts are kept', () => {
    const lint = traceRows(MISS)!.find((r) => r.id === 'lint')!;
    assert.equal(lint.status, 'pass');
    assert.deepEqual(lint.attempts.map((a) => [a.attempt, a.status]), [[1, 'stop'], [2, 'pass']]);
  });
  test('layers after the stop are unreached', () => {
    const rows = traceRows(REFUSED)!;
    assert.equal(rows.find((r) => r.id === 'lint')!.status, 'stop');
    assert.deepEqual(rows.filter((r) => r.status === 'unreached').map((r) => r.id), ['cost', 'execute', 'shape', 'output', 'cache', 'review']);
  });
  test('an old event without a trace gives null', () => {
    assert.equal(traceRows({ at: 'x', handlerKey: 'k', tier: 'gas', cache: 'hit', ms: 1 }), null);
  });
  test('an unknown status renders as unknown', () => {
    const rows = traceRows({ ...MISS, trace: [span('key', 'teleported')] as RuntimeEvent['trace'] })!;
    assert.equal(rows.find((r) => r.id === 'key')!.status, 'unknown');
  });
});

describe('verdictOf / routeOf / waterfallOf', () => {
  test('a refusal names its layer and code', () => {
    assert.deepEqual(verdictOf(REFUSED, traceRows(REFUSED)), { ok: false, passed: 5, skipped: 0, stopAt: 'lint', code: 'WRITE_REFUSED' });
  });
  test('a refusal at lint lights the path up to gen and stops at guard', () => {
    const route = routeOf(REFUSED, traceRows(REFUSED)!);
    assert.deepEqual(route.lit, ['app', 'edge', 'router', 'gen']);
    assert.equal(route.stop, 'guard');
  });
  test('a miss runs through generation, with review in the background', () => {
    const route = routeOf(MISS, traceRows(MISS)!);
    assert.deepEqual(route.lit, ['app', 'edge', 'router', 'gen', 'guard', 'exec', 'db', 'shape', 'out', 'answer']);
    assert.deepEqual(route.background.sort(), ['cache', 'review']);
  });
  test('waterfall bars start where the previous one ended', () => {
    const bars = waterfallOf(MISS);
    const gen2 = bars.find((b) => b.label === 'generate · attempt 2')!;
    assert.equal(gen2.start, 1000);
    assert.equal(bars.at(-1)!.kind, 'background');
  });
});
```

Add cases for the Liquid hit (`cache` lit, `gen` dim), Crystal (`crystal` lit), coalesced (`gen` lit via skipped-with-ms), GENERATION_RATE_LIMITED (`stop` = `gen`, lit `['app','edge','router']`) and an `edge` stop (body too large).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd platform/admin && node --import tsx --test test/request-trace.test.ts`
Expected: FAIL — cannot find module `../lib/request-trace`.

- [ ] **Step 3: Implement `lib/request-trace.ts`** following the rules above (pure functions, no I/O). Update `RuntimeEvent` in `lib/lifecycle.ts`:

```ts
export type LayerId = 'edge' | 'key' | 'route' | 'limits' | 'generate' | 'lint' | 'cost' | 'execute' | 'shape' | 'output' | 'cache' | 'review';

export interface TraceSpan {
  layer: string;
  status: string;
  ms?: number;
  note?: string;
  attempt?: number;
}

export interface RuntimeEvent {
  id?: string;
  at: string;
  handlerKey: string;
  /** Absent on refused requests. */
  tier?: Tier;
  cache?: string;
  ms: number;
  route?: 'crystal';
  /** Absent on events written before traces (all 200). */
  status?: number;
  code?: string;
  stopAt?: LayerId;
  intent?: string;
  inputs?: string[];
  trace?: TraceSpan[];
  generated?: { sql: string; shapeJs?: string; assumptions: string[] };
}
```

(Spans are typed loosely on purpose: a newer runtime may send layers or statuses this admin does not know.)

- [ ] **Step 4: `readHandlerCode` in `lib/lifecycle.ts`** — same token and URL handling as `readRequests` (no cache, no grace):

```ts
export interface HandlerCode {
  key: string;
  tier: Tier;
  sql: string;
  shapeJs?: string;
  assumptions: string[];
}

const HANDLER_KEY = /^[0-9A-Za-z_-]{1,128}$/;

/** Server only: the code behind a handler, for the trace drawer; null when this instance and the store do not have it. */
export async function readHandlerCode(ep: Endpoint, key: string): Promise<HandlerCode | null> {
  if (!HANDLER_KEY.test(key) || !ep.url || (ep.status !== 'ready' && ep.status !== 'updating')) return null;
  const token = await secretStore().get(ep.endpointId, 'SLIME_API_KEY');
  if (!token) return null;
  try {
    const res = await fetch(new URL(`v0/handlers/${encodeURIComponent(key)}/code`, ep.url), {
      headers: { 'x-api-key': token },
      cache: 'no-store',
      signal: AbortSignal.timeout(isCloud() ? 8000 : 3000),
    });
    return res.ok ? ((await res.json()) as HandlerCode) : null;
  } catch {
    return null;
  }
}
```

Test it in `test/lifecycle.test.ts` alongside the `readRequests` tests (same fake-fetch pattern): a key with `/` or `..` never reaches `fetch`; 404 → `null`; 200 → the body.

- [ ] **Step 5: Run the admin suite and typecheck**

Run: `cd platform/admin && npm test && npm run typecheck`
Expected: PASS (the Requests log page still compiles: `e.tier` is now optional — render `—` for a missing tier in `requests/page.tsx` until Task 6 replaces it).

- [ ] **Step 6: Commit**

```bash
git add platform/admin/lib/request-trace.ts platform/admin/lib/lifecycle.ts platform/admin/test/request-trace.test.ts platform/admin/test/lifecycle.test.ts "platform/admin/app/(console)/endpoints/[id]/requests/page.tsx"
git commit -m "feat(admin): request trace model for the Requests log

One feed event becomes 12 layer rows, a verdict, a lit route and a waterfall:
pure functions the three drawer views share."
```

---

### Task 6: admin Requests log drawer

**Files:**
- Modify: `platform/admin/app/(console)/endpoints/[id]/requests/page.tsx` (server: data + pager; table moves to the client component)
- Create: `platform/admin/app/(console)/endpoints/[id]/requests/requests-log.tsx` (`'use client'`: table, selection, keyboard)
- Create: `platform/admin/app/(console)/endpoints/[id]/requests/trace-drawer.tsx` (`'use client'`: header, verdict, tabs)
- Create: `platform/admin/app/(console)/endpoints/[id]/requests/trace-views.tsx` (`'use client'`: `LayersView`, `RouteMapView`, `WaterfallView`)
- Modify: `platform/admin/app/actions.ts` (server action `loadHandlerCode`)
- Modify: `platform/admin/app/globals.css` (drawer styles)
- Test: `platform/admin/e2e/local.spec.ts` (one scenario) — only if the local E2E stack is runnable here; otherwise typecheck + `next build` + a manual check recorded in the report.

**Interfaces:**
- Consumes (Task 5): `traceRows`, `verdictOf`, `routeOf`, `waterfallOf`, `LAYERS`, `RuntimeEvent`, `HandlerCode`, `readHandlerCode`.
- Produces: `loadHandlerCode(endpointId: string, key: string): Promise<HandlerCode | null>` in `app/actions.ts` (calls `requireUser()`, then `getEndpoint(email, endpointId)`; returns `null` when the endpoint is not the user's).

Behaviour (the mockup `docs/architecture/mockups/2026-11-22-request-trace-drawer.html` is the visual reference — reuse its markup structure and port its CSS into `globals.css` with a `trace-` prefix on every class that the admin does not already define; keep the admin's existing `.tier-pill-*`, `.card`, `.section-head` styles):

1. Columns: Time · Handler · Intent · Stage · Cache · Result · Latency. Intent truncates with ellipsis and has a `title`. Result: `✓ <status>` or `✕ <code> · <Layer name>`; missing tier renders the `—` pill (`tier-pill-none` from the mockup).
2. Rows are buttons for the keyboard: the whole row is clickable, `aria-selected` on the open one. Selection is the event `id` (fall back to `at + index` when `id` is absent), stored in React state — `LivePoller`'s `router.refresh()` keeps it.
3. The drawer is fixed on the right, `width: min(600px, 100vw)`, **non-modal** (no scrim); the page gets `margin-right` while it is open; with it open the Handler and Cache columns are hidden and Result shows `✕ <status>` only (mockup `body.drawer-open` rules, scoped to a wrapper class instead of `body`).
4. Keys while open: `Escape` closes; `ArrowDown`/`ArrowUp` select the next/previous row on the current page. Ignore keys when focus is in an input/textarea.
5. Header: `<time> · handler #<6 chars> · <own route | cache <cache>>`, the intent (or `Intent not recorded`), tier pill, total ms, `inputs: a, b` (names only), verdict banner as in the mockup.
6. Tabs **Layers** (default), **Route map**, **Waterfall** — the three mockup variants, driven only by the Task 5 functions. The waterfall has the linear/log switch. The route map draws edges with an SVG overlay measured after layout (mockup `drawEdges`), redrawn on resize.
7. Code: under Generate when `event.generated` exists; otherwise, under Execute, a `Show code` button calls `loadHandlerCode` once per key (cache the result in component state); on `null`, if another event on the page has the same `handlerKey` and `generated`, use that; else show `Code is not available on this instance.`
8. `traceRows(event) === null` → the drawer shows header + `Trace not recorded for this request.` and no tabs.
9. Guard captions are labelled `default limits` once at the top of the Layers view.

- [ ] **Step 1: Server action** in `app/actions.ts`:

```ts
export async function loadHandlerCode(endpointId: string, key: string): Promise<HandlerCode | null> {
  const email = await requireUser();
  const ep = await getEndpoint(email, endpointId);
  if (!ep) return null;
  return readHandlerCode(ep, key);
}
```

(import `readHandlerCode` and `type HandlerCode` from `@/lib/lifecycle`).

- [ ] **Step 2: Page** — `requests/page.tsx` keeps loading (`loadEndpoint`, `readRequests`), the empty/error states, the pager and the retention note exactly as now; it replaces the `<table>` with `<RequestsLog endpointId={id} events={data.events} />`.

- [ ] **Step 3: Components** — write `requests-log.tsx`, `trace-drawer.tsx`, `trace-views.tsx` per the behaviour list, and port the CSS.

- [ ] **Step 4: Verify**

Run: `cd platform/admin && npm test && npm run typecheck && npm run build`
Expected: PASS, build succeeds.

Then, if Docker and the local stack are available (`platform/admin/README.md`, local E2E section), add to `e2e/local.spec.ts` a scenario after an existing one that issues queries: open the endpoint's Requests log, click the first row, expect a dialog-less drawer with the `Layers` tab and a `Parse & key` row, press `ArrowDown`, expect the drawer title to change, press `Escape`, expect it gone. Run the E2E per the README. If the stack is not available, record that in the report and do a manual check with screenshots against the mockup instead.

- [ ] **Step 5: Commit**

```bash
git add platform/admin/app "platform/admin/e2e/local.spec.ts"
git commit -m "feat(admin): request trace drawer in the Requests log

Click a request to see the layers it passed, where it was stopped and the
route it took: Layers, Route map and Waterfall, non-modal so the log stays
browsable."
```

---

### Task 7: docs

**Files:**
- Modify: `platform/admin/README.md` (Requests log: drawer, code loading)
- Modify: `docs/README.md` (index the design, plan and mockup with status)
- Modify: `docs/architecture/2026-11-21-endpoint-lifecycle-tab-design.md` (one line under L23: the feed now carries traces and refusals; see the request trace design)
- Modify: `docs/architecture/2026-11-22-request-trace-drawer-design.md` (Status → `Built on feat/request-trace-drawer (2026-11-22)`; record any deviation made during implementation)

- [ ] **Step 1: Update the four files** with the facts as built (verify each claim against the code: route names, field names, limits).
- [ ] **Step 2: Run pre-commit on them**

Run: `pre-commit run --files platform/admin/README.md docs/README.md docs/architecture/2026-11-21-endpoint-lifecycle-tab-design.md docs/architecture/2026-11-22-request-trace-drawer-design.md`
Expected: Passed.

- [ ] **Step 3: Commit**

```bash
git add platform/admin/README.md docs/README.md docs/architecture/2026-11-21-endpoint-lifecycle-tab-design.md docs/architecture/2026-11-22-request-trace-drawer-design.md
git commit -m "docs: request trace drawer as built"
```
