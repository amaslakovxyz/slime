# Slime Cloud MVP on AWS: shared runtime Lambda, hosted admin, Crystals in S3

*   **Author:** amaslakov
*   **Status:** Built; on `main`
*   **Date:** 2026-11-21

--------------------------------------------------------------------------------

## Overview

Slime Cloud runs only on a developer laptop today. The admin (`platform/admin`, Next.js 16) creates endpoints, and a local runner (`platform/admin/scripts/local-runner.ts`) starts one runtime process (`platform/runtime/src/local.ts`) per endpoint. This design moves Slime Cloud onto AWS with as little infrastructure as possible:

- One Lambda function, `slime-runtime`, serves every customer endpoint under `/ep/<endpoint id>/…`.
- A second Lambda function, `slime-admin`, runs the admin behind CloudFront at `admin.amaslakov.com`.
- One DynamoDB table holds accounts and endpoints, and another holds saved handlers. Both tables already exist.
- SSM Parameter Store (AWS's key-value store for settings and secrets) holds each endpoint's secrets.
- S3 holds Crystal modules.

The landing page at `amaslakov.com` gets a button that leads to the admin. The per-endpoint Lambda provisioner that is deployed today is removed.

Terms used in this document:

| Term | Meaning |
|---|---|
| Endpoint | One customer connection: one Postgres database, one API key `slm_…`, many handlers. Identified by `ep-<10 hex>`. |
| Handler | Code that answers one kind of request (`{intent, input, output}`) with read-only SQL plus a JS function that shapes the rows. |
| Gas | A handler the model generated on demand. It lives in the memory of one process for up to 1 hour and has not been reviewed. |
| Liquid | A handler that passed 3 runs and review (or review is off). It is saved in DynamoDB `slime-handlers` and survives restarts. |
| Crystallize | The explicit operator step that freezes a proven Liquid handler (≥ 10 runs) into a Crystal. |
| Crystal | A frozen handler module with its own route `POST /v0/e/<crystal key>`, opened by its own token `slc_…`. It never calls the model. |
| QuickJS | The JavaScript sandbox core uses to run generated shape code with time and memory limits. |
| Tenant | Used here as a synonym for endpoint inside the shared runtime process. |
| LWA | AWS Lambda Web Adapter: a Lambda layer that runs an ordinary HTTP server (here `next start`) inside a Lambda function. |

## The Problem

Nobody outside the author's laptop can use Slime Cloud, and the AWS path that exists has never run.

- **The admin is local only.** `platform/admin/README.md` says "It runs locally." Endpoints are child processes on `localhost:87xx`, Crystals are folders under `.data/`, and secrets default to a JSON file (`SLIME_SECRETS=file`).
- **The AWS pipeline is deployed but unused.** PR #18 shipped this chain: the admin writes `pending` to `slime-control`, the table's stream triggers `slime-provisioner`, and the provisioner creates an IAM role and a Lambda `slime-ep-<id>` per endpoint. On 2026-11-21 `slime-control` was empty, no `/slime/*` SSM parameters existed, and no `slime-ep-*` function existed. The admin was never hosted, so nothing ever wrote to it.
- **The runtime Lambda cannot serve the admin.** `platform/runtime/src/lambda.ts` is built for one tenant:
  - it loads a single SSM prefix into the global `process.env` at cold start (`lambda.ts:40-42`);
  - it builds one `Slime` engine (`lambda.ts:52-93`);
  - it wires none of the routes the Lifecycle tab needs (`/v0/lifecycle`, `/v0/events`, `/v0/crystallize`; `lambda.ts:82`).
- **Crystallize assumes a disk.** Core writes Crystal modules with `fs` into a folder (`core/src/crystallize/crystallize.ts:136-154`), and the runtime loads them with `import()` at startup (`platform/runtime/src/config.ts:109-115`). Lambda has no persistent disk, and its `/tmp` is private to each instance.

The author wants the smallest AWS setup that lets an invited developer do the whole journey in the cloud:

1. open the landing page and click through to the admin;
2. sign in with an invited email;
3. create an endpoint against their own publicly reachable Postgres;
4. paste the agent snippet into their coding agent;
5. watch handlers move Gas → Liquid → Crystal in the Lifecycle tab;
6. call the Crystal route from their app.

Proposed solution:

- **Shared runtime.** One multi-tenant `slime-runtime` replaces per-endpoint functions. It routes on the endpoint id in the path, loads that endpoint's settings from SSM, and caches one engine per endpoint in memory.
- **Admin takes over provisioning.** The admin writes the settings and health-checks the endpoint itself, so the provisioner is no longer needed.
- **Crystals in S3.** Crystal modules live in S3 and run as data inside the QuickJS sandbox.

The cost of this choice:

- **Weaker isolation.** The IAM fence per endpoint is lost: today the provisioner pins each endpoint role to its own DynamoDB partition and SSM path (`platform/provisioner/src/provision.ts:111-148`).
- **One process for all endpoints.** All endpoints share one process and its 1024 MB of memory.
- **Approximate Lifecycle view.** Gas state and the live request feed stay per instance, so the cloud Lifecycle view is approximate.

## Goals

1. **Public entry.** `https://amaslakov.com/` shows a button that links to `https://admin.amaslakov.com/`. The admin login page answers 200 over HTTPS through CloudFront.
2. **Invite-only access.**
   - Sign-up succeeds only for emails listed in the SSM allowlist `/slime/admin/ADMIN_ALLOWED_EMAILS` (compared lower-case).
   - Any other email gets an error and no user record.
   - Sign-in, sign-up, create, settings, Crystallize and delete all work through CloudFront, because they are POST server actions.
3. **Endpoint creation without a deploy.**
   - Creating an endpoint in the cloud admin writes its secrets to SSM and its record to `slime-control`, then health-checks it.
   - Within 30 s of submit, the endpoint shows `ready` with URL `https://<runtime host>/ep/<id>/`, or `failed` with the reason (for example an unreachable database).
   - No Terraform run and no new AWS resource is needed per endpoint.
4. **One runtime Lambda for all endpoints.**
   - `slime-runtime` serves, for every endpoint, the routes `/ep/<id>/v0/query`, `/ep/<id>/v0/e/<crystal key>`, `/ep/<id>/v0/lifecycle`, `/ep/<id>/v0/events`, `/ep/<id>/v0/crystallize` and `/ep/<id>/healthz`, each behind that endpoint's own `slm_` key.
   - An `slc_` token opens only its own Crystal route.
   - An unknown or malformed id answers 404 without any SSM read.
   - Root `/healthz` without a key answers 401, as the CI post-deploy check expects (`.github/workflows/terraform.yml:205-210`).
5. **Tenant safety inside the shared process.**
   - No endpoint setting is ever written to `process.env`.
   - A missing `DATABASE_URL` fails that endpoint closed instead of falling back to the demo database (`config.ts:19,57`).
   - Each cached engine uses at most 2 Postgres connections.
   - The number of cached engines per instance is capped. An evicted engine saves its live run counts, then closes.
6. **Cloud Crystallize.**
   - From the Lifecycle tab, a Liquid handler with ≥ 10 runs and current provenance can be crystallized in the cloud.
   - The Crystal module is stored in S3 under `endpoints/<id>/crystal/`.
   - The module is checked against the manifest SHA-256 before use and executed as data in the QuickJS sandbox. It is never `import()`ed.
   - The Crystal route answers on every warm instance within about 30 s, and at once on the instance that ran Crystallize.
7. **Config changes reach warm instances.** Changing the connector or provider, or deleting the endpoint, takes effect on every warm instance within about 30 s. A deleted endpoint then answers 404.
8. **Clean cutover.**
   - Removed: `platform/provisioner/`, `platform/infra/platform/provisioner.tf`, `gas-layer.tf`, the endpoint permissions boundary, the stream event-source mapping, and their build, CI and doc references.
   - One shared teardown replaces the provisioner's `teardown.ts` and the admin's `local-teardown.ts`.
9. **Tests.**
   - Playwright drives the UI and user flow against the local stack in CI (DynamoDB Local, demo Postgres, offline model). It covers sign-up refusal for a non-invited email, create → `ready`, Gas → Liquid → Crystallize → the Crystal route, and delete.
   - Unit tests cover the tenant router and engine cache with a fake SSM and a fake S3.
   - After each apply, CI checks the infrastructure:
     - the landing button's `href`;
     - admin 200;
     - runtime root 401;
     - unknown endpoint 404;
     - the tables and the bucket exist.
   - CI then runs a cloud Playwright smoke whose scope is fixed in Goal 10.
10. **Honest cloud verification scope.** The cloud smoke runs without a database. It asserts only these steps:
    - sign-in with an allowlisted test user;
    - create → `failed`, with the database reason shown;
    - `/ep/<id>/v0/query` without a key → 401;
    - unknown id → 404;
    - delete removes the record and the SSM parameters.

    Gas → Liquid → Crystal on AWS is **not** verified by automation. The PR states this under Risks.
11. **Deployable from the branch.** The agent can apply the `platform` and `admin` stacks from the feature branch in a documented order. The existing CI apply on merge to `main` then reports no changes.

## Non-Goals

- **Per-endpoint IAM isolation.** One runtime role reads every endpoint's SSM path, handler partition and S3 prefix. This is accepted for an invite-only MVP; per-tenant STS session policies are a later option.
- **Durable Gas and counters across instances.** Gas handlers, live run counts, the live feed and the 200-generations-per-hour cap stay per instance. The cloud Lifecycle view is approximate. Durable counters and quotas in DynamoDB come later.
- **A multi-tenant local runner.** Locally, each endpoint stays one process. Local and cloud share one composition function, not one process model.
- **Crystallize with the optimizer.** Cloud Crystallize moves the Liquid code over unchanged (as local Crystallize does today), and only for the keys the operator picked.
- **A database for cloud tests**, and automated cloud coverage of Gas → Liquid → Crystal (see Goal 10).
- **Custom domains per endpoint, CORS for browser calls, publishable keys, `slime-client`, MCP, `slime uncrystallize`.**
- **A staging environment.** One AWS environment, applied from the branch by the agent and from `main` by CI.
- **Billing, payments and model-spend quotas in code.** An Anthropic workspace spend limit, set by hand, is a prerequisite and not part of this change.

## Open Questions

None. Decisions from the brainstorm and the Goldfish review are recorded in [2026-11-21-cloud-mvp-brief.md](2026-11-21-cloud-mvp-brief.md) (Key Decisions).

## Critical User Journeys (CUJs)

### CUJ 1: Invited developer reaches the admin

*   **Given**: `ADMIN_ALLOWED_EMAILS` contains `dev@example.com`; the visitor has no account.
*   **When**: They open `https://amaslakov.com/`, click **Sign in** in the nav, and sign up with `dev@example.com`.
*   **Then**: The browser lands on `https://admin.amaslakov.com/` with a session cookie. The same sign-up with `other@example.com` shows "This email is not invited" and writes no user item.

### CUJ 2: Create an endpoint in the cloud

*   **Given**: A signed-in invited user and a Postgres reachable from the internet with a read-only role.
*   **When**: They submit **New endpoint** (name, provider, database URL).
*   **Then**:
    - Within 30 s the endpoint page shows `ready`.
    - The page shows URL `https://<runtime host>/ep/<id>/`, the `slm_` key, and the agent snippet.
    - With an unreachable database, it shows `failed` with the database error and offers **Delete**.

### CUJ 3: Gas → Liquid → Crystal in the cloud

*   **Given**: A `ready` endpoint, and an agent sending `{intent, input, output}` to `/ep/<id>/v0/query` with the `slm_` key.
*   **When**:
    - The same request repeats 12 times.
    - The operator clicks **Crystallize** on the Liquid row once it reaches 10/10.
*   **Then**:
    - The row turns Liquid after 3 runs plus review.
    - Crystallize reports `crystallized`.
    - The page reveals an `slc_` token.
    - Within 30 s `POST /ep/<id>/v0/e/<crystal key>` with that token and `{"input":{…}}` answers from the Crystal with `meta.tier = "crystal"`.
    - The same token on `/ep/<id>/v0/query` gets 401.

### CUJ 4: Change the connector, then delete

*   **Given**: A `ready` endpoint with one Crystal.
*   **When**: The operator saves a new database URL, then deletes the endpoint.
*   **Then**:
    - After the save the status returns to `ready` (or `failed` with the reason), and every warm instance uses the new URL within 30 s.
    - After the delete:
      - the control item is gone;
      - the SSM path `/slime/endpoints/<id>/` is empty;
      - the handler partition and the S3 prefix `endpoints/<id>/` are empty;
      - `/ep/<id>/v0/query` answers 404 within 30 s;
      - usage items `USAGE#<id>` remain as billing history.

--------------------------------------------------------------------------------

## Technical Plan (Architecture)

### Target picture

```mermaid
flowchart LR
    subgraph Browser
      L[amaslakov.com landing]
      A[admin.amaslakov.com]
    end
    subgraph AWS eu-central-1
      CFL[CloudFront landing] --> LL[slime-landing Lambda]
      CFA[CloudFront admin<br/>adds x-slime-origin header] --> AL[slime-admin Lambda<br/>Next standalone + LWA]
      AL -->|users, endpoints, usage| CT[(DynamoDB slime-control)]
      AL -->|endpoint secrets, provider| SSM[(SSM /slime/endpoints/&lt;id&gt;/)]
      AL -->|teardown: handlers partition| HT[(DynamoDB slime-handlers)]
      AL -->|teardown: Crystal prefix| S3[(S3 slime-crystals-&lt;account&gt;)]
      AL -->|healthz, lifecycle, events, crystallize, reload<br/>x-api-key slm_| RT
      RT[slime-runtime Lambda<br/>Function URL, auth in app<br/>/ep/&lt;id&gt;/...] -->|settings, TTL re-read| SSM
      RT -->|model keys| SSMS[(SSM /slime/shared/)]
      RT -->|Liquid handlers| HT
      RT -->|usage USAGE#id| CT
      RT -->|Crystal manifest + modules| S3
    end
    L -->|Sign in link| CFA
    Agent[customer agent / app] -->|/ep/&lt;id&gt;/v0/query slm_<br/>/ep/&lt;id&gt;/v0/e/&lt;key&gt; slc_| RT
    RT -->|read-only SQL| PG[(customer Postgres, public)]
```

Removed from today's picture:

- `slime-provisioner` and its DynamoDB stream trigger;
- the `slime-gas` layer;
- the `slime-endpoint-boundary` policy;
- every per-endpoint `slime-ep-*` role and function (none exist);
- the single demo tenant of `slime-runtime` (`SLIME_TENANT_ID=demo`, `/slime/runtime/*`, bundled `/var/task/crystal`).

### Contract 1: runtime routes

All customer and admin traffic goes to the one `slime-runtime` Function URL. `<id>` must match `^ep-[0-9a-f]{10}$`; anything else gets 404 before any AWS call.

| Path (after the Function URL host) | Auth | Answers | State scope |
|---|---|---|---|
| `/ep/<id>/v0/query` POST | endpoint `slm_` key | Gas / Liquid / Crystal answer | Gas: this instance; Liquid: DynamoDB; Crystal: S3 |
| `/ep/<id>/v0/e/<crystal key>` POST | that Crystal's `slc_` token, or the `slm_` key | Crystal answer only; refuses missing/unknown input names (as today) | S3 |
| `/ep/<id>/healthz` GET | `slm_` | `{ok, database, …stats}`, 503 when the DB safety check fails; `?fresh=1` re-reads the endpoint's settings first, in the same call (the admin's check after a change) | per instance |
| `/ep/<id>/v0/handlers` GET, `/ep/<id>/v0/handlers/<key>` DELETE | `slm_` | as today | per instance + DynamoDB |
| `/ep/<id>/v0/lifecycle` GET | `slm_` | live + saved + Crystal rows, thresholds, warnings | merges this instance's Gas with DynamoDB and S3 |
| `/ep/<id>/v0/events` GET | `slm_` | recent requests feed | DynamoDB (`events#` items), total from usage: the same on every instance (since 2026-11-22; was per instance). Read without starting the engine, so it works while the endpoint's database is down (2026-11-24) |
| `/ep/<id>/v0/crystallize` POST `{keys}` | `slm_` | crystallize reports; this instance swaps its engine at once | writes S3 |
| `/ep/<id>/v0/reload` POST (new) | `slm_` | drops this instance's cached settings and engine, so the next request reloads | per instance |
| anything else, including `/healthz` | none possible | 401 `UNAUTHORIZED` | none |

