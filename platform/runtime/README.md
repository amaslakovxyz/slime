# @slime-cloud/runtime

Slime Cloud's hosted runtime: `@slime-cloud/core` on AWS Lambda. One function,
`slime-runtime`, serves every endpoint under `/ep/<endpoint id>/` on its
Function URL, with Liquid handlers in DynamoDB and Crystals in S3. Deployed by
[`platform/infra/platform`](../infra/README.md#platform-slime-runtime). The
same endpoint composition runs locally, one process per endpoint, started by
the admin's local runner.

**Boundary:** this package imports the core; the core never imports this
package or anything AWS-specific (CI checks `core/src`).

## How the core is consumed

`package.json` depends on `"@slime-cloud/core": "file:../../core"`.
The link resolves to the core's built `dist/`, so build the core first. Its own
dependencies come from the root workspace. When the package is published,
replace the `file:` path with a version; nothing else changes.

| File | Role |
|---|---|
| [src/lambda.ts](src/lambda.ts) | Lambda entry: the router. `/ep/<id>/…` with `id` matching `^ep-[0-9a-f]{10}$` (else 404 before any AWS call) → tenant cache → `isAuthorized` on the path with `/ep/<id>` removed → `POST /v0/reload` itself, everything else to the endpoint's app; a capped `flush()` before each response; one JSON log line per request (`endpointId`, `requestId`, `route`, `status`, `ms`). Any other path is 401 |
| [src/tenants.ts](src/tenants.ts) | `TenantCache`: endpoint settings from SSM (`/slime/endpoints/<id>/` over `SLIME_SHARED_SSM_PREFIX` over the Lambda env, plus `SLIME_TENANT_ID`), re-read at most once per `SLIME_TENANT_TTL_MS`; unknown ids cached as missing for the TTL; one engine build per endpoint at a time; at most `SLIME_TENANT_CACHE_MAX` engines, least recently used evicted. A change of `SLIME_API_KEY` or `CRYSTAL_TOKENS` is swapped in place; any other change (or a new Crystal manifest ETag) rebuilds the engine. Never writes `process.env` |
| [src/endpoint-runtime.ts](src/endpoint-runtime.ts) | `endpointRuntime(env, deps)`: one endpoint's config, engine (on the shared QuickJS runner when given), usage meter, live feed, warnings, saved-handler view (stale ones marked), thresholds and Crystallize, wired into the app. `close()` flushes, saves live run counts, then closes the engine. Reads only the env it is given |
| [src/crystal-store.ts](src/crystal-store.ts) | `CrystalStore`. `S3CrystalStore`: loads `manifest.json` and each module, drops one whose SHA-256 differs from the manifest or that fails core's `parseModule`, and serves the rest with their shape as source text (run in QuickJS, never imported); publishes new modules, then the manifest with `If-Match` (or `If-None-Match: *`), a 412 being `CrystallizeConflictError`; removes every object version under `endpoints/<id>/`. `DirCrystalStore`: the local Crystal folder, imported as before |
| [src/config.ts](src/config.ts) | `SlimeConfig` from one endpoint's env, with the same variable names the sandbox runtime read; no `DATABASE_URL` is a `SlimeConfigError`, never a fallback database |
| [src/app.ts](src/app.ts) | One endpoint's HTTP routes on the core's `Slime` API (table below); the Crystal route refuses missing and unknown input names |
| [src/local.ts](src/local.ts) | Local entry: one endpoint as a Node HTTP server on `PORT`; same auth; `POST /v0/reload` is a 204 no-op (the runner restarts the process); flushes before each non-GET response; saves live run counts on SIGTERM; prints `{"fatal": …}` as its last stderr line when it cannot start |
| [src/events.ts](src/events.ts) | The answered requests (handler, tier, cache, ms), paged by event id: `StoredRequests` keeps the newest 500 in the endpoint's store (`events#…` items), shared by every instance, with the usage count as the total; on DynamoDB a page is one key-range Query. `RecentRequests` is the in-memory version (50) |
| [src/auth.ts](src/auth.ts) | `keyMatches` and `isAuthorized`, shared by both entries: the endpoint key opens every route; a Crystal's own token (`CRYSTAL_TOKENS`, JSON `{key: token}`) opens only `POST /v0/e/<its key>` |
| [src/live-runs.ts](src/live-runs.ts) | Copies live Liquid run counts to the store (the core saves a handler only when it turns Liquid): before Crystallize, when an engine closes (shutdown, eviction, replacement), and at most every `SLIME_RUNS_SYNC_MS` (default 60 s) on flush |
| [src/store-dynamodb.ts](src/store-dynamodb.ts) | The core's `SlimeStore` Port on the existing table; one partition per endpoint |
| [src/usage.ts](src/usage.ts) | Daily usage counters (`USAGE#<endpoint>` / `YYYY-MM-DD` in `SLIME_USAGE_TABLE`): requests and latency per tier, generations, LLM tokens, handler snapshot per tier. `USAGE_ATTRIBUTES` lists every attribute written; the runtime role's IAM condition (`platform/infra/platform/runtime.tf`) mirrors it |
| [src/legacy-handlers.ts](src/legacy-handlers.ts), [src/migrate-cli.ts](src/migrate-cli.ts) | One-off copy of the sandbox runtime's handlers into the core's format |
| [scripts/build.mjs](scripts/build.mjs) | Deterministic bundle into `dist/lambda/` (same source, same zip hash), handler `index.handler` |
| `test/canned-handlers.json` | Canned handlers the tests and the local admin E2E use instead of a model |

## Routes

Paths are the endpoint's own; the Lambda serves them under `/ep/<id>/`.

| Route | Key | Answers |
|---|---|---|
| `POST /v0/query` | endpoint `slm_` | Gas, Liquid or Crystal answer |
| `POST /v0/e/<crystal key>` | that Crystal's `slc_` token, or `slm_` | the Crystal's answer; body `{"input": {…}}` with exactly its input names |
| `GET /healthz` | `slm_` | `{ok, database, …stats}`; 503 when the database safety check fails. `?fresh=1` (Lambda): re-read the endpoint's settings first, in the same call |
| `GET /v0/handlers`, `DELETE /v0/handlers/<key>` | `slm_` | live handlers and Crystals; evict one |
| `GET /v0/lifecycle` | `slm_` | saved, live and Crystal rows, thresholds, warnings; `instance: true` on Lambda, where Gas rows are this instance's only |
| `GET /v0/events?limit=&before=&after=` | `slm_` | `{ total, events, hasOlder, hasNewer }`, newest first, the same on every instance: `limit` 1-100 (default 50), `before`/`after` an event's `id` for the older or newer page (not both; anything else is 400); `total` is the endpoint's usage count |

Events now also cover refused requests (`status`, `code`, `stopAt` name the
HTTP status, the error code and the layer that stopped the request), and
carry `intent` (first 200 characters), the input names (never their values)
and the layer `trace` behind `edge` (the host's own span, first). Generations
(`cache: 'miss'`) also carry `generated` (`sql`, `assumptions`, `shapeJs?`),
so a Gas handler's code is visible even from another Lambda instance. Events
written before this change lack all of these fields.
| `POST /v0/crystallize` `{keys}` | `slm_` | crystallize reports; on Lambda the Crystals go to S3 and this instance swaps its engine at once, other instances within the TTL |
| `POST /v0/reload` | `slm_` | 204; on Lambda this instance forgets the endpoint's settings and engine, locally a no-op |

Router answers on Lambda: 404 `ENDPOINT_NOT_FOUND` (malformed id, or no
parameters under its SSM path), 401 `UNAUTHORIZED` (wrong or missing key, or
any path outside `/ep/<id>/`, root `/healthz` included), 503 `NOT_READY` (the
endpoint's engine cannot start, for example an unreachable database or no
`DATABASE_URL`; the message names the cause).

## Commands

```sh
(cd ../.. && npm ci && npm run build -w @slime-cloud/core -w @slime-cloud/crystal) && npm ci
npm run typecheck
npm test              # no AWS; the tenant and Crystallize tests use the demo Postgres
npm run build         # dist/lambda/, zipped by Terraform
```

The demo Postgres is `examples/express`'s (`cd examples/express && npm run db:up`,
`postgres://slime_reader:slime_reader@localhost:54329/slime`, or `DATABASE_URL`).
Tests that need it are skipped when it is down, unless `REQUIRE_DB=1` (CI).

## Settings

**Lambda env** (set by Terraform):

| Variable | Meaning |
|---|---|
| `SLIME_HANDLERS_TABLE` | Liquid handlers, one partition per endpoint |
| `SLIME_USAGE_TABLE` | usage counters (the control table) |
| `SLIME_CRYSTAL_BUCKET` | Crystal modules: `endpoints/<id>/crystal/manifest.json` and `<crystal key>.mjs` |
| `SLIME_SHARED_SSM_PREFIX` | shared settings for every endpoint, for example model keys (`/slime/shared/`) |
| `SLIME_TENANT_CACHE_MAX`, `SLIME_TENANT_TTL_MS` | engines cached per instance (8); how often settings are re-read (30000 ms) |
| `SLIME_MAX_DB_CONNECTIONS` | Postgres pool size per endpoint (2) |
| `SLIME_FLUSH_LIMIT_MS` | how long a response waits for background work (default 5000) |

**Per endpoint**, SSM SecureStrings under `/slime/endpoints/<id>/` (written by
the admin), or the local process env (set by the admin's runner):

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | the read-only database user; required |
| `SLIME_API_KEY` | the endpoint key (`slm_…`) |
| `CRYSTAL_TOKENS` | JSON `{ "<crystal key>": "slc_…" }`: each Crystal's own token for `POST /v0/e/<key>` |
| `SLIME_PROVIDER` | `claude` (default) or `groq` |
| `ANTHROPIC_API_KEY` / `GROQ_API_KEY` | the provider's key (shared prefix on Lambda) |
| `SLIME_MODEL`, `SLIME_EFFORT` | generator model and effort (default `low`) |
| `SLIME_REVIEW`, `SLIME_REVIEW_MODEL`, `SLIME_REVIEW_EFFORT` | `off` skips reviews; reviewer model and effort (default `low`) |
| `SLIME_CRYSTAL` | `off` serves no Crystals (kill switch) |
| `MAX_GENERATIONS_PER_HOUR`, `ROW_CAP`, `STATEMENT_TIMEOUT_MS`, ... | limits and tiers (`src/config.ts` lists them) |
| `CRYSTAL_MIN_RUNS` | runs a Liquid handler needs before Crystallize (default 10); also the engine's `tiers.crystalReadyRuns`, so its `crystalReady` event fires at the same count |

`SLIME_TENANT_ID` is the endpoint id: the router sets it on Lambda, the runner
locally. Local entry only: `PORT` (listen port) and `SLIME_CRYSTAL_DIR` (the
endpoint's Crystal folder; with it set, Crystallize writes there and the
runner's restart loads it).

No longer read: `META_DATABASE_URL`, `SLIME_META_TABLE`, `SLIME_THINKING`,
`SLIME_SSM_PREFIX`.

## Switching a deployed runtime to the core (M7)

1. **Copy the handlers.** The new store keeps items under sort keys
   `handlers#<request key>`. Items the sandbox runtime wrote have no `#`, so
   they are left alone, and the previous deploy can still serve them after a
   rollback. Copy them once before deploying, with credentials that may
   Query, GetItem and PutItem on the table:

   ```sh
   SLIME_HANDLERS_TABLE=slime-handlers SLIME_TENANT_ID=<tenant> npm run migrate -- --dry-run
   SLIME_HANDLERS_TABLE=slime-handlers SLIME_TENANT_ID=<tenant> npm run migrate
   ```

   Keys collide when the sandbox had several versions of one request (other
   input types or scopes); the version with most runs is kept.
2. **Deploy.** `platform/infra/platform` now lets the function Query, GetItem,
   PutItem and DeleteItem (`UpdateItem` is no longer used).
3. **Roll back** by redeploying the previous bundle: it reads the untouched
   sandbox items.

Migrated handlers record the sandbox's scope as their provenance, which never
matches (the sandbox had no dictionary), so each one is generated again on its
next request. Every endpoint generates on a miss; there is no serve-only mode.

## Behavior

* Every endpoint route needs `x-api-key`: the endpoint key, or a Crystal's own
  token on that Crystal's route. An endpoint with no key configured refuses
  everything.
* Endpoints share one Lambda process: its memory (1024 MB), its QuickJS pool,
  and the per-instance state (Gas handlers, the hourly generation cap).
  The live feed is in the store, so it is the same on every instance. Each endpoint keeps its own Postgres pool of at most
  `SLIME_MAX_DB_CONNECTIONS`. Builds and evictions log `rss`.
* Lambda freezes the process after each response, so the router awaits the
  endpoint's `flush()` (store writes, background reviews, usage) for up to
  `SLIME_FLUSH_LIMIT_MS`. A review still running then continues on that
  instance's next invocation; if the instance is retired, it is retried after a
  later run.
* Crystal modules from S3 are data: checked against the manifest's SHA-256,
  parsed and allowlisted by core, and their shape runs in QuickJS with Liquid's
  limits. A Crystal that fails a check is dropped and shown as a Lifecycle
  warning.
