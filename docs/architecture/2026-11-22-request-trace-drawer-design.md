# Request trace drawer (Requests log): design

* **Status:** Built on feat/request-trace-drawer (2026-11-22)
* **Author:** @Tony (with an agent)
* **Mockup:** [mockups/2026-11-22-request-trace-drawer.html](mockups/2026-11-22-request-trace-drawer.html)
  (static; three variants, all three kept)
* **Plan:** [2026-11-22-request-trace-drawer-plan.md](2026-11-22-request-trace-drawer-plan.md)

## 1. Goal

A developer (a Slime Cloud customer) opens the **Requests log** and, for any
request, sees **which harness layers it passed, where it was stopped and why,
and the route it took** (Crystal, cache hit, joined generation, or new
generation). Facts are measured by the engine, not inferred by the admin.

## 2. Scope

In:

* core records a per-request `trace` of layer spans (`QueryMeta.trace`; on
  failure `SlimeError.trace` and `SlimeError.handlerKey`);
* the runtime feed also records **refused** requests, the intent, input
  **names**, the trace, and the generated code for generations (`cache: miss`);
* `GET /v0/handlers/:key/code` for the code of a hit;
* the admin Requests log: Intent and Result columns; a non-modal drawer with
  three tabs — **Layers**, **Route map**, **Waterfall**.

Out: input values or rows in the feed (unchanged invariant), unauthenticated
requests in the feed, per-endpoint guard limits in the admin (defaults shown),
the Lifecycle tab, review history beyond the current status.

## 3. Decisions

| # | Decision | Why |
|---|---|---|
| T1 | Layers, in order: `edge`, `key`, `route`, `limits`, `generate`, `lint`, `cost`, `execute`, `shape`, `output`, `cache`, `review`. Core emits all but `edge`; the runtime adds `edge`. | The real gates in `core/src/engine` and `platform/runtime/src/app.ts`; one fixed order the three views share. |
| T2 | `LayerSpan { layer, status: pass\|skip\|stop\|pending, ms?, note?, attempt? }`. Generation layers (`generate`…`output`) carry `attempt` (1-based) on a miss. | A repaired attempt stays visible: attempt 1 stopped at lint, attempt 2 passed. |
| T3 | The trace rides on `SlimeError.trace` (own field), never in `details`. | `toJSON()` spreads `details` into the public HTTP error body. |
| T4 | Notes never carry input values or rows: stop notes use the value-free repair text (`repairMessage`), pass notes carry counts, names and limits only. | The feed's existing rule: "No input values or rows". |
| T5 | The feed records requests that passed auth. Refused ones get `status`, `code`, `stopAt`; a body over 16 KB stops at `edge`, invalid JSON at `key`. | A stranger must not be able to write into a customer's feed. |
| T6 | The generated code (`sql`, `shapeJs`, `assumptions`) is stored only on `cache: miss` events; hits load it from `GET /v0/handlers/:key/code` (Crystal → live record on this instance → store). | Keeps 500 feed entries light; Gas lives in one instance's memory (L23), so the miss entry is the reliable copy for Gas. |
| T7 | The drawer is non-modal: the log stays clickable, `↑/↓` move between rows, `Esc` closes. With it open the log hides Handler and Cache and shortens Result. | Comparing requests one after another is the main use; a modal scrim blocked it in the mockup. |
| T8 | Guard captions show core's **default** limits (`core/src/config/defaults.ts`). | The admin does not know an endpoint's overrides yet; labelled "default limits". |
| T9 | Waterfall offsets are the cumulative sum of span `ms` in trace order; `review` is drawn as background. | The layers on the request path run one after another; no start timestamps are needed. |
| T10 | Events written before this change have no `trace`; the drawer shows the header and "Trace not recorded for this request". | The feed keeps 500 old entries after deploy. |

## 4. Data contract

### core (`core/src/shared/trace.ts`, `core/src/engine/trace.ts`)

```ts
export type LayerId = 'edge' | 'key' | 'route' | 'limits' | 'generate' | 'lint' | 'cost' | 'execute' | 'shape' | 'output' | 'cache' | 'review';
export type LayerStatus = 'pass' | 'skip' | 'stop' | 'pending';
export interface LayerSpan { layer: LayerId; status: LayerStatus; ms?: number; note?: string; attempt?: number }
QueryMeta.trace: LayerSpan[]
SlimeError.trace?: LayerSpan[]; SlimeError.handlerKey?: string
```

