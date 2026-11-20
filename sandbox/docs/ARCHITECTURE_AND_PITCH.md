# Slime sandbox: architecture

This describes what the prototype in `sandbox/` actually does. The broader
vision is in [../../docs/slime_runtime_master_spec.md](../../docs/slime_runtime_master_spec.md).

## Request flow

1. `POST /v0/query` receives `{ intent, input, output }`.
2. **Crystal check.** If a Crystal module matches the request fingerprint and
   the current schema, Slime runs its SQL as the read-only user and calls its
   `shape` function directly, with no worker. Done.
3. **Cache key.** Slime computes the key from:
   * the normalized intent;
   * the output shape;
   * the input key names and types;
   * the schema hash, prompt hash and model.
4. **Cache hit** (Gas or Liquid). Slime runs the cached SQL with the new input
   values and shapes the rows in a QuickJS worker thread. No model call is
   made.
5. **Miss.** Identical requests already in flight wait for the same
   generation. Otherwise Slime takes these steps:
   1. The model (Groq, Claude, or the offline handlers file) returns
      `{ sql, params, shapeJs, assumptions }` as structured output. It sees
      the schema, the intent and the input key names and types, never input
      values or rows.
   2. Lint checks the code.
   3. Slime runs `EXPLAIN` and checks the cost.
   4. Slime runs the query.
   5. QuickJS shapes the rows.
   6. Slime checks the result against `output`.
   7. Slime caches the handler as Gas and queues a background review.

   If any step fails, the model gets one repair attempt with the error message.

## Tiers

* **Gas:** in memory, in a holding area that expires after `GAS_WINDOW_MS`.
* **Liquid:** `GAS_TO_LIQUID_HITS` successful runs plus an approved background
  review. It is saved in `slime_meta.handlers` and loaded again on restart.
  The saved row holds the code hash, the review result, the run count and the
  recorded inputs.
* **Crystal:** built by `npm run crystallize` from proven Liquid handlers.
  Each one is a plain module in `crystal/`, pinned in a manifest and loaded at
  startup.

How Crystal runs in production is described in
[crystal-deployment.md](crystal-deployment.md).

## Safety boundaries

| What | Where it runs | What limits it |
|---|---|---|
| Generated SQL | Postgres, as `slime_reader` | `SELECT` grants only, read-only transaction, timeouts, row cap |
| Gas and Liquid shaping code | QuickJS in a worker thread | No I/O, 200 ms and 32 MB limits, worker killed on overrun |
| Crystal shaping code | In the server process | Allowlist parse when written and when loaded, equivalence test, kill switch |
| Saved handlers | `slime_meta`, as `slime_writer` | Generated SQL can't see this schema |

## Connectors

[src/connectors/types.ts](../src/connectors/types.ts) defines the contract:

* `describe()`
* `check()`
* `run()`
* `safetyCheck()`

Only Postgres is implemented. Each future source (SQLite, DuckDB for Parquet
and files, old APIs exposed as tables) implements the same calls and enforces
read-only access in its own way.

## Not in this prototype

* Writes.
* Tenancy.
* Authentication on the admin routes.
* Automated Crystal deployment: the scheduled job, the PR bot and the deploy
  pipeline. See [crystal-deployment.md](crystal-deployment.md).