Status codes added by the router:

- 404 `ENDPOINT_NOT_FOUND`: malformed id, or no parameters under its SSM path.
- 401 `UNAUTHORIZED`: wrong or missing key.
- 503 `NOT_READY`: the endpoint's settings exist but its engine cannot start, for example an unreachable database or a missing `DATABASE_URL`. The message names the cause.

`Endpoint.url` in `slime-control` holds `https://<runtime host>/ep/<id>/`, with the trailing slash, because the admin resolves `new URL('v0/…', ep.url)`.

### Contract 2: configuration and secrets

| Name | Writer | Store | Reader | Local equivalent |
|---|---|---|---|---|
| `DATABASE_URL` | admin (create, connector change) | SSM SecureString `/slime/endpoints/<id>/DATABASE_URL` | runtime tenant loader | `.data/secrets.json` → runner env |
| `SLIME_API_KEY` (`slm_…`) | admin (create) | SSM SecureString, same path | runtime auth; admin calls | same |
| `CRYSTAL_TOKENS` (JSON `{key: slc_…}`) | admin (after Crystallize) | SSM SecureString, same path | runtime auth for `/v0/e/<key>` | same |
| `SLIME_PROVIDER` | admin (create, provider change) | SSM SecureString, same path (new); the control item keeps `provider` for display | runtime tenant loader | runner env from the control item |
| `ANTHROPIC_API_KEY`, `GROQ_API_KEY` | human, once | SSM SecureString `/slime/shared/` | runtime (all tenants), re-read with the same TTL | shell env of `npm run local` |
| `SLIME_TENANT_ID` | runtime router (`= <id>`) | none (derived) | config, store, usage | runner env |
| `SLIME_HANDLERS_TABLE`, `SLIME_USAGE_TABLE`, `SLIME_CRYSTAL_BUCKET`, `SLIME_SHARED_SSM_PREFIX`, `SLIME_TENANT_CACHE_MAX` (8), `SLIME_TENANT_TTL_MS` (30000) | Terraform | `slime-runtime` Lambda env | runtime | runner env / defaults |
| `SESSION_SECRET`, `ADMIN_ALLOWED_EMAILS` | human, once | SSM SecureString `/slime/admin/` | admin start script loads them into the admin's own `process.env` (the admin is single-tenant) | `.env.local` |
| `SLIME_SECRETS=ssm`, `SLIME_CONTROL_TABLE`, `SLIME_HANDLERS_TABLE`, `SLIME_CRYSTAL_BUCKET`, `SLIME_RUNTIME_URL`, `SLIME_ORIGIN_SECRET` | Terraform | `slime-admin` Lambda env | admin | `.env.local`; `SLIME_RUNTIME_URL` unset means local mode |

Rules:

- The runtime builds a fresh env object per tenant: Lambda env, then `/slime/shared/*`, then `/slime/endpoints/<id>/*`, then `SLIME_TENANT_ID`. It never writes to `process.env`.
- `slimeConfigFromEnv` no longer falls back to the demo database. A missing `DATABASE_URL` is a startup error for that endpoint only.
- `SLIME_ORIGIN_SECRET` is a random value generated by Terraform. It sits in Terraform state and in the admin Lambda env, which is acceptable because it only proves a request came through CloudFront; it opens no data. Admin sign-in still requires a session.

### Contract 3: endpoint state machine

The status set stays `pending | provisioning | ready | failed | updating | deleting` (`platform/admin/lib/endpoints.ts:16`). Who moves it depends on the mode. Local mode is unchanged: the runner owns transitions. In cloud mode (`SLIME_RUNTIME_URL` set), the admin's server action does the work in the same request.