Error code → stop layer (`layerOfError`): `INVALID_REQUEST`→key,
`GENERATION_RATE_LIMITED`→limits, `GENERATION_FAILED`/`GENERATION_TIMEOUT`/
`INTENT_UNSATISFIABLE`→generate, `WRITE_REFUSED`→generate when
`details.enforcedBy === 'model'` else lint, `INVALID_HANDLER`→lint (output
when R6), `QUERY_TOO_LARGE`/`QUERY_TOO_EXPENSIVE`→cost, `QUERY_ERROR`/
`EXECUTION_TIMEOUT`/`SOURCE_ERROR`/`ACCESS_DENIED`→execute,
`SANDBOX_ERROR`→shape, `SHAPE_MISMATCH`→output, `HANDLER_NOT_FOUND`→route.

### runtime feed (`RequestEvent`, all new fields optional)

```ts
status?: number            // absent = 200 (old events)
code?: string; stopAt?: LayerId
intent?: string            // first 200 characters
inputs?: string[]          // input names, sorted
trace?: LayerSpan[]
generated?: { sql: string; shapeJs?: string; assumptions: string[] } // cache 'miss' only
tier?, cache?              // absent on refused requests
```

### admin (`platform/admin/lib/request-trace.ts`)

`traceRows(event) → TraceRow[]` (12 rows, fixed order) with status
`pass|skip|stop|pending|unreached|unknown`, the guard caption, ms, note, and
earlier attempts; `verdictOf(event)`; `routeOf(rows)` for the map;
`waterfallOf(event)` for the timeline. All pure and unit-tested.

## 5. UI

Requests log columns: Time · Handler · Intent · Stage · Cache · Result ·
Latency. Result is `✓ 200` or `✕ <CODE> · <Layer>`. A click opens the drawer:
header (time, handler, route, intent, tier pill, total, input names, rows),
verdict banner (`✓ Answered · passed N layers` / `✕ Stopped at <Layer> —
<CODE>`), tabs:

* **Layers** — vertical checklist (mockup variant A); the generate row lists
  earlier attempts; the code opens under Generate (miss) or Execute (hit,
  lazily loaded).
* **Route map** — the endpoint's nodes with this request's path lit, the stop
  node red, background review dashed (variant B).
* **Waterfall** — spans with a linear/log switch (variant C).

The drawer keeps its selection across the 2 s `LivePoller` refresh (it is
keyed by event id).

## 6. Error handling

* The feed never fails a request (existing rule); building the trace never
  throws past the engine's own error.
* An unknown layer id or status from a newer runtime renders as `unknown`.
* Code loading failure shows "Code is not available on this instance" and,
  when the page holds the miss event of the same key, uses its code.

## 7. Testing

* core: `Trace` unit tests; engine tests for every route (miss with repair,
  coalesced, hit, Crystal, Crystal fallback) and every stop layer (limits,
  generate/model refusal, lint, cost, execute, shape, output) — the error
  carries `trace` and `handlerKey`, `toJSON()` unchanged.
* runtime: feed records successes and refusals with the new fields; values
  never appear; body > 16 KB and invalid JSON; `/v0/handlers/:key/code`.
* admin: `request-trace.ts` unit tests over the seven mockup scenarios and an
  old event; `readHandlerCode`; typecheck and `next build`.

## 8. As built: deviations from this design

* **Unknown layer ids are dropped, not shown.** §6 says an unknown layer id
  renders as `unknown`; `traceRows` keeps the fixed 12 rows and ignores spans
  for layers it does not know. An unknown *status* still renders as `unknown`.
* **Handler code uses core's SQL format.** `/v0/handlers/:key/code` formats
  SQL with `sqlOf()` (now exported from `@slime-cloud/core/tooling`), the
  same `-- step <name>` form a miss event carries, so a hit and a miss of one
  handler show identical code.
* **Show code under Execute** appears when Execute ran (passed or stopped),
  so a failing cached query still shows its SQL.
* **Crystal drift fallback** passes the Crystal route note into generation, so
  the route span reads `Crystal failed (<CODE>) → …` followed by the cache/generation route.
* The drawer is `role="complementary"` (non-modal); the route map lives in
  `route-map.tsx` beside `trace-views.tsx`.
* The local E2E scenario in `platform/admin/e2e/local.spec.ts` is written but
  was not run during implementation (no local stack); the drawer was checked
  with screenshots against the mockup.
