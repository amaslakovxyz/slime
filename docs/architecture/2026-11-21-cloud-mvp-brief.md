# Slime Cloud MVP: shared Lambda runtime, cloud admin, Crystals in S3

* **Author:** amaslakov
* **Date:** 2026-11-21

## Overview

Slime Cloud runs only on a laptop today. The admin (`platform/admin`, Next.js 16) creates endpoints, and a local runner starts one `platform/runtime/src/local.ts` process per endpoint. AWS already holds a per-endpoint pipeline, merged in PR #18 and deployed, but it has never run end to end:

- the `slime-control` table is empty;
- no `/slime/*` SSM parameters exist;
- there are no `slime-ep-*` functions;
- `slime-runtime` is a single-tenant demo function with no settings.

The pipeline it would run is admin → `slime-control` stream → `slime-provisioner` → one Lambda `slime-ep-<id>` per endpoint.

The MVP puts Slime Cloud on AWS with as little infrastructure as possible:

1. **One shared Lambda for all endpoints.** `slime-runtime` serves every endpoint under `/ep/<id>/…`, with per-endpoint settings from SSM and an in-memory engine cache. The per-endpoint provisioner is deleted.
2. **The admin on Lambda.** It runs as `slime-admin` (Next standalone + AWS Lambda Web Adapter, a layer that lets an ordinary HTTP server run inside Lambda), behind CloudFront at `admin.amaslakov.com`. Sign-up is invite-only.
3. **A landing button** that links to the admin.
4. **Crystallize in the cloud.** Crystal modules (frozen handler code) are stored in S3 and loaded by the shared Lambda.
5. **Tests.** Playwright runs against the local stack in CI, followed by an infra check and a cloud smoke run after deploy.

The target user is an invited developer. They create an endpoint against their own publicly reachable Postgres and paste the agent snippet into their coding agent. They then watch handlers move Gas → Liquid → Crystal in the Lifecycle tab.

Terms used below:
- **Gas:** a handler the model generated on demand. It lives in memory, in one process, for 1 hour.
- **Liquid:** a reviewed handler saved in DynamoDB.
- **Crystal:** frozen JS code with its own route `POST /v0/e/<crystal key>`.
- **`slm_` key:** the endpoint's API key.
- **`slc_` token:** a per-Crystal token that opens only that Crystal's route.
- **Provenance:** the schema, dictionary, prompt and model a handler was made with.
- **Fixtures:** recorded inputs and outputs used to prove that a Crystal behaves like its Liquid source.

## Analysis

### Evidence corrections found during review

- **Concurrency is not limited to 10.** `aws lambda get-account-settings` returns `ConcurrentExecutions = 1000` today, so the "10" in `platform/infra/FINOPS.md:26` and `runtime.tf:121` is stale. Three reviewers based a high-severity finding on the old number (admin, landing and runtime starved by one tenant). With 1000 that finding drops to low, but FINOPS.md must be corrected.
- **The concept understates the work in `lambda.ts`.** It is single-tenant in more ways than the concept lists:
  - it loads SSM into the global `process.env` (`lambda.ts:28-42`);
  - it has one global `booting` promise (`:50`);
  - auth reads `process.env.SLIME_API_KEY` (`:99`);
  - it wires no `savedHandlers`, `events`, `warnings` or `crystallize` (`:82`);
  - the Crystal-route regex is anchored at `^/v0/e/` (`auth.ts:12`).
- **Some pieces can be reused unchanged:** `slimeConfigFromEnv(env)` and `missingProviderKey(env)` take an env object (`config.ts:53,101`), `DynamoSlimeStore` takes a tenantId (`store-dynamodb.ts:18-37`), `createApp` builds one app per call, and `Slime.close()` exists for eviction (`slime-engine.ts:104`).
- **`SLIME_PROVIDER` is not new.** The provisioner sets it as a Lambda env var from the control item (`provision.ts:173`).

### Ranked objections

**1. Critical: CloudFront OAC breaks every admin POST.**
- The landing allows only GET/HEAD because OAC (Origin Access Control, where CloudFront signs requests to a private Function URL) does not sign request bodies (`landing/domain.tf:65-67`).
- AWS requires clients to send `x-amz-content-sha256` on POST to an OAC-protected Function URL, and browsers do not. Login, sign-up, create and Crystallize are all server-action POSTs (`admin/app/actions.ts`).
- Resolution, uncontested across 5 lenses:
  - give the Function URL `auth NONE`;
  - have CloudFront add a secret origin header, checked by a Next 16 `proxy.ts`;
  - set `serverActions.allowedOrigins: ['admin.amaslakov.com']`;
  - raise the CloudFront `origin_read_timeout` to ≥ 60 s, because Crystallize waits 60 s (`lifecycle.ts:192`).