| Event | Local mode (runner) | Cloud mode (admin, synchronous) |
|---|---|---|
| Create | item `pending` → runner starts process → `ready`+url / `failed` | SSM puts → item `provisioning` with url → `GET <url>healthz` (retry every 1 s up to 20 s) → `ready` / `failed`+error |
| Connector or provider change | item `updating` → runner restarts → `ready` / `failed` | SSM put → item `updating` → `GET <url>healthz?fresh=1` (reload and check in one invocation, so another instance's cache cannot answer) → `ready` / `failed`+error |
| Crystallize | runtime writes the folder → admin issues tokens → `requestRestart` (`updating`) → runner restarts → `ready` | runtime writes S3 and swaps its own engine → admin issues tokens → `POST <url>v0/reload` → status stays `ready`; other instances catch up within the TTL |
| Delete | item `deleting` → runner stops the process, tears down → item removed | item `deleting` → shared teardown (SSM path first, so the endpoint stops serving within one TTL; then handlers partition, S3 prefix) → item removed; any error → `failed`+error, deletable again |
| Interrupted action (admin Lambda timeout or crash) | n/a | item can stay `provisioning`, `updating` or `deleting`. Cloud mode lets **Delete** start from any status, including a `deleting` older than 90 s (the admin timeout is 60 s); the settings page offers **Retry check** (healthz → `ready`/`failed`) |

### Runtime: one Lambda, many endpoints

```mermaid
sequenceDiagram
    participant C as Caller
    participant R as router (lambda.ts)
    participant T as TenantCache
    participant SSM
    participant S3
    participant E as endpointRuntime (per id)
    C->>R: POST /ep/ep-1a2b3c4d5e/v0/query (x-api-key)
    R->>R: id regex, else 404
    R->>T: get(id)
    alt cached and younger than TTL
      T-->>R: entry
    else missing, or TTL passed
      T->>SSM: GetParametersByPath /slime/endpoints/id/ (+ /slime/shared/ if stale)
      T->>S3: HEAD endpoints/id/crystal/manifest.json (ETag)
      alt no parameters
        T-->>R: not found (negative cache for the TTL)
      else fingerprint unchanged
        T-->>R: same entry, TTL renewed
      else new or changed
        T->>S3: GET manifest + modules, check sha256 each
        T->>E: build(env, crystals, shared runner)
        T->>T: old engine: syncLiveRuns, then close
        T-->>R: new entry
      end
    end
    R->>R: isAuthorized(path after /ep/id, key, entry.apiKey, entry.crystalTokens)
    R->>E: app.fetch(request with /ep/id stripped)
    E-->>C: response (after capped flush)
```

- **One composition function.** `endpointRuntime(env, deps)` builds the config, `createSlime`, the usage meter, live-run sync and the Hono app with every route (lifecycle, events, warnings, crystallize). It never reads `process.env`. `local.ts` calls it with `process.env`, so local keeps one process per endpoint. The Lambda `TenantCache` calls it once per endpoint. This removes the reduced app that `lambda.ts:82` builds today.
- **TenantCache.** It holds at most `SLIME_TENANT_CACHE_MAX` (8) engines per instance, evicting the least recently used. Eviction and replacement run `slime.flush()`, then `syncLiveRuns(store, slime.handlers())`, then `slime.close()`, so Liquid progress survives. Concurrent first requests for one id share one build promise, and a failed build is not cached.
- **Change fingerprint, in two parts.** Checked at most once per TTL per endpoint per instance.
  - *Auth part* (`SLIME_API_KEY`, `CRYSTAL_TOKENS`): a change is swapped into the cached entry in place. The engine, its Gas handlers, generation counters and Postgres pool stay. Issuing an `slc_` token or rotating the key therefore costs no rebuild.
  - *Engine part* (`DATABASE_URL`, `SLIME_PROVIDER`, every other endpoint value, the shared values, and the manifest ETag): a change rebuilds the engine. A Crystallize on another instance changes the ETag, so this instance rebuilds and loads the new Crystal registry.
- **Resource bounds.** Each tenant's Postgres pool gets `maxConnections: 2`. All tenants share one QuickJS runner per process, created once and injected into `createSlime` and `crystallize` (core change below). The runtime starts at 1024 MB and logs `process.memoryUsage().rss` with every tenant build and eviction. If peak RSS exceeds about 70 % of the function memory with 8 cached tenants, the function memory is raised in `runtime.tf` (2048 MB as the next step); the cache cap stays at 8.
- **Usage metering.** Metering is on for every tenant (`SLIME_USAGE_TABLE=slime-control`). The runtime role may write only items whose key starts with `USAGE#` and only the usage attributes, the same list the provisioner used to write (`provision.ts:37-53`).
- **Logs.** Every log line is JSON with `endpointId`, `requestId`, `route`, `status`, `ms`, plus `tier` for queries. Boot failures log `endpointId` and the cause.
- **Timeout.** The function timeout rises from 30 s to 60 s, so a Crystallize call fits. Query generation stays capped by `GENERATION_BUDGET_MS` (25 s).

### Crystals in S3, executed in QuickJS

```text
s3://slime-crystals-025772230981/endpoints/<id>/crystal/manifest.json   (core manifest format v1)
s3://slime-crystals-025772230981/endpoints/<id>/crystal/<crystal key>.mjs
```

- **Loading.** The TenantCache reads `manifest.json`, then each listed module. It computes the module's SHA-256 and compares it with the manifest's `sha256`; a mismatch drops that Crystal and adds a Lifecycle warning. It then calls core `parseModule(source)`, which parses the module, checks its structure and runs the allowlist on `shape`. It builds a `CrystalHandler` whose `shape` is the **source string**, plus the manifest's `intent`, `output`, `paramTypes`, `schemaHash` and `review`. Nothing is imported, written to `/tmp` for loading, or evaluated outside QuickJS.
- **Execution (core change).** `runCrystal` takes the engine's runner. When `shape` is a string, it runs it through `runner.run({code, rows, input}, {timeoutMs: shapeTimeoutMs, memoryBytes: shapeMemoryBytes})`, the same path and limits as Liquid in `executeArtifact` (`core/src/engine/execution/execute.ts:29-38`). Function shapes, used by self-hosted apps that import `index.mjs`, keep running in-process as today.
- **Crystallize in the Lambda.**
  1. `POST /ep/<id>/v0/crystallize {keys}` reaches one instance.
  2. It flushes, syncs live runs, and downloads the current manifest and modules into a private work folder `/tmp/slime/<id>/<random>/`. Already-frozen keys then report `already`.
  3. It calls core `crystallize({ connector, store: storeLimitedTo(store, keys), dir: workFolder, minRuns: 10, provenance, runner: shared })` without an optimizer. This moves the unchanged Liquid code and runs the equivalence test on fixtures against the tenant's database, as local Crystallize does today.
  4. It uploads each new `<key>.mjs`, then `manifest.json` with `If-Match: <ETag read in step 2>` (or `If-None-Match: *` when none existed). A concurrent Crystallize that lost the race gets `412`, reported as `failed: another Crystallize finished first, try again`.
  5. It rebuilds its own tenant entry from the work folder, deletes the folder and returns the reports.
- **No optimizer** in the cloud, matching local behaviour (`local.ts:129-136` passes none).
- **Tokens.** After the call returns, the admin issues `slc_` tokens into `CRYSTAL_TOKENS` and calls `/v0/reload`, so the instance that answers next has both the Crystal and its token. Other instances converge within the TTL. Until then a new token can get 401 on an instance that has not refreshed. The Lifecycle tab says "Crystal endpoint active on all instances within 30 s".

### Admin on Lambda

- **Build.**
  - `next.config.ts` sets `output: 'standalone'`, `outputFileTracingRoot` to `platform/admin`, `serverActions.allowedOrigins: ['admin.amaslakov.com']`, and `generateBuildId` returning `ADMIN_SOURCE_HASH`. A git SHA is not used, because the merge commit differs from the branch head.
  - The allowed-origins setting is needed because CloudFront sends the Function URL host as `Host` while the browser sends `Origin: https://admin.amaslakov.com`. Next refuses a server action whose origin matches neither.
  - **Deploy trigger.** Next writes per-build random values (preview-mode keys, the server-actions encryption key), so the admin zip is not reproducible. `ADMIN_SOURCE_HASH` is the deploy trigger instead. It is a SHA-256 over every file under `platform/admin` except `node_modules/`, `.next/`, `dist/`, `.data/`, `test-results/`, `playwright-report/` and `.env*`, plus the build-time `ADMIN_ORIGIN` and the Node major version. `aws_lambda_function.admin.source_code_hash` reads it from `platform/admin/dist/source-hash.txt`. A rebuild with unchanged inputs leaves the function untouched, and no input can be left out because the whole tree is hashed.
  - A build step assembles `platform/admin/dist/lambda/` from:
    - the standalone server;
    - `.next/static` and `public`;
    - `run.sh`, which executes `node start.mjs`;
    - `start.mjs`, which loads `/slime/admin/*` from SSM into `process.env`, then imports `server.js`.
- **Function.**
  - `slime-admin`: Node 22, arm64, 1024 MB, timeout 60 s.
  - Layer: AWS Lambda Web Adapter (arm64, version pinned in `variables.tf`).
  - Env: `AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap`, `PORT=8080`, `AWS_LWA_READINESS_CHECK_PATH=/login`, plus Contract 2's admin variables.
  - Function URL with `auth NONE`, buffered (not streaming).
- **Origin check.** A Next 16 `proxy.ts` (the renamed middleware) refuses with 403 any request whose `x-slime-origin` header is not `SLIME_ORIGIN_SECRET`. Unset, local mode lets every request pass, and cloud mode (`SLIME_RUNTIME_URL` set) refuses everything, so a missed SSM value or env var never exposes the admin on its public Function URL.
- **CloudFront.**
  - One distribution with alias `admin.amaslakov.com`.
  - ACM certificate in us-east-1 through a new `aws.us_east_1` provider alias with the stack's default tags (`Project=slime` lets the CI apply role manage it). DNS validation and an A/AAAA alias go into the existing `amaslakov.com` hosted zone.
  - Origin: the admin Function URL, with custom header `x-slime-origin`, `origin_read_timeout = 60`, HTTPS only.
  - Default behaviour: all methods, `Managed-CachingDisabled`, `Managed-AllViewerExceptHostHeader` (the Function URL rejects a foreign Host), `Managed-SecurityHeadersPolicy`.
  - `/_next/static/*`: GET/HEAD, `Managed-CachingOptimized`.
- **Observability.** `instrumentation.ts` registers OTel only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. It is not set in the cloud.
- **Cloud mode.** `isCloud()` in `lib/env.ts` reads `SLIME_RUNTIME_URL`. When it is set:
  - the actions use the synchronous flows of Contract 3, from a new `lib/cloud-endpoints.ts`;
  - `readLifecycle` uses an 8 s timeout instead of 3 s and drops the "Is `npm run local` up?" copy;
  - delete uses the shared teardown with `SsmSecretStore` and an S3 prefix remover.
- **Invite-only.** `createUser` checks the lower-cased email against `ADMIN_ALLOWED_EMAILS` (comma-separated, lower-cased, trimmed) and throws `NOT_INVITED` otherwise. Unset, local mode leaves sign-up open, and cloud mode invites nobody (fail closed). The login page maps it to "This email is not invited". Existing users can still sign in.
- **Shared teardown.** `lib/teardown.ts` replaces `local-teardown.ts` and the provisioner's `teardown.ts`. Locally it removes, in order: the handlers partition (BatchWrite, with retries), the Crystal folder, the control item, the secrets (the runner treats held secrets as ownership). In the cloud the SSM secrets go first (the shared runtime serves an id exactly as long as its SSM path exists, so access is revoked even if a later step fails), then handlers, every S3 object version, the control item.

  Usage items stay. The local runner calls it in local mode and the delete action calls it in cloud mode.

### Infrastructure (all in the `platform` stack)

| File | Change |
|---|---|
| `versions.tf` | Add `provider "aws" { alias = "us_east_1" }` with the same default tags. Keep the `untagged` alias for exactly one apply, so Terraform can delete the event-source mapping that was created with it; remove it in the cleanup commit. |
| `runtime.tf` | Runtime env per Contract 2 (drop `SLIME_SSM_PREFIX`, `SLIME_TENANT_ID`, `SLIME_CRYSTAL_DIR`), timeout 60. IAM: SSM `GetParametersByPath` on `/slime/endpoints/*` and `/slime/shared/*`; handlers table Query/Get/Put/Delete; `slime-control` `UpdateItem` limited to `USAGE#*` keys and the usage attributes; S3 Get/Put/Delete on `endpoints/*` and `ListBucket` with that prefix. |
| `crystals.tf` (new) | Bucket `slime-crystals-<account>`: public access blocked, SSE-S3, versioning on (keeps overwritten modules recoverable), bucket-owner-enforced ownership, TLS-only policy. |
| `admin.tf` (new) | Admin role (DynamoDB control CRUD + Query; handlers Query + BatchWriteItem; SSM Put/Get/GetByPath/DeleteParameters on `/slime/endpoints/*`, GetByPath on `/slime/admin/*`; S3 List + DeleteObject on `endpoints/*`; logs), log group, function with LWA layer, Function URL, `random_password` origin secret, CloudFront distribution, ACM certificate + validation, Route 53 records. |
| `variables.tf` | Add `admin_domain` (default `admin.amaslakov.com`), `zone_name` (`amaslakov.com`), `lwa_layer_version`. Remove `runtime_tenant_id`. |
| `outputs.tf` | Add `admin_url`, `cloudfront_distribution_id` (post-deploy invalidation), `crystals_bucket`. Keep `runtime_url`. Remove provisioner and layer outputs. |
| `provisioner.tf`, `gas-layer.tf` | Deleted. |
| `control.tf` | Stream disabled (`stream_enabled = false`); header comment rewritten. |
| `build.sh` | Builds core, runtime and admin; no provisioner, no layer. |

**Apply order** (the agent, from the branch, with local admin credentials; recorded in the task record before running):

1. Check that no `slime-ep-*` functions or roles exist and that `slime-control` holds no endpoint items.
2. Create SSM parameters by hand: `/slime/admin/SESSION_SECRET` (random, 48 characters, never printed), `/slime/admin/ADMIN_ALLOWED_EMAILS`, and `/slime/shared/GROQ_API_KEY` or `ANTHROPIC_API_KEY` if Anthropic is used (the user supplies the value).
3. Apply 1: the full change. It deletes the provisioner, the boundary policy and the mapping (still through the `untagged` alias), and creates the bucket, the admin and CloudFront. `aws_lambda_layer_version.gas` has `skip_destroy = true` (`gas-layer.tf:25`), so Terraform only drops it from state. Every `slime-gas` layer version is then deleted by hand with `aws lambda delete-layer-version`, and `aws lambda list-layer-versions --layer-name slime-gas` must return an empty list (Goal 8).
4. Smoke (Goal 10).
5. Commit 2 removes the `untagged` alias. Apply 2 must show no changes.
6. After merge, CI apply on `main` shows no changes, so "Refuse pure deletes" passes.

### Landing

`platform/landing/index.html`: a second nav button, **Sign in**, using the existing `btn btn-soft` style, linking to `https://admin.amaslakov.com/`, next to "See it work". The hero buttons stay. The landing function serves the same file, so no landing infrastructure changes.

### Tests

| Layer | Unit / integration (CI, every push) | Local E2E (CI) | Cloud (post-apply) |
|---|---|---|---|
| core | injected runner is not closed by `engine.close()`; string `shape` runs in QuickJS and an endless recursion fails with the shape timeout; equivalence with a string shape | – | – |
| runtime | router: malformed id → 404 with zero SSM calls; unknown id → 404 and negative cache; wrong key → 401; root `/healthz` → 401; `slc_` opens only `/ep/<id>/v0/e/<its key>`. TenantCache: TTL rebuild on SSM change, unchanged fingerprint keeps the engine, LRU eviction calls sync then close, missing `DATABASE_URL` → 503, tenant settings never appear in `process.env`. S3 Crystal load: sha mismatch dropped. Crystallize: uploads modules then manifest with the ETag condition, 412 reported. Fakes: SSM, S3, DynamoDB (`test/fake-dynamo.ts`), offline model, demo Postgres service. | – | infra check: runtime root 401, unknown endpoint 404 |
| admin | allowlist accepts/refuses; cloud create/update/delete flows against a fake runtime (HTTP) and fake SSM/S3; shared teardown order; `proxy.ts` refuses a missing origin header | Playwright (`platform/admin/e2e/local.spec.ts`) against `npm run local` with DynamoDB Local, demo Postgres, offline provider: not-invited sign-up refused, invited sign-up, create → `ready`, 12 queries, Liquid, Crystallize, Crystal call with `slc_`, delete | Playwright (`e2e/cloud-smoke.spec.ts`): Goal 10 assertions with a CI test user |
| infra | `terraform validate`, tflint, trivy (existing) | – | post-deploy step: landing HTML has `href="https://admin.amaslakov.com/"`; admin `/login` 200 via CloudFront; a POST server action through CloudFront is not 403/5xx; bucket and tables exist |
| landing | existing landing function tests | – | covered by the infra check |

Not covered by automation: the shared-Lambda Gas → Liquid → Crystal path on real AWS (Goal 10). It is covered by the runtime integration tests with fakes and by the local E2E, and stated in the PR's Risks.

## Alternatives Considered

### Alternative A: Keep the per-endpoint Lambda provisioner (already deployed)

*   **Pros**:
    - Already written, tested (`platform/provisioner/test/provision.test.ts`) and deployed.
    - Each endpoint gets its own process, memory and IAM role, pinned to its own DynamoDB partition and SSM path (`provision.ts:111-148`).
    - Config changes retire warm instances through an env bump, so no polling is needed (`reconfigure.ts:60`).
    - The admin–worker contract through `slime-control` is the same one the local runner uses.
*   **Cons**:
    - It creates IAM roles and functions at runtime, so every new endpoint is a privileged AWS operation.
    - Becoming `ready` takes about 10–30 s.
    - Every endpoint has its own cold start.
    - The path has never run end to end.
    - The runtime still needs the Lifecycle and Crystallize routes and S3 Crystals either way.
*   **Reason for Rejection**: Rejected by author: for the MVP, one shared Lambda with no AWS resources per endpoint is the smaller system to operate and reason about. The lost isolation is accepted for invite-only use (Non-Goals). Review dissent (zoom-out lens): run one real endpoint through the provisioner before deleting it.

### Alternative B: Shared Lambda, provisioner kept but disabled

*   **Pros**: Going back to per-endpoint functions later is a configuration change.
*   **Cons**: Dead code, a stream mapping and IAM guard rails that nobody runs. Two execution models to keep consistent in docs and tests.
*   **Reason for Rejection**: Rejected by author: the repository rule is a clean cutover; git history keeps the provisioner.

### Alternative C: OpenNext for the admin

*   **Pros**: Closest to Vercel behaviour: static assets in S3, image optimization, ISR revalidation.
*   **Cons**:
    - Three to four more resources: an assets bucket, an image function, a revalidation queue and table.
    - A new build dependency.
    - The admin uses none of ISR or image optimization; every page is dynamic and behind a session.
*   **Reason for Rejection**: Rejected by author: more resources for features the admin does not use.

### Alternative D: Admin on the bare Function URL, or at `amaslakov.com/admin`

*   **Pros**: The bare URL needs no CloudFront, ACM or DNS. The path option keeps one domain and one distribution.
*   **Cons**:
    - The bare URL is an unstable-looking `*.lambda-url…` host, with no asset caching and no security-headers policy.
    - The path option changes the landing stack and needs Next `basePath: '/admin'`, which touches every link and asset path in the admin.
*   **Reason for Rejection**: Rejected by author: `admin.amaslakov.com` with its own distribution leaves the landing stack untouched.

### Alternative E: CloudFront OAC in front of the admin Function URL (as the landing does)

*   **Pros**: The Function URL is reachable only through CloudFront, with IAM-signed origin requests and no shared secret.
*   **Cons**: For an OAC-protected Function URL, AWS requires the client to send the body's SHA-256 in `x-amz-content-sha256` on POST and PUT. Browsers do not, so every server action fails: login, sign-up, create, Crystallize. The landing allows only GET/HEAD for this reason (`platform/infra/landing/domain.tf:65-67`).
*   **Reason for Rejection**: Rejected in review (5 of 7 lenses): it breaks every admin mutation. It is replaced by a Function URL with `auth NONE`, a CloudFront secret origin header checked in `proxy.ts`, and session auth.

### Alternative F: Open sign-up, or open sign-up with Claude only for allowlisted users

*   **Pros**: No manual invites, and anyone can try the product.
*   **Cons**:
    - Every endpoint spends the shared model keys, and the $15 AWS budget freeze does not cover model spend.
    - The tiered variant needs per-user provider rules in code and UI.
*   **Reason for Rejection**: Rejected by author: token cost and extra code. Invite-only via `ADMIN_ALLOWED_EMAILS`.

### Alternative G: Crystallize stays local-only in v0

*   **Pros**:
    - Matches the calibrated product frame (`docs/product/product_frame_v0_2.md`: "Crystallize is local-only in v0").
    - Removes S3, the Crystal loader and the core change, the riskiest part of this design.
*   **Cons**: The cloud journey stops at Liquid. The product's third state is not demonstrable on AWS.
*   **Reason for Rejection**: Rejected by author: Crystals in S3 are part of the MVP. The product frame and the lifecycle design doc (decision L3) are updated to match.

### Alternative H: Crystal modules loaded with `import()` from `/tmp`

*   **Pros**:
    - No core change: the runtime downloads the folder and imports `index.mjs`, as `config.ts:109-115` does today.
    - No QuickJS cost per call.
*   **Cons**:
    - Crystal code runs on the main thread with no timeout or memory limit (`run-crystal.ts:9-24`), in the process that holds every cached tenant's settings. One heavy Crystal stalls every tenant on the instance.
    - A write to the S3 prefix becomes code execution.
    - Node caches ESM by URL, so each version needs its own folder, and old modules are never unloaded.
*   **Reason for Rejection**: Rejected by author after review: Crystals run as data (`parseModule`) in the shared QuickJS runner, with SHA-256 checks against the manifest.

### Alternative I: A `CONFIG_VERSION` SSM parameter polled every 30 s

*   **Pros**: One cheap `GetParameter` per check instead of `GetParametersByPath`.
*   **Cons**:
    - A second version signal next to the control item's `updatedAt`, and a name close to the provisioner's `SLIME_CONFIG_VERSION`.
    - The admin must order writes ("secrets first, then version"), and forgetting the bump leaves stale config forever.
*   **Reason for Rejection**: Rejected by author after review: TTL re-read of the endpoint's SSM path plus the manifest ETag, `/v0/reload` for the instance the admin talks to, and an in-place swap after Crystallize.

### Alternative J: A database for cloud tests (free-tier Postgres or RDS)

*   **Pros**: The cloud smoke could run Gas → Liquid → Crystallize → the Crystal route on real AWS, proving tenant routing, the cache, S3 and the rebuilds.
*   **Cons**:
    - It adds an external vendor and a secret.
    - RDS costs about $12–15 a month, the whole project budget, and needs VPC decisions.
*   **Reason for Rejection**: Rejected by author: cloud tests run without a database. The scope is fixed in Goal 10, and the gap is stated in the PR's Risks.

### Alternative K: A staging stack

*   **Pros**: Branch applies would not touch the only environment.
*   **Cons**: Twice the resources, a second domain or prefix, and CI changes for a second set of state and roles.
*   **Reason for Rejection**: Rejected by author: one environment. The agent applies from the branch in the documented order, and the CI apply on `main` must then show no changes.

### Alternative L: A separate `platform/infra/admin/` Terraform stack

*   **Pros**:
    - Symmetric with the landing stack.
    - An admin build failure does not block runtime deploys, and runtime plans do not rebuild Next.
*   **Cons**:
    - The admin finds the runtime URL and tables by name through data sources, a hidden dependency.
    - CI applies stacks in a parallel matrix, so a fresh environment races on the first apply.
*   **Reason for Rejection**: Rejected by author: the admin lives in the `platform` stack with explicit references and one apply.

### Alternative M: A multi-tenant local runner (one local process for all endpoints)

*   **Pros**: Local dev would run the same tenant cache and router as the Lambda.
*   **Cons**: It rewrites the local runner and loses per-process crash isolation locally, for code the runtime tests already cover with fakes.
*   **Reason for Rejection**: Rejected in review as unnecessary for the MVP: local and cloud share the `endpointRuntime(env, deps)` composition function instead of a process model.

--------------------------------------------------------------------------------

## Non-Functional Requirements

- **Security.**
  - One runtime role can read every endpoint's secrets, handler partition and Crystal prefix (accepted; see Non-Goals).
  - Tenant settings never enter `process.env`, and a missing `DATABASE_URL` fails closed.
  - Endpoint ids are validated before any AWS call, and unknown ids are negatively cached.
  - Crystal shapes run in QuickJS with Liquid's limits, and modules are checked by SHA-256 against the manifest before parsing.
  - The admin Function URL refuses requests without the CloudFront origin header. Sign-up is invite-only.
  - No secret value is written to Terraform state, except the origin header, which opens no data.
- **Performance.**
  - A warm, cached endpoint adds one map lookup per request.
  - A cold endpoint on an instance costs one SSM `GetParametersByPath`, one S3 HEAD/GET set, the database safety check and schema read (`create-slime.ts:20-23`); expect 1–3 s [INFERENCE]. Implementation logs `tenantBuildMs` so it can be measured.
  - The TTL check costs one SSM call and one S3 HEAD per endpoint per instance every 30 s, well inside the SSM standard throughput of 40 requests per second at MVP scale.
- **Cost.** Every new resource is free when idle:
  - one Lambda function;
  - one CloudFront distribution;
  - one ACM certificate;
  - one S3 bucket;
  - two Route 53 records in the existing zone.

  Model spend is outside the $15 AWS budget, so an Anthropic workspace spend limit is set by hand before inviting anyone.
- **Rollout and rollback.**
  - Rollout follows the apply order in the Technical Plan.
  - Rollback means reverting the PR and applying. The provisioner and layer are recreated from git history. Cloud endpoints keep their SSM secrets and handler partitions (same `tenantId`), but their `url` points at `/ep/<id>/`. Delete and re-create them after a rollback.
  - The S3 bucket keeps versions, so a bad Crystallize can be undone by restoring the previous `manifest.json` version.

--------------------------------------------------------------------------------

### Additional Resources

- [2026-11-21-cloud-mvp-brief.md](2026-11-21-cloud-mvp-brief.md): brainstorm brief with the 14 Goldfish objections and their resolutions.
- `docs/product/product_frame_v0_2.md`: product vocabulary (Gas, Liquid, Crystal, Crystallize).
- `docs/architecture/2026-11-21-endpoint-lifecycle-tab-design.md`: Lifecycle tab and local runner (decisions L1–L23; L20–L23 come from this design).
- `docs/architecture/slime-cloud.html`: current admin + provisioner architecture (superseded by this design).
- `platform/infra/README.md`, `platform/infra/FINOPS.md`: stack rules, CI apply guard, budgets.

### Future Improvements

- **Per-tenant isolation:** STS session policies scoped to `/slime/endpoints/<id>/*` and `dynamodb:LeadingKeys = <id>`, cached with the engine.
- **Durable counters and quotas:** per-endpoint runs, generations and reviews in DynamoDB (atomic ADD), enforced across instances.
- **Shared Gas:** Gas artifacts stored with a 1-hour TTL, so repeat calls on another instance do not regenerate.
- **A database for the cloud smoke**, so Gas → Liquid → Crystal is verified on AWS.
- **Concurrency reservation** for `slime-admin`, so a customer burst cannot starve the admin.

--------------------------------------------------------------------------------

## Detailed Implementation Plan

Work happens in `.worktrees/cloud-mvp` on branch `feat/cloud-mvp`. Commits follow the numbered groups below, one concern each. Nothing is applied to AWS until group 9.

### Target Files to Create/Modify

#### Group 1: core (sandboxed Crystals, injected runner)

##### 1. `core/src/handler/crystal.ts` (Modify)

*   **Type / Scope**: TypeScript types.
*   **Proposed Changes**: `CrystalHandler.shape` becomes `ShapeFunction | string | null`. A string is the source of `function shape(rows, input)` and runs in the sandbox. A function keeps running in-process for apps that import `index.mjs`. Update the doc comment.

##### 2. `core/src/engine/crystal/run-crystal.ts` (Modify)

*   **Type / Scope**: Engine.
*   **Proposed Changes**: `CrystalDeps` gains an optional `runner: SandboxRunner`. When `crystal.shape` is a string, run `runner.run({ code: shape, rows, input }, { timeoutMs: limits.shapeTimeoutMs, memoryBytes: limits.shapeMemoryBytes })`. A missing runner is a programming error and throws. Errors map the same way the Liquid path maps them in `executeArtifact`. The function path is unchanged.

##### 3. `core/src/engine/slime-engine.ts` (Modify)

*   **Type / Scope**: Engine.
*   **Proposed Changes**:
    - `#answerFromCrystal` passes `this.#parts.runner` to `runCrystal`.
    - `close()` closes the runner only when the engine owns it, through a new `ownsRunner` flag in its parts.

##### 4. `core/src/create-slime.ts` (Modify)

*   **Type / Scope**: Startup.
*   **Proposed Changes**: `createSlime(config, options?: { runner?: SandboxRunner })`. With a runner, it is used and not owned. Without one, a new `QuickJSRunner` is created and owned, as today.

##### 5. `core/src/crystallize/crystallize.ts` and `core/src/crystallize/equivalence.ts` (Modify)

*   **Type / Scope**: Crystallize job.
*   **Proposed Changes**:
    - `CrystallizeOptions` gains `runner?: SandboxRunner`. When given, the job uses it and does not close it; otherwise it creates and closes its own, as today.
    - Equivalence passes the runner to `runCrystal` and supports string shapes.

##### 6. `core/src/crystallize/index.ts` (Modify)

*   **Type / Scope**: Package subpath `@slime-cloud/core/crystallize`.
*   **Proposed Changes**: Export `parseModule`, `readManifest`, the `Manifest` and `ManifestEntry` types, and `MANIFEST_FILE`, if they are not exported already. The runtime builds Crystals from S3 with them.

##### 7. `core/src/index.ts` (Modify)

*   **Type / Scope**: Package entry.
*   **Proposed Changes**: Export the `SandboxRunner` type and `QuickJSRunner`, so the runtime can create one shared runner.

##### 8. `core/test/engine/crystal.test.ts` (Create) or the existing Crystal test file (Modify)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    - A string shape returns the same data as the function form.
    - A string shape with endless recursion fails with the shape timeout error, and the process stays responsive.
    - `engine.close()` leaves an injected runner open.
    - Equivalence accepts a string-shape candidate.

##### 9. `core/src/engine/crystal/README.md`, `core/README.md`, `core/src/crystallize/README.md` (Modify)

*   **Type / Scope**: Docs.
*   **Proposed Changes**: Document string shapes running in the sandbox, the injected runner option, and the newly exported helpers.

#### Group 2: runtime (multi-tenant Lambda, S3 Crystals)

##### 10. `platform/runtime/src/endpoint-runtime.ts` (Create)

*   **Type / Scope**: Composition function.
*   **Proposed Changes**: `endpointRuntime(env: Env, deps: { runner?: SandboxRunner; crystalStore?: CrystalStore; onLog?: … }): Promise<EndpointRuntime>`.
    - It holds everything `local.ts` `main()` wires today: config, `createSlime`, `UsageMeter`, `RecentRequests`, warnings with `missingProviderKey`, the saved-handlers view, thresholds, and the crystallize closure.
    - The crystallize closure uses `crystalStore.prepareWork()` / `publish()` when a store is given, or `SLIME_CRYSTAL_DIR` when not.
    - It returns `{ app, slime, flush(), close(), apiKey, crystalTokens, crystalCount }`.
    - `close()` runs flush, `syncLiveRuns`, `slime.close()`, `connector.close()`.
    - It never reads `process.env`.
    - It passes `maxConnections` from `env.SLIME_MAX_DB_CONNECTIONS` (default 2 in Lambda, core default locally).

##### 11. `platform/runtime/src/tenants.ts` (Create)

*   **Type / Scope**: Lambda tenant cache.
*   **Proposed Changes**: `class TenantCache` with `get(id): Promise<Tenant | undefined>`, `reload(id)` and `replace(id, runtime)`.
    - Built from: an SSM client port, the S3 Crystal store, base env, shared SSM prefix, `maxEntries`, `ttlMs`, the shared runner, and a clock (for tests).
    - It implements the fingerprint, TTL, negative cache, single-flight build, LRU eviction with `close()`, and the "failed builds are not cached" rule from the Technical Plan.
    - The env object is built as Lambda env + shared parameters + endpoint parameters + `SLIME_TENANT_ID`, read with `GetParametersByPath` (`WithDecryption`, paginated).
    - Exports `ENDPOINT_ID = /^ep-[0-9a-f]{10}$/`.

##### 12. `platform/runtime/src/crystal-store.ts` (Create)

*   **Type / Scope**: Crystal storage port.
*   **Proposed Changes**: Interface `CrystalStore` with:
    - `load(endpointId): Promise<{ registry: CrystalRegistry; etag?: string; warnings: string[] }>`;
    - `version(endpointId): Promise<string | undefined>` (manifest ETag, or a folder mtime locally);
    - `prepareWork(endpointId): Promise<{ dir; etag? }>`;
    - `publish(endpointId, work): Promise<void>`;
    - `remove(endpointId)`.

    `S3CrystalStore`:
    - **Load:** reads the manifest and modules, checks each SHA-256 against the manifest, runs `parseModule`, and builds `CrystalHandler`s with string shapes. A mismatch or parse error drops that Crystal with a warning.
    - **Publish:** puts new modules first, then the manifest with `IfMatch`/`IfNoneMatch: '*'`. A 412 becomes `CrystallizeConflictError`.
    - **Remove:** deletes every object version under the prefix.

    `DirCrystalStore`: today's folder behaviour (`import(index.mjs)`) for local mode.

##### 13. `platform/runtime/src/lambda.ts` (Rewrite)

*   **Type / Scope**: Lambda entry.
*   **Proposed Changes**:
    - Removed: the cold-start SSM-to-`process.env` load, `envNameFor` (moved into `tenants.ts` as `parameterName`), and the single `boot()`.
    - New Hono router:
      - `/ep/:id/*`: validate the id; `TenantCache.get`; `isAuthorized` on the path with `/ep/<id>` removed; forward to `tenant.app.fetch` with the rewritten URL; capped flush.
      - The router also handles `POST /ep/:id/v0/reload` itself (after auth) through `TenantCache.reload`.
      - Any other path: 401.
    - One JSON log line per request (`endpointId`, `requestId` from the Lambda context, `route`, `status`, `ms`).
    - `export const handler = handle(app)` stays.

##### 14. `platform/runtime/src/local.ts` (Modify)

*   **Type / Scope**: Local entry.
*   **Proposed Changes**:
    - `main()` becomes `endpointRuntime(process.env, { crystalStore: new DirCrystalStore(SLIME_CRYSTAL_DIR) })` plus the existing HTTP server, auth and SIGTERM save.
    - It adds `POST /v0/reload` as a no-op 204, so the admin's cloud and local calls share one route set.
    - `storeLimitedTo` and `toSavedHandler` move to `endpoint-runtime.ts`; their exports stay importable for tests.

##### 15. `platform/runtime/src/config.ts` (Modify)

*   **Type / Scope**: Config mapping.
*   **Proposed Changes**:
    - Remove `DEMO_DATABASE_URL` and the fallback: a missing or empty `DATABASE_URL` throws `SlimeConfigError(['DATABASE_URL is not set'])`.
    - Add `SLIME_MAX_DB_CONNECTIONS`.
    - Crystal loading moves out to `crystal-store.ts`: `slimeConfigFromEnv` takes an optional `crystal` registry argument instead of reading `SLIME_CRYSTAL_DIR`.
    - The `SLIME_CRYSTAL=off` kill switch stays.

##### 16. `platform/runtime/src/auth.ts` (Modify)

*   **Type / Scope**: Auth.
*   **Proposed Changes**: No logic change. The doc comment states that callers pass the path with `/ep/<id>` already removed.

##### 17. `platform/runtime/src/app.ts` (Modify)

*   **Type / Scope**: Routes.
*   **Proposed Changes**:
    - The `RuntimeParts` comments drop "local runtime only": every part is wired in both entries.
    - `/v0/lifecycle` adds `instance: true` to its payload when the feed is per instance, so the admin can label it.
    - Crystal rows read `inputs` from `paramTypes` as today.

##### 18. `platform/runtime/src/usage.ts` (Modify)

*   **Type / Scope**: Usage meter.
*   **Proposed Changes**: The header comment points to `platform/infra/platform/runtime.tf` (`USAGE_ATTRIBUTES` now live in the runtime role's `dynamodb:Attributes` condition) instead of `provision.ts`. Export `USAGE_ATTRIBUTES` as a constant used by a test, so Terraform and code stay in step.

##### 19. `platform/runtime/src/live-runs.ts` (Modify)

*   **Type / Scope**: Run-count sync.
*   **Proposed Changes**: Comment update only. Eviction and replacement now call `syncLiveRuns` (L12 extended).

##### 20. `platform/runtime/scripts/build.mjs` (Modify)

*   **Type / Scope**: Bundle.
*   **Proposed Changes**: Remove the `dist/layer/slime/` copy and its header paragraph. Bundle `@aws-sdk/client-s3` as well.

##### 21. `platform/runtime/package.json` and `package-lock.json` (Modify)

*   **Type / Scope**: Dependencies.
*   **Proposed Changes**: Add `@aws-sdk/client-s3`, matching the existing `@aws-sdk` minor version.

##### 22. `platform/runtime/test/fake-ssm.ts`, `platform/runtime/test/fake-s3.ts` (Create)

*   **Type / Scope**: Test fakes.
*   **Proposed Changes**:
    - `fake-ssm.ts`: an in-memory `GetParametersByPath` with pagination and a call counter.
    - `fake-s3.ts`: Get/Put/Head/List/DeleteObjects with ETags and `IfMatch`/`IfNoneMatch` semantics (412). Both follow the style of `test/fake-dynamo.ts`.

##### 23. `platform/runtime/test/tenants.test.ts` (Create)

*   **Type / Scope**: Integration tests (offline provider, demo Postgres from the CI service, fakes).
*   **Proposed Changes**:
    - malformed id → 404 with 0 SSM calls; unknown id → 404, and a second request in the TTL makes no SSM call;
    - wrong key → 401; root `/healthz` → 401;
    - an `slc_` token opens only `/ep/<id>/v0/e/<its key>`, not `/v0/query`, not another endpoint;
    - changing an SSM value rebuilds after the TTL (fake clock); an unchanged fingerprint keeps the same engine object;
    - the 9th endpoint evicts the least recently used one after `syncLiveRuns` + `close`;
    - missing `DATABASE_URL` → 503 naming the cause;
    - `process.env` has no `DATABASE_URL` or `SLIME_API_KEY` after serving two endpoints;
    - `/v0/reload` forces a fresh SSM read.

##### 24. `platform/runtime/test/crystal-store.test.ts` (Create)

*   **Type / Scope**: Unit tests.
*   **Proposed Changes**:
    - load builds string-shape handlers;
    - a SHA-256 mismatch drops the Crystal with a warning;
    - publish puts modules before the manifest, and the manifest put uses `IfMatch`; a stale ETag → `CrystallizeConflictError`;
    - remove empties the prefix.

    End to end: Liquid handler with 10 runs → `/ep/<id>/v0/crystallize` → S3 holds the module and manifest → the same instance answers `/v0/e/<key>` with `meta.tier = 'crystal'`.

##### 25. `platform/runtime/test/lambda.test.ts`, `local.test.ts`, `startup.test.ts`, `setup.ts`, `usage.test.ts` (Modify)

*   **Type / Scope**: Existing tests.
*   **Proposed Changes**:
    - Drop the `envNameFor('/slime/runtime/…')` case.
    - Add `DATABASE_URL` to `BASE_ENV`, since the fallback is gone, and add a "missing DATABASE_URL throws" case.
    - Local tests use `endpointRuntime` through `local.ts` as before.
    - `setup.ts`: drop `delete process.env.SLIME_SSM_PREFIX` (the variable no longer exists); keep the rest of the setup.
    - `usage.test.ts`: the comment at line 21 points to `platform/infra/platform/runtime.tf` instead of `provision.ts`. The test asserts that every attribute the meter writes is in the exported `USAGE_ATTRIBUTES`.

##### 26. `platform/runtime/README.md` (Modify)

*   **Type / Scope**: Docs.
*   **Proposed Changes**: Rewrite the file map and settings for the multi-tenant router, the tenant cache, the S3 Crystal store and the routes table. Remove the `/slime/runtime/` settings section and the Gas-layer mention.

#### Group 3: admin (cloud mode, invite-only, hosting)

##### 27. `platform/admin/lib/env.ts` (Modify)

*   **Type / Scope**: Config.
*   **Proposed Changes**: Add `runtimeUrl` (`SLIME_RUNTIME_URL`, optional), `handlersTable` (default `slime-handlers`), `crystalBucket` (`SLIME_CRYSTAL_BUCKET`), `allowedEmails` (parsed from `ADMIN_ALLOWED_EMAILS`) and `originSecret` (`SLIME_ORIGIN_SECRET`). `isCloud()` is `Boolean(runtimeUrl)`.

##### 28. `platform/admin/lib/users.ts` (Modify)

*   **Type / Scope**: Accounts.
*   **Proposed Changes**: `createUser` throws `CodedError('NOT_INVITED', 'This email is not invited')` when an allowlist is set and does not contain the email. `checkLogin` is unchanged.

##### 29. `platform/admin/app/login/page.tsx`, `platform/admin/app/actions.ts` (Modify)

*   **Type / Scope**: UI and server actions.
*   **Proposed Changes**:
    - Map `NOT_INVITED` to `?error=invite` with the message "This email is not invited".
    - In cloud mode:
      - `createEndpointAction`, `updateConnectorAction` and `updateSettingsAction` call `cloud-endpoints.ts`;
      - `deleteEndpointAction` runs the shared teardown;
      - `crystallizeAction` issues tokens and then calls `/v0/reload` instead of `requestRestart`.
    - A new `retryCheckAction(endpointId)` runs healthz and sets `ready`/`failed`.

##### 30. `platform/admin/lib/cloud-endpoints.ts` (Create)

*   **Type / Scope**: Cloud state machine (Contract 3).
*   **Proposed Changes**:
    - Functions `provision(owner, id)`, `reconfigure(owner, id)`, `check(owner, id)` and `remove(owner, id)`. The reload after Crystallize is `reloadOn(ep)` in `lib/lifecycle.ts` (`POST <url>v0/reload`).
    - `healthz` retries every 1 s for up to 20 s on 5xx or network errors; `reconfigure` sends one `GET <url>healthz?fresh=1`, which reloads and checks in the same call.
    - Outcome writes reuse the `ready`/`failed` + `error` shape. Errors are capped at 300 characters, as `provisioner/src/outcome.ts` does.
    - All runtime calls send the `slm_` key from the secret store.

##### 31. `platform/admin/lib/endpoints.ts` (Modify)

*   **Type / Scope**: Endpoint records.
*   **Proposed Changes**:
    - `createEndpoint` also writes `SLIME_PROVIDER` to the secret store. In cloud mode it writes the item as `provisioning` with `url = runtimeUrl + 'ep/' + id + '/'`; in local mode it writes `pending` as today.
    - `updateSettings` writes `SLIME_PROVIDER` on provider change.
    - `requestDelete` accepts any status except `deleting` in cloud mode.
    - Remove `layerArn` from `Endpoint`.
    - The header comment describes both modes.

##### 32. `platform/admin/lib/teardown.ts` (Create) and `platform/admin/lib/local-teardown.ts` (Delete)

*   **Type / Scope**: Shared teardown.
*   **Proposed Changes**:
    - `removeEndpoint({ endpointId, owner, handlersTable, crystals: { kind: 'dir', dataDir } | { kind: 's3', bucket }, secrets })`.
    - Order: handlers partition (code moved from `local-teardown.ts`), Crystal storage, control item, secrets.
    - The id regex is checked first.

##### 33. `platform/admin/scripts/local-runner.ts` (Modify)

*   **Type / Scope**: Local runner.
*   **Proposed Changes**: Use `removeEndpoint` from `lib/teardown.ts`. Pass `SLIME_PROVIDER` from the secret store, falling back to the item for old endpoints. Header comment: "local stand-in for the cloud admin flows", no provisioner mention.

##### 34. `platform/admin/lib/lifecycle.ts` (Modify)

*   **Type / Scope**: Runtime reads.
*   **Proposed Changes**:
    - Timeout: 8 s in cloud mode, 3 s locally.
    - Unreachable copy: "Endpoint runtime did not answer" in the cloud, the current text locally.
    - `crystallizeOn` timeout 55 s, below the 60 s Lambda and CloudFront limits.
    - A new `reloadOn(ep)` posts to `v0/reload`.

##### 35. `platform/admin/app/(console)/endpoints/[id]/lifecycle/page.tsx`, `board.tsx`, `crystal-card.tsx`, `settings/page.tsx`, `app/ui/status-poller.tsx` (Modify)

*   **Type / Scope**: UI copy.
*   **Proposed Changes**:
    - Cloud mode shows "Crystal endpoint active on all instances within 30 s" instead of "Restarting…".
    - The feed is labelled "this instance" when `instance: true`.
    - Settings shows **Retry check** while `provisioning`/`updating`.
    - Status-poller comment drops the provisioner.

##### 36. `platform/admin/proxy.ts` (Create)

*   **Type / Scope**: Next 16 request proxy.
*   **Proposed Changes**: When `SLIME_ORIGIN_SECRET` is set, compare `x-slime-origin` in constant time and answer 403 on mismatch. The matcher covers all paths.

##### 37. `platform/admin/next.config.ts` (Modify)

*   **Type / Scope**: Build config.
*   **Proposed Changes**: `output: 'standalone'`, `outputFileTracingRoot: <admin dir>`, server actions `allowedOrigins` from `ADMIN_ORIGIN` at build time (default `admin.amaslakov.com`), `generateBuildId: () => process.env.ADMIN_SOURCE_HASH` (the build fails if it is unset).

##### 38. `platform/admin/instrumentation.ts` (Modify)

*   **Type / Scope**: Telemetry.
*   **Proposed Changes**: Call `registerOTel` only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.

##### 39. `platform/admin/lambda/start.mjs`, `platform/admin/lambda/run.sh` (Create)

*   **Type / Scope**: Lambda start scripts.
*   **Proposed Changes**:
    - `start.mjs`: loads every parameter under `SLIME_ADMIN_SSM_PREFIX` (`/slime/admin/`) into `process.env` (the admin is single-tenant), then `await import('./server.js')`.
    - `run.sh`: `exec node start.mjs`.

##### 40. `platform/admin/scripts/build-lambda.mjs` (Create) and `platform/admin/package.json` (Modify)

*   **Type / Scope**: Packaging.
*   **Proposed Changes**:
    - `build-lambda.mjs`:
      - Before `next build`, it computes `ADMIN_SOURCE_HASH` over the input set defined in the Technical Plan (whole `platform/admin` tree minus the excluded folders, plus `ADMIN_ORIGIN` and the Node major). It runs `next build` with that variable set and writes the base64 hash to `dist/source-hash.txt`.
      - It then copies `.next/standalone`, `.next/static` → `.next/static`, `public`, and `lambda/*` into `dist/lambda/` in sorted order.
    - Size guard: the script prints the unzipped size of `dist/lambda/` and fails above 200 MB. A direct-upload zip is capped at 50 MB, and the unzipped function plus layers at 250 MB. If the zip measured at the first build is above 40 MB, `admin.tf` uploads the code through `s3_bucket`/`s3_key` (in the crystals bucket under `artifacts/`) instead of `filename`, and `/_next/static/*` is served from that bucket through a second CloudFront origin.
    - New scripts: `build:lambda` (`node scripts/build-lambda.mjs`, which runs `next build` itself), `e2e` (`playwright test -c e2e/playwright.config.ts --project=local`), `e2e:cloud`.
    - Add dev dependency `@playwright/test`, and `@aws-sdk/client-s3` for teardown.

##### 41. `platform/admin/e2e/playwright.config.ts`, `e2e/local.spec.ts`, `e2e/cloud-smoke.spec.ts`, `e2e/helpers.ts` (Create)

*   **Type / Scope**: Playwright E2E.
*   **Proposed Changes**:
    - **local project** (base URL `http://localhost:3100`, `webServer: npm run local` with `ADMIN_ALLOWED_EMAILS=e2e@example.com`, offline provider): CUJs 1–4 locally.
      - Not-invited sign-up refused, then invited sign-up.
      - Create on `postgres://slime_reader:slime_reader@localhost:54329/slime` → `ready`.
      - 12 queries through `fetch` to the endpoint URL → Liquid row with 10/10.
      - Crystallize → `crystallized`; reveal token → `/v0/e/<key>` answers; the token on `/v0/query` → 401.
      - Delete → the endpoint is gone from the list.
    - **cloud project** (base URL `https://admin.amaslakov.com`, credentials from `SMOKE_EMAIL`/`SMOKE_PASSWORD`): the Goal 10 assertions. Its test user is created on first run and the endpoint it creates is deleted in `afterAll`.

##### 42. `platform/admin/test/users.test.ts` (Create), `test/cloud-endpoints.test.ts` (Create), `test/teardown.test.ts` (Create; replaces `test/local-teardown.test.ts`, Delete), `test/proxy.test.ts` (Create), `test/endpoints.test.ts` (Modify)

*   **Type / Scope**: Unit and integration tests (DynamoDB Local in CI).
*   **Proposed Changes**:
    - Allowlist accept and refuse, including case.
    - Cloud provision against a fake runtime HTTP server: ready on 200, failed with the body on 503 after the retry window, and a stuck `provisioning` item deletable.
    - Reconfigure sends exactly one `GET /ep/<id>/healthz?fresh=1` (no separate reload, which another instance could answer).
    - Teardown order and the id guard, for dir and S3 (fake client).
    - The proxy refuses a missing or wrong header and passes the right one.
    - The endpoints test adds `SLIME_PROVIDER` to the expected secrets.

##### 43. `platform/admin/README.md`, `platform/admin/.env.example`, `platform/admin/AGENTS.md` (Modify)

*   **Type / Scope**: Docs.
*   **Proposed Changes**:
    - The README covers cloud mode (`SLIME_RUNTIME_URL`), invite-only, how to run E2E, and the hosted URL.
    - `.env.example` gains `ADMIN_ALLOWED_EMAILS`.
    - `AGENTS.md` notes both modes, if it describes the runner as the provisioner's stand-in.

#### Group 4: provisioner removal

##### 44. `platform/provisioner/**` (Delete)

*   **Type / Scope**: Package.
*   **Proposed Changes**: Delete the whole package: `src/`, `test/`, `shim/`, `scripts/`, `package.json`, `package-lock.json`, `tsconfig.json`, `README.md`.

##### 45. `.github/workflows/ci.yml` (Modify)

*   **Type / Scope**: CI.
*   **Proposed Changes**:
    - Remove the `provisioner` job.
    - Give the `runtime` job a `postgres:16` service, loading `examples/express/db/init.sql` as the `core` job does, for `tenants.test.ts`.
    - Add an `admin-e2e` job:
      - services: DynamoDB Local and Postgres;
      - steps: build core; `npm ci` in runtime and admin; `npx playwright install --with-deps chromium`; create the tables; `npm run e2e`.
      - It uploads the Playwright report on failure.

#### Group 5: infrastructure (`platform` stack)

##### 46. `platform/infra/platform/versions.tf` (Modify)

*   **Type / Scope**: Providers.
*   **Proposed Changes**:
    - Add the `aws.us_east_1` alias with the same `default_tags`.
    - Add the `hashicorp/random ~> 3.6` provider.
    - Keep `aws.untagged` (removed in group 10).

##### 47. `platform/infra/platform/provisioner.tf`, `platform/infra/platform/gas-layer.tf` (Delete)

*   **Type / Scope**: Terraform.
*   **Proposed Changes**: Remove the provisioner function, role, log group, boundary policy, event-source mapping, layer resource and shim archive. The layer versions in AWS remain after this (`skip_destroy`); they are deleted by hand in the apply order (step 3).

##### 48. `platform/infra/platform/runtime.tf` (Modify)

*   **Type / Scope**: Terraform.
*   **Proposed Changes**:
    - Env: `SLIME_HANDLERS_TABLE`, `SLIME_USAGE_TABLE = aws_dynamodb_table.control.name`, `SLIME_CRYSTAL_BUCKET`, `SLIME_SHARED_SSM_PREFIX = /slime/shared/`, `SLIME_TENANT_CACHE_MAX = 8`, `SLIME_TENANT_TTL_MS = 30000`, `SLIME_MAX_DB_CONNECTIONS = 2`.
    - Timeout 60.
    - IAM statements per the Technical Plan:
      - `slime-control` `UpdateItem` with `ForAllValues:StringLike dynamodb:LeadingKeys = USAGE#*` and `ForAllValues:StringEquals dynamodb:Attributes = USAGE_ATTRIBUTES` (+ pk, sk);
      - SSM on `/slime/endpoints/*` and `/slime/shared/*`;
      - S3 on `endpoints/*`.
    - Header comment rewritten. The reserved-concurrency comment is corrected: the account limit is 1000.

##### 49. `platform/infra/platform/crystals.tf` (Create)

*   **Type / Scope**: Terraform.
*   **Proposed Changes**: `aws_s3_bucket.crystals` (`slime-crystals-<account>`), public access block, ownership controls, SSE-S3, versioning enabled, a bucket policy denying non-TLS access, and a lifecycle rule expiring noncurrent versions after 30 days.

##### 50. `platform/infra/platform/admin.tf` (Create)

*   **Type / Scope**: Terraform.
*   **Proposed Changes**:
    - `archive_file` of `platform/admin/dist/lambda`. The function's `source_code_hash = trimspace(file("${path.module}/../../../platform/admin/dist/source-hash.txt"))`, so only changed admin inputs redeploy it.
    - Role and policy as in the Technical Plan, and a log group.
    - `aws_lambda_function.admin` with the LWA layer `arn:aws:lambda:${var.region}:753240598075:layer:LambdaAdapterLayerArm64:${var.lwa_layer_version}` (publisher account per the LWA project; verify at implementation).
    - The Function URL (`NONE`) with the two public permissions copied from `runtime.tf`.
    - `random_password.origin` (48 characters, no special characters).
    - The ACM certificate (us-east-1) and validation records.
    - `aws_cloudfront_distribution.admin` with the two behaviours.
    - Route 53 A/AAAA aliases for `var.admin_domain`.

##### 51. `platform/infra/platform/control.tf` (Modify)

*   **Type / Scope**: Terraform.
*   **Proposed Changes**: Set `stream_enabled = false` and remove `stream_view_type`. Rewrite the header: admin and runtime are the only writers.

##### 52. `platform/infra/platform/variables.tf`, `outputs.tf` (Modify)

*   **Type / Scope**: Terraform.
*   **Proposed Changes**:
    - Variables: remove `runtime_tenant_id`; add `admin_domain`, `zone_name` and `lwa_layer_version`.
    - Outputs: remove `provisioner_function_name` and the layer outputs; add `admin_url`, `cloudfront_distribution_id` and `crystals_bucket`.

##### 53. `platform/infra/platform/build.sh` (Modify)

*   **Type / Scope**: Build.
*   **Proposed Changes**: Build core and runtime, then admin (`npm ci && npm run build:lambda` with `NEXT_TELEMETRY_DISABLED=1`). Remove the provisioner lines and update the header.

##### 54. `.github/workflows/terraform.yml` (Modify)

*   **Type / Scope**: CD.
*   **Proposed Changes**: The post-deploy step adds, when `admin_url` is present:
    - the landing HTML contains `href="https://admin.amaslakov.com/"`;
    - `GET <admin_url>login` → 200;
    - a POST to `<admin_url>login` with an empty form → not 403 and not 5xx;
    - `GET <runtime_url>ep/ep-0000000000/healthz` → 404;
    - the root `/healthz` → 401 check stays;
    - then `npx playwright test --project=cloud` with `SMOKE_EMAIL`/`SMOKE_PASSWORD` from GitHub secrets (skipped with a notice when they are unset).

##### 55. `platform/infra/README.md`, `platform/infra/FINOPS.md` (Modify)

*   **Type / Scope**: Docs.
*   **Proposed Changes**:
    - `README.md`: replace the `/slime/runtime/` runbook with the one-time SSM parameters (`/slime/admin/*`, `/slime/shared/*`); describe the admin, the bucket and the removed provisioner; add the apply order.
    - `FINOPS.md`: concurrency limit 1000 (checked 2026-11-21), the new free-when-idle resources, and model spend outside the AWS budget.

#### Group 6: landing

##### 56. `platform/landing/index.html` (Modify)

*   **Type / Scope**: Static page.
*   **Proposed Changes**: In `.nav-inner`, add `<a href="https://admin.amaslakov.com/" class="btn btn-soft nav-cta">Sign in</a>` next to the existing nav CTA. Wrap both in a small flex container so `justify-self: end` keeps working on mobile.

##### 57. `platform/landing/README.md` (Modify)

*   **Type / Scope**: Docs.
*   **Proposed Changes**: Mention the admin link.

#### Group 7: docs and product vocabulary

##### 58. `docs/architecture/2026-11-21-cloud-mvp-design.md` (Create)

*   **Type / Scope**: Design doc.
*   **Proposed Changes**: The finalized version of this draft (step 6 of drafting).

##### 59. `docs/architecture/slime-cloud.html` (Modify)

*   **Type / Scope**: Architecture page.
*   **Proposed Changes**: Add a banner "Superseded for the provisioner by 2026-11-21-cloud-mvp-design.md" and set its docs index status to Superseded. The SVG is not redrawn: this design doc is the source.

##### 60. `docs/architecture/2026-11-21-endpoint-lifecycle-tab-design.md` (Modify)

*   **Type / Scope**: Design doc.
*   **Proposed Changes**: New decisions L20–L23 (L17–L19 already existed):
    - L20: Crystallize also runs in the shared Lambda, writing to S3;
    - L21: cloud Crystals run as data in QuickJS;
    - L22: in the cloud, `/v0/reload` replaces the restart;
    - L23: the feed is per instance in the cloud.

    Amend L3 and L4 with "local entry; cloud: see L20/L22".

##### 61. `docs/product/product_frame_v0_2.md`, `docs/product/crystal_static_host.md` (Modify)

*   **Type / Scope**: Product docs.
*   **Proposed Changes**:
    - Crystal glossary row: "runs in the QuickJS sandbox in Slime Cloud; without it in self-hosted apps".
    - Crystallize: "local and cloud (S3) as of the cloud MVP".
    - The Crystal endpoint path in the cloud is `/ep/<id>/v0/e/<crystal key>`.

##### 62. `docs/README.md`, root `README.md` (Modify)

*   **Type / Scope**: Docs index and repository map.
*   **Proposed Changes**:
    - Add the new design doc and mark `slime-cloud.html` superseded.
    - Remove the `platform/provisioner/` entries.
    - The admin is "hosted at admin.amaslakov.com; also runs locally".

#### Group 8: verification (local, before any apply)

No files. Run the full Verification Plan below. Fix and re-run until green.

#### Group 9: apply from the branch (the agent)

No files beyond the task record.

1. Record the intent in the task record.
2. Run the pre-checks: no `slime-ep-*` functions or roles; no endpoint items in `slime-control`.
3. Create the SSM parameters without printing their values:
   - `/slime/admin/SESSION_SECRET` from `openssl rand -base64 36`;
   - `/slime/admin/ADMIN_ALLOWED_EMAILS` with the author's email and the smoke email;
   - `/slime/shared/GROQ_API_KEY` or `ANTHROPIC_API_KEY` only if the author provides one; otherwise invited endpoints use Offline.
4. Run `bash platform/infra/platform/build.sh`, then `terraform -chdir=platform/infra/platform plan -out=tfplan`. Review the plan: only the expected deletes (provisioner, layer, mapping, boundary) and creates.
5. `terraform apply tfplan`.
6. Run the post-deploy checks and the cloud smoke from the workstation.

#### Group 10: cleanup commit

##### 63. `platform/infra/platform/versions.tf` (Modify)

*   **Type / Scope**: Providers.
*   **Proposed Changes**: Remove the `aws.untagged` alias. Then apply again from the branch and expect "No changes".

### Verification Plan

*   **Compilation/Build**:
    - `npm ci && npm run build -w @slime-cloud/core`;
    - `(cd platform/runtime && npm ci && npm run typecheck && npm run build)`;
    - `(cd platform/admin && npm ci && npm run typecheck && npm run build:lambda)`;
    - `bash platform/infra/platform/build.sh`;
    - run `build.sh` twice and confirm `platform/admin/dist/source-hash.txt` is identical and `terraform plan` shows no change to `aws_lambda_function.admin`.
*   **Unit Tests**:
    - `npm test -w @slime-cloud/core`;
    - `(cd platform/runtime && npm test)` with the demo Postgres up (`cd examples/express && npm run db:up`);
    - `(cd platform/admin && npm run infra:up && npm run tables && REQUIRE_DYNAMO=1 npm test)`.
*   **Static Analysis & Linting**:
    - `pre-commit run --all-files`;
    - `terraform fmt -check -recursive platform/infra`;
    - `terraform -chdir=platform/infra/platform init -backend=false && terraform -chdir=platform/infra/platform validate`;
    - tflint and trivy as in `terraform-quality.yml`.
*   **Test Coverage Requirement**: no percentage target. Every row of the Contract 1 route table and every transition of Contract 3 (cloud column) has at least one assertion in `tenants.test.ts` or `cloud-endpoints.test.ts`.
*   **E2E/Integration**:
    - `(cd platform/admin && npm run e2e)` locally and in the CI `admin-e2e` job.
    - After apply:
      - the post-deploy curl checks;
      - `npx playwright test --project=cloud` with the smoke credentials;
      - a manual browser pass of CUJ 1 and CUJ 2 (failed path) on `https://admin.amaslakov.com`, with a screenshot attached to the PR.
*   **Not verified by automation**: CUJ 3 and the ready path of CUJ 2 on AWS (no cloud database; Goal 10). The PR's Risks section states it.
