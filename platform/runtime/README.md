# @slime-cloud/runtime

Slime Cloud's hosted runtime: `@slime-cloud/core` running on AWS Lambda, with
reviewed Liquid handlers in DynamoDB. Deployed by
[`platform/infra/platform`](../infra/README.md#platform-slime-runtime) as the
`slime-runtime` function.

**Boundary:** this package imports the core; the core never imports this
package or anything AWS-specific (CI checks `core/src`).

## How the core is consumed

`package.json` depends on `"@slime-cloud/core": "file:../../core"`.
The link resolves to the core's built `dist/`, so build the core first. Its own
dependencies come from the root workspace. When the package is published,
replace the `file:` path with a version; nothing else changes.

| File | Role |
|---|---|
| [src/lambda.ts](src/lambda.ts) | Lambda entry: SSM settings at cold start (comma-separated `SLIME_SSM_PREFIX` paths, later overrides earlier), `x-api-key` auth, lazy `createSlime()` (503 `NOT_READY` and retry), a capped `flush()` (store, reviews, usage) before each response |
| [src/config.ts](src/config.ts) | `SlimeConfig` from env, with the same variable names the sandbox runtime read |
| [src/app.ts](src/app.ts) | HTTP routes on the core's `Slime` API (`/v0/query`, `/healthz`, `/v0/handlers`) |
| [src/store-dynamodb.ts](src/store-dynamodb.ts) | The core's `SlimeStore` Port on the existing table; one partition per tenant |
| [src/usage.ts](src/usage.ts) | Daily usage counters (`USAGE#<tenant>` / `YYYY-MM-DD` in `SLIME_USAGE_TABLE`): requests and latency per tier, generations, LLM tokens, handler snapshot per tier. Set only on provisioned endpoints |
| [src/legacy-handlers.ts](src/legacy-handlers.ts), [src/migrate-cli.ts](src/migrate-cli.ts) | One-off copy of the sandbox runtime's handlers into the core's format |
| [scripts/build.mjs](scripts/build.mjs) | Deterministic bundle into `dist/lambda/` (same source, same zip hash), copied to `dist/layer/slime/` for the Gas layer |
| `offline/handlers.json` | Canned handlers for `SLIME_PROVIDER=offline` |

## Commands

```sh
(cd ../.. && npm ci && npm run build -w @slime-cloud/core) && npm ci
npm run typecheck
npm test              # no AWS, no database
npm run build         # dist/lambda/ and dist/layer/, zipped by Terraform
```

## Settings

SSM parameters under `/slime/runtime/` become env vars at cold start
([infra README](../infra/README.md#platform-slime-runtime)). The names
are the sandbox runtime's, so existing parameters keep working:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | the read-only database user |
| `SLIME_PROVIDER` | `claude` (default), `groq` or `offline` |
| `ANTHROPIC_API_KEY` / `GROQ_API_KEY` | the provider's key |
| `SLIME_MODE` | `locked`: no generation, saved and Crystal handlers only |
| `SLIME_MODEL`, `SLIME_EFFORT` | generator model and effort |
| `SLIME_REVIEW`, `SLIME_REVIEW_MODEL`, `SLIME_REVIEW_EFFORT` | `off` skips reviews; reviewer model and effort |
| `SLIME_CRYSTAL_DIR`, `SLIME_CRYSTAL` | Crystal folder in the bundle (`index.mjs`); `off` turns it off |
| `MAX_GENERATIONS_PER_HOUR`, `ROW_CAP`, `STATEMENT_TIMEOUT_MS`, ... | limits and tiers (`src/config.ts` lists them) |
| `SLIME_FLUSH_LIMIT_MS` | how long a response waits for background work (default 5000) |
| `SLIME_HANDLERS_TABLE`, `SLIME_TENANT_ID` | set by Terraform |

No longer read: `META_DATABASE_URL`, `SLIME_META_TABLE`, `SLIME_THINKING`,
`CRYSTAL_MIN_RUNS` (now `crystallize()`'s `minRuns`), `PORT`.

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

Migrated handlers record the sandbox's scope as their provenance. In locked
mode they are served as they are. In explore mode the provenance doesn't match
(the sandbox had no dictionary), so each one is regenerated on its next
request.

## Behavior

* Every route needs `x-api-key: $SLIME_API_KEY`; with no key configured, every
  request gets 401.
* Lambda freezes the process after each response, so the entry awaits
  `slime.flush()` (store writes and background reviews) for up to
  `SLIME_FLUSH_LIMIT_MS`. A review still running then continues on that
  instance's next invocation; if the instance is retired, it is retried after a
  later run.