**2. Critical: a cloud smoke without a database can never reach `ready`, so the shared Lambda path ships unverified.**
- `createSlime` runs `connector.safetyCheck()` first (`create-slime.ts:20,30-34`), and `/healthz` returns 503 when that check fails (`app.ts:118-121`).
- A missing `DATABASE_URL` silently falls back to `localhost:54329` (`config.ts:19,57`).
- So the smoke can prove sign-in, create → `failed` with the DB reason, and the 401. It cannot prove tenant routing, the engine cache, rebuilds, Crystallize, the S3 reload or the Crystal route.
- Resolution: either rescope the smoke honestly to those assertions, or give it a small public read-only Postgres (free tier) so it can run Gas → Liquid → Crystallize → `/ep/<id>/v0/e/<key>`. **Needs an author decision**: it reopens quiz answer 6.

**3. Critical/High: Crystals imported from S3 into a shared process.** Crystal code runs without the sandbox, on the main thread, with no timeout (`run-crystal.ts:9-24`). Core does not re-check Crystals at startup (`check.ts:1-2`), and the runtime does a plain `import()` (`config.ts:109-115`). In a shared process this means:
- **Availability:** a heavy Crystal (recursion, large `Array.from`) stalls every tenant on the instance.
- **Integrity:** anything that can write to the S3 prefix gets code execution next to every tenant's `DATABASE_URL`.
- **Consistency:** re-crystallizing overwrites `<key>.mjs` in place, so a concurrent pull can mix versions.

Three resolutions were proposed:
- **(a) Cut** cloud Crystallize from the MVP (zoom-out). This reverses quiz answer 5. It matches `product_frame_v0_2.md:203-205` and lifecycle decision L3 ("local-only in v0").
- **(b) Treat a Crystal as data** (inventive). Parse modules with `parseModule` (`module-format.ts`), then run the shape through the existing QuickJS runner with Liquid's timeout and memory limits (`execute.ts:32-33`). This needs a small core change. It removes the versioned `/tmp` folders and the ESM-cache (Node's import cache) workaround, and it closes the isolation gap. The cost is a few ms of QuickJS per call. The vocabulary "Crystal runs without the sandbox" becomes false for the cloud.
- **(c) Keep `import()`, but guard it:**
  - write each version to an immutable prefix `endpoints/<id>/crystal/<version>/`, with the version as the only pointer;
  - run `checkCrystalFolder` or `importCheckedModule` (`import-module.ts:28`) after the pull and before import.

**Needs an author decision.**

**4. High: state lives per instance, so the cloud Lifecycle view is approximate.**
- The following live in the memory of one instance:
  - Gas handlers (`handler-cache.ts:23,41`);
  - the live feed `/v0/events` (`events.ts`);
  - live run counts (`live-runs.ts:21-24`);
  - the 200-generations/hour cap (`generation-limits.ts:11`).
- With several warm instances, rows flicker, depending on which instance answers the 2 s poll.
- Crystallize lands on a random instance and may see "9 of 10" runs.
- `close()` does not save run counts; only `local.ts:177-180` calls `syncLiveRuns` on stop. So every rebuild or eviction resets Gas progress and the generation cap.
- The admin gives the runtime 3 s (`lifecycle.ts:158`), less than a cold tenant build, and then shows "Is `npm run local` up?" (`:173`).
- Resolution:
  - call `syncLiveRuns` before every `close()` or eviction;
  - make the admin's timeout and error copy aware of the cloud;
  - document the view as approximate in the MVP.
- Durable per-endpoint counters in DynamoDB (atomic ADD) are the later fix.

**5. High: each tenant's engine is heavy and one Lambda has 1024 MB.**
- Every `createSlime` opens a pg pool of up to 10 connections (`postgres-connector.ts:24,48`) and a QuickJS pool of up to 4 workers with 128 MB each (`quickjs-runner.ts:8`, `shape-worker-client.ts:5`, created in `create-slime.ts:27`).
- `crystallize()` adds one more runner (`crystallize.ts:68`).
- Resolution:
  - pass `maxConnections` 2 per tenant;
  - cap the cache at a small fixed size with `close()` on eviction;
  - add a core option to inject one process-wide QuickJS runner;
  - raise the runtime memory if measurements need it.

