# engine

## Overview

The Slime instance that `createSlime()` returns (PLAN.md §5, §7 M2). A query
is parsed, keyed, answered from a cached or saved handler, or generated on a
miss, then run and checked against `output`.

- `slime-engine.ts`: `SlimeEngine`, which implements `Slime` (`query`,
  `handlers`, `stats`, `evict`, `flush`, `close`).
- `handler-cache.ts`: Gas handlers in memory until `gasWindowMs` ends; saved
  handlers read from the store's `handlers` namespace on a miss.
- `generate.ts`: generation with repairs within `generationBudgetMs`, lint,
  the `maxQueryCost` check and the first run.
- `execute.ts`: runs a handler: SQL through the connector, the shaping
  function in the sandbox, the output check and the R6 limit check.
- `coalescer.ts`: concurrent identical requests share one generation.
- `generation-limits.ts`: `maxGenerationsPerHour` per instance over a fixed
  hour, and `maxConcurrentGenerations` slots.
- `lifecycle.ts`: counts runs and promotes Gas to Liquid (M4 rule), with a
  review first when a reviewer is configured.
- `review-loop.ts`: review, then revise with the reviewer's notes, up to
  `maxReviews` reviews.
- `background.ts`: work off the request path (reviews, store writes);
  `flush()` waits for it.
- `events.ts`: `emitSafely` (a throwing `onEvent` never fails a query) and
  the `generated` and `error` event builders.
- `meta.ts`: builds `meta` for every tier.
- `types.ts`: the public instance API types.

## Interface

`types.ts` defines what `index.ts` re-exports: `Slime`, `QueryResult`,
`QueryMeta`, `QueryTimings`, `HandlerRecord`, `HandlerSummary`,
`SlimeStats`, `Tier`, `StoredTier`, `ReviewStatus`, `CacheOutcome`. The
classes and functions here are internal.

## Invariants

- **Crystal first.** A request whose key is in `config.crystal` is answered
  by that Crystal handler (`../crystal/`), before the cache or generation.
- **Keys.** A handler's key is the request key (`request/key.ts`); its
  provenance is stored inside it (§4.7).
- **Saved handlers.** Explore mode treats a saved handler whose provenance
  changed as a miss. Locked mode serves it as it is.
- **Locked mode never generates.** A miss throws `HANDLER_NOT_FOUND`.
- **Generation.** At most `1 + maxRepairs` attempts, while at least 1 s of
  budget is left; provider rate-limit waits extend the budget.
  `WRITE_REFUSED` and `ACCESS_DENIED` are final. An `unsatisfiable` reason
  that reads like a write becomes `WRITE_REFUSED`.
- **Cached only after it ran.** A generated handler is cached only after its
  first run passed lint, the cost check, the output check and R6.
- **Parameter types.** Every later run checks the input against the
  handler's recorded parameter types (R4).
- **Fixtures.** Up to `fixturesPerHandler` distinct inputs are kept.
- **Rate limits.** Over the hourly cap, a generation fails with
  `GENERATION_RATE_LIMITED` (`retryable: true`). Over the concurrency cap, it
  waits for a slot.
- **`meta`.** `meta.sql`, `shapeJs` and `assumptions` appear only in explore
  mode (R9, R11). Literals in the intent become `meta.warnings` (R7).
- **Events.** `onEvent` gets `generated` for each generation and revision,
  `reviewed` for each review, `promoted` for each promotion, and `error` for
  each failed query or background task.
- **Promotion (M4 rule).** After `gasToLiquidRuns` successful runs, a Gas
  handler is reviewed (one review at a time) and, once approved, promoted to
  Liquid and saved. Without a reviewer it is promoted at once, marked
  `review: 'none'`. A revision passes the same checks on a recorded input and
  starts its runs over; after `maxReviews` rejections the handler stays Gas,
  marked `rejected`. A failed review call is retried after the next run.
- **`flush()`.** It waits for running reviews and store writes, including
  ones they start (C15).
- **`close()`.** It closes the shaping sandbox, the store and the connector.

## Side Effects

- Queries call the connector and run shaping code in worker threads. Reads
  from the store happen on a cache miss; `evict` deletes from it.
- All state (handlers, counters, in-flight generations) belongs to one
  instance.

## Verification

- `test/engine.test.ts`: the M2 cases from PLAN.md §7, with a scripted
  connector and a stub generator (`test/helpers.ts`), no database or model.
