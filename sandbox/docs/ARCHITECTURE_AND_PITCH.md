# Slime sandbox: architecture

This describes what the prototype in `sandbox/` actually does. The broader
vision is in [../../docs/slime_runtime_master_spec.md](../../docs/slime_runtime_master_spec.md).

## Request flow

1. `POST /v0/query` receives `{ intent, input, output }`.
2. Slime computes the cache key from four things:
   * the normalized intent;
   * the output shape;
   * the input key names and types;
   * the schema hash, prompt hash and model.
3. **Cache hit (Gas or Liquid):** Slime runs the cached SQL with the new input
   values and shapes the rows in QuickJS. No model call is made.
4. **Miss:** identical requests already in flight wait for the same generation.
   Otherwise Slime takes these steps:
   1. Claude returns `{ sql, params, shapeJs, assumptions }` as structured output.
   2. Lint checks it.
   3. Slime runs `EXPLAIN` and checks the cost.
   4. Slime runs the query.
   5. QuickJS shapes the rows.
   6. Slime checks the result against `output`.
   7. Slime caches the handler as Gas.

   If any step fails, Claude gets one repair attempt with the error message.

## Tiers

* **Gas:** holding area, expires after `GAS_WINDOW_MS`.
* **Liquid:** reached `GAS_TO_LIQUID_HITS` requests within the window. Kept.
* **Crystal:** not built yet.

## Connectors

[src/connectors/types.ts](../src/connectors/types.ts) defines the contract:

* `describe()`
* `check()`
* `run()`
* `safetyCheck()`

Only Postgres is implemented. Each future source (SQLite, DuckDB for Parquet and
files, old APIs exposed as tables) implements the same calls and enforces
read-only access in its own way.

## Not in this prototype

* Writes.
* Tenancy.
* A persistent cache (handlers live in memory only).
* Authentication on the admin routes.
* Crystal promotion.