**6. High: there is no control contract.** Every lens converged on this. With the provisioner gone, nobody owns the endpoint state machine. `updateConnector`, `updateSettings` and `requestRestart` set `updating` and wait for a worker (`endpoints.ts:195-302`), and the UI reads `ready|updating` (`lifecycle.ts:153`). A design doc must open with three tables, each with a local column and a cloud column:
- **Routes:** path, auth, state scope (per instance or shared). It must include:
  - `/v0/events`;
  - root `/healthz` → 401, which the CI post-deploy step expects (`terraform.yml:205-210`);
  - unknown endpoint id → 404;
  - the trailing slash in `Endpoint.url`, because the admin builds URLs with `new URL('v0/…', ep.url)`.
- **Config/secrets:** name, writer, store, reader. It must cover:
  - `SLIME_TENANT_ID`, `SLIME_HANDLERS_TABLE`, `SLIME_USAGE_TABLE` and `SLIME_CRYSTAL_DIR`;
  - provider: SSM is the runtime copy and the control item is the display copy, both written by the admin;
  - `SESSION_SECRET` and the allowlist loader.
- **State machine:** create (SSM → item → synchronous `/healthz` → `ready|failed`), settings change, Crystallize, delete.

**7. High: isolation regresses with the provisioner.**
- **Lost fences:** the per-endpoint IAM role with `dynamodb:LeadingKeys` and SSM scoping (`provision.ts:111-148`) goes away. One runtime role then reads every tenant's SSM, handler partition and S3 prefix.
- **Required fixes:**
  - never write tenant settings into `process.env`;
  - fail closed when `DATABASE_URL` is missing;
  - validate the id with `^ep-[0-9a-f]{10}$` before any SSM call and keep a negative cache, so a random `/ep/<id>` cannot drive SSM throttling (`provisioner/src/handler.ts:35`).
- **Usage metering** was wired only through the provisioner (`provision.ts:172`). The runtime needs `slime-control` UpdateItem scoped to `USAGE#*`, because the same table holds password hashes.
- **Accepted risk:** state the lost fence explicitly for the invite-only MVP. A per-tenant STS session policy is the later option.

**8. High: terraform cutover has traps.**
- CI refuses plans that only delete (`terraform.yml:181-192`).
- Removing `aws_lambda_event_source_mapping.provisioner` together with its `aws.untagged` provider alias fails, so the alias must stay for one apply.
- Build and CI still reference the provisioner: `build.sh:12-13` builds it, `build.mjs` emits the layer, and `ci.yml:132-151` has a provisioner job.
- The platform stack has no us-east-1 provider. ACM changes need the `Project=slime` tag (`github_oidc.tf:319-331`).
- The budget freeze denies `lambda:CreateFunction`, `cloudfront:CreateDistribution` and `dynamodb:UpdateTable` (`finops.tf:37-45`).
- The demo tenant (`variables.tf:13-17`, `/var/task/crystal`) is rewritten in place.
- Required: an ordered cutover (multi-tenant runtime → admin provisioning → delete the provisioner), an inventory of provisioner references (READMEs, `slime-cloud.html`, `control.tf` header, `endpoints.ts:1-3`, `local-teardown.ts:3-4`, `usage.ts:12-14`), and a check for orphan `slime-ep-*` resources first.

**9. Medium: the version signal.**
- `CONFIG_VERSION` collides with the provisioner's `SLIME_CONFIG_VERSION` (`reconfigure.ts:60`), and the control item's `updatedAt` already acts as a version.
- Simpler alternative: re-read the endpoint's SSM path when the cache entry is older than a TTL, and rebuild only when the values differ. That needs no new parameter and no rule about write order. A deleted endpoint (parameters gone) is evicted and fails closed with a 404.
- A new `slc_` token can return 401 for up to one TTL. Show it only after the Lifecycle tab shows the Crystal.

**10. Medium: model spend is outside the $15 AWS budget.**
- The freeze only blocks AWS resources (`FINOPS.md:43`).
- The default reviewer is `claude-sonnet-5-5` (`config.ts:24`).
- The review timeout is 60 s against a 30 s Lambda timeout, so reviews that are cut off are retried and paid again (`lambda.ts:46-48`).
- Resolution: set an Anthropic workspace spend limit, a per-endpoint daily quota (later, from objection 4), and a cheaper default reviewer or Groq for invited users.

**11. Medium: observability shrinks.**
- Per-endpoint log groups and X-Ray tracing go away (`provision.ts:92-101,149,164`).
- Logs carry no `endpointId` (`app.ts:112`, `lambda.ts:66,110`).
- The admin's OTel has no collector in Lambda (`instrumentation.ts`), so it must be turned off in the cloud.
- Required: JSON logs with `endpointId` and `requestId`, and metric filters for NOT_READY, tenant build time, evictions and SSM throttling.

**12. Medium: teardown would exist three times.** `provisioner/teardown.ts:39-91` and `admin/lib/local-teardown.ts:16-47` are already near-duplicates. Merge them into one admin teardown with pluggable store steps (SSM | file, S3 | folder), in the order of `local-runner.ts:218-224`.

**13. Medium: local and cloud diverge.**
- With the concept as written, `tenants.ts`, the cache, routing and the S3 store never run locally (inventive), while making local multi-tenant is YAGNI (zoom-out).
- Middle path (structural): one composition root `endpointRuntime(env, deps)` that never reads `process.env`. Both `local.ts` (one process per endpoint, as today) and the Lambda tenant cache call it. The router and cache get CI tests with a fake SSM and a fake S3, following `test/fake-dynamo.ts`.

**14. Low:**
- The `CRYSTAL_TOKENS` write queue lives in one process (`crystal-tokens.ts:22-26`), so concurrent admin instances can lose a token write.
- A single JSON SSM value reaches the 4 KB standard-tier limit at about 35 Crystals.
- `createUser` has no allowlist hook (`users.ts:13`); compare emails lower-cased.
- `Endpoint.layerArn` becomes dead.
- Playwright is a new dependency, and the CI admin job has DynamoDB but no Postgres (`ci.yml`).

### Contradictions and inventive moves

- **Shared Lambda vs isolation.** Treating the Crystal as data in QuickJS (3b) removes the worst cross-tenant risk without bringing back per-endpoint functions. One shared QuickJS runner (5) bounds memory.
- **Proving the cloud vs no database.** A disposable free-tier Postgres for the smoke lets the same code path run in CI and in the cloud, Crystallize included.
- **Fast config change vs caching.** The writer tells the reader. The instance that crystallized swaps its own engine at once, other instances catch up within a TTL, and missing parameters evict the tenant.
- **Ideal Final Result.** One host composition, two ports (where endpoint settings come from, where Crystals are stored), run identically on a laptop and in Lambda. A Crystal is frozen, never generates, has its own route and token, and runs in the same sandbox as Liquid.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * Multi-tenant `slime-runtime` serving `/ep/<id>/v0/{query,e/<key>,lifecycle,events,crystallize}` and `/ep/<id>/healthz`, with per-endpoint auth. Root `/healthz` → 401.
  * Clean removal of the provisioner, the Gas layer, the endpoint boundary and the stream mapping, plus build/CI/docs references.
  * Admin cloud flows: create (SSM + item + `/healthz` → `ready|failed`), settings change, Crystallize, delete (one shared teardown).
  * Admin on Lambda + LWA behind CloudFront at `admin.amaslakov.com`: Function URL auth NONE, secret origin header, `allowedOrigins`, a 60 s origin timeout, OTel off.
  * Invite-only sign-up (`ADMIN_ALLOWED_EMAILS`), and a landing button to the admin.
  * Cloud Crystallize with Crystals in S3, executed as data in the shared QuickJS runner (small core change to `runCrystal`), and rebuilt by TTL re-read with an in-place swap.
  * Tests: Playwright UI + user flow on the local stack in CI (fake SSM/S3 + demo Postgres cover the shared-Lambda and Crystal paths); post-deploy infra checks; a cloud smoke without a database whose assertions are listed under Key Decisions.
  * Agent-run `terraform apply` from the branch, in an ordered cutover.
* **Out-of-Scope Non-Goals:**
  * Per-endpoint IAM isolation (stated as an accepted risk).
  * Durable cross-instance Gas, durable counters and quotas.
  * Making the local runner multi-tenant.
  * Custom domains per endpoint, CORS, publishable keys, `slime-client`/MCP.
  * A staging stack.

## Alternatives Weighed

* **Per-endpoint Lambda provisioner (already deployed).** Rejected by the author, who wants one shared Lambda for the MVP. Zoom-out dissent: run one real endpoint through it before deleting it, because it already provides IAM fences and the env-bump restart.
* **Shared Lambda but keep the provisioner disabled.** Rejected by the author: it leaves dead code and two models.
* **OpenNext.** Rejected by the author: 3–4× more resources and a new build dependency.
* **Bare Function URL for the admin.** Rejected by the author, who wants a domain.
* **`amaslakov.com/admin` path.** Rejected by the author: it changes the landing stack and adds a Next `basePath`.
* **Open sign-up / open with Claude by allowlist.** Rejected by the author: token cost and extra code.
* **Crystallize out of the MVP.** Rejected by the author, who wants Crystals in S3. Reopened by zoom-out (objection 3a).
* **External free Postgres or RDS for cloud tests.** Rejected by the author, who wants cloud tests offline without a DB. RDS (~$12–15/month) would also break the budget. Reopened by codebase-details and inventive (objection 2).
* **Cloud-only or local-only tests.** Rejected by the author in favour of local CI + post-deploy smoke.
* **Staging stack.** Rejected by the author: it doubles resources and needs CI work.
* **OAC in front of the admin Function URL.** Rejected in review: it breaks browser POSTs (objection 1).
* **A new `CONFIG_VERSION` SSM parameter with 30 s polling.** Challenged in review in favour of TTL re-reads of the SSM path (objection 9).

## Key Decisions & Staging for Next Steps

**Resolved (author quiz, 2026-11-21):**
- Shared multi-tenant Lambda, provisioner deleted.
- Admin on Lambda + LWA + CloudFront at `admin.amaslakov.com`.
- Invite-only allowlist.
- Crystals in S3.
- Cloud tests offline without a DB.
- Local CI + post-deploy smoke.
- The agent applies from the branch.

**Resolved in review (no author input needed):** adopt the resolutions to objections 1, 4–8 and 10–14.
- OAC is replaced by a secret origin header.
- The control contract tables come first in the design doc.
- `endpointRuntime(env)` is the single composition root; tenant settings never go into `process.env`; a missing DB URL fails closed.
- The id regex and a negative cache run before SSM.
- The cache is capped, with `close()` and `syncLiveRuns` on eviction, and pg `maxConnections` 2.
- A shared QuickJS runner via a small core option.
- Usage metering is ported, with `USAGE#*`-scoped IAM.
- One shared teardown.
- Ordered terraform cutover with the alias kept for one apply.
- JSON logs carry `endpointId`.
- FINOPS.md concurrency gets corrected.
- An Anthropic spend limit is a prerequisite.

**Resolved by the author after review (2026-11-21, second quiz):**
1. **Cloud smoke stays without a database (objection 2).** The smoke asserts only:
   - sign-in with an allowlisted test user;
   - create → `failed`, with the DB reason shown;
   - `/ep/<id>/v0/query` without a key → 401, and an unknown id → 404;
   - root `/healthz` → 401;
   - landing button → admin 200;
   - delete removes the item and the SSM parameters.

   Tenant routing, the engine cache, rebuilds, Crystallize, S3 and `/v0/e` are proven only in CI, with a fake SSM, a fake S3 and the demo Postgres. That gap goes into the PR's Risks.
2. **Crystal runs as data in QuickJS (objection 3b).**
   - Crystal modules in S3 are read with `parseModule` (pure parse, no `import()`).
   - The shape runs in the same QuickJS runner as Liquid, with its timeout and memory limits. This is a small core change: `runCrystal` takes a runner and the shape source.
   - Integrity: after the pull and before `parseModule`, each module's SHA-256 is compared with the manifest `sha256` (already recorded by `saveCrystal`). A mismatch rejects the module (it is not served), because the parsed SQL still runs against the tenant DB even when the shape is sandboxed.
   - Versioned `/tmp` import folders and the ESM-cache workaround are dropped.
   - Docs that say "Crystal runs without the sandbox" are updated for the cloud.
3. **Rebuild signal: TTL re-read of the endpoint's SSM path, plus an in-place swap (objection 9).**
   - Every ~30 s per cached endpoint, the runtime re-reads `/slime/endpoints/<id>/` and the Crystal manifest version, and rebuilds only when either changed.
   - The instance that ran Crystallize swaps its own engine at once.
   - Missing parameters evict the endpoint, which then answers 404.
   - No `CONFIG_VERSION` parameter and no write-order rule.

**Open:** none. Next step: an implementation plan built on the control contract tables (routes, config/secrets, state machine), the ordered terraform cutover, and the test matrix.
