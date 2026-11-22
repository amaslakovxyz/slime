# API path audit: runtime and admin against docs and specs

* **Status:** Record, 2026-11-22, `origin/main` at `5942965`.
* **Scope:** every HTTP path of the endpoint runtime (`platform/runtime`), every
  runtime call the admin makes (`platform/admin/lib`, `app/`, `scripts/`), the
  admin's own pages, and the self-hosted examples, compared with the docs that
  name them: `platform/runtime/README.md`, `platform/admin/README.md`, the root
  `README.md`, `docs/architecture/2026-11-21-cloud-mvp-design.md` (Contracts 1
  and 3), `docs/architecture/2026-11-21-endpoint-lifecycle-tab-design.md`,
  `docs/product/*`, `core/docs/request-format.md`, `platform/landing/`,
  `platform/infra/README.md`, the CI post-deploy checks and the Playwright
  specs. Also the open Agent API v1 spec (PR #30), since it describes the same
  routes.

## Ground truth

Routes are the endpoint's own; on Lambda they are served under `/ep/<id>/`
(`src/lambda.ts`), locally on `http://localhost:87xx/` (`src/local.ts`).

| Route | Code |
|---|---|
| `POST /v0/query` | `app.ts:121` |
| `GET /healthz` (`?fresh=1` on Lambda) | `app.ts:138`, `lambda.ts:100` |
| `GET /v0/handlers`, `DELETE /v0/handlers/:key` | `app.ts:142`, `app.ts:146` |
| `POST /v0/e/:key` | `app.ts:153` |
| `GET /v0/events?limit=&before=&after=` | `app.ts:179` |
| `GET /v0/lifecycle` | `app.ts:187` |
| `POST /v0/crystallize` (only with a Crystal store) | `app.ts:207`, `endpoint-runtime.ts:181` |
| `POST /v0/reload` | `lambda.ts:94`, `local.ts:46` |

Admin → runtime calls: `healthz`, `healthz?fresh=1` (`lib/cloud-endpoints.ts`),
`v0/lifecycle`, `v0/events`, `v0/events?limit=25&before|after=`,
`v0/crystallize`, `v0/reload` (`lib/lifecycle.ts`), `healthz` (local runner).
All join `new URL('<route>', ep.url)` on a URL that ends in `/`. Admin pages:
`/login`, `/`, `/endpoints`, `/endpoints/new`, `/endpoints/<id>` (redirects to
`lifecycle`), `/endpoints/<id>/{lifecycle,usage,settings,requests}`,
`/endpoints/<id>/connector` (redirects to `settings`), `/billing`.

## Findings

| # | Where | Doc said | Code does | Status |
|---|---|---|---|---|
| A1 | `platform/admin/lib/cloud-endpoints.ts:4` (header comment) | reconfigure: `POST <url>v0/reload` → `healthz` | one `GET <url>healthz?fresh=1` (`reconfigure`, line 122; asserted in `test/cloud-endpoints.test.ts:200`) | fixed |
| A2 | `cloud-mvp-design.md` item 42 | "Reconfigure calls reload, then healthz" (contradicts its own Contract 3) | as A1 | fixed |
| A3 | `cloud-mvp-design.md` item 30 | functions include `reload(ep)`; healthz retried "on 503" | no `reload` in `cloud-endpoints.ts` (it is `reloadOn` in `lib/lifecycle.ts`); retried on any 5xx | fixed |
| A4 | `endpoint-lifecycle-tab-design.md` scope, L3, §4.1, §7 | crystallize route "local entry only … the Lambda entry never mounts it"; "off by default" | mounted whenever the endpoint has a Crystal store: always on Lambda (S3), locally with `SLIME_CRYSTAL_DIR` | fixed |
| A5 | `endpoint-lifecycle-tab-design.md` §4.1, scope | `GET /v0/events` returns a 50-entry buffer, "Memory only"; feed persistence out of scope | paged by `limit`/`before`/`after`, events carry `id` (and `route: 'crystal'`), the store keeps the newest 500 | fixed |
| A6 | `endpoint-lifecycle-tab-design.md` §4.1 | `/v0/lifecycle` returns thresholds `gasToLiquidRuns`, `CRYSTAL_MIN_RUNS` | `thresholds: {liquidRuns, crystalRuns}` (`endpoint-runtime.ts:173`; read by `lib/lifecycle.ts`) | fixed |
| A7 | `docs/product/atlas-demo-cheatsheet.md` step 2 and "Calls to copy" | endpoint URL `https://<runtime host>/ep/<id>` and `curl "$SLIME_URL/v0/query"` | the admin shows and stores the URL with a trailing `/` (`lib/endpoints.ts:126`); pasted as is into `SLIME_URL`, the doc's join makes `/ep/<id>//v0/query`, which answers 404; `examples/customer-site/.env.example` and the Atlas SSM value (`platform/infra/atlas/README.md:38`) have no slash | fixed: step 2 shows the URL with `/`; the calls use `"${SLIME_URL%/}/v0/query"`, right with or without the slash (the CI idiom, `terraform.yml:273`) |
| A8 | `platform/runtime/README.md` routes | `/v0/crystallize` listed as always present, `{keys}` required; no body limit or unknown-path answer | mounted only with a Crystal store; `keys` optional; 413 `INVALID_REQUEST` above 16 KB; 500 `INTERNAL`; unknown path is Hono's plain-text 404 | fixed |
| A9 | root `README.md` (examples/hono) | `/health` and `POST /slime` | also `POST /crystallize` (`examples/hono/server.mjs:22`) | fixed |
| D1 | runtime, every unknown path inside an endpoint | errors are `{error: {code, message, retryable}}` everywhere (`core/docs/request-format.md`) | `/ep/<id>/` itself, a typo or a double slash got `404 Not Found` as text; `DELETE /v0/handlers/<unknown>` gets 404 `{"evicted": false}` | decided: JSON 404 `NOT_FOUND` naming the method and path (`app.notFound`, branch `fix/runtime-json-404`); the evict answer is unchanged |
| D2 | self-hosted examples vs hosted runtime | product frame: "the same word everywhere … runtime `POST /v0/crystallize`" | examples (`express`, `hono`, `multi-source`) serve `POST /slime`, `POST /crystallize`, `GET /health`; the runtime serves `POST /v0/query`, `POST /v0/crystallize`, `GET /healthz`. Docs describe each side correctly | decided: keep; the examples show how to mount the library |

### PR #30 (Agent API v1, open, `docs/product/agent_api_v1.openapi.yaml` at `676e070`) against main

The spec predates the cloud MVP. Where it calls a route "unchanged" or
"shipped", main differs:

| Spec | Main |
|---|---|
| servers: only `http://localhost:{port}` | cloud endpoints live at `https://<runtime host>/ep/<id>/`; local at `http://localhost:87xx/` |
| `POST /v0/e/{handlerKey}` 400 is `INVALID_INPUT` with `expected` + `missing` ("shipped behavior") | 400 `INVALID_REQUEST`; the names are only in `message` ("This endpoint takes input: … Missing: …") |
| `/v0/query` request: `input` required | `input` optional (`core/docs/request-format.md`) |
| `Meta.cache` enum `miss`, `hit` | also `coalesced` (`core/src/engine/slime-engine.ts:170`) |
| `Error.code` enum `UNAUTHORIZED, WRITE_REFUSED, INVALID_INPUT, INTENT_UNSATISFIABLE, NOT_READY, REVIEW_REQUIRED, ACCOUNT_EXISTS, PROVIDER_ERROR, INTERNAL` | main has no `INVALID_INPUT`, `PROVIDER_ERROR`, `REVIEW_REQUIRED`, `ACCOUNT_EXISTS`. Core codes (`core/src/shared/errors.ts`): `INVALID_REQUEST`, `ACCESS_DENIED`, `HANDLER_NOT_FOUND`, `GENERATION_*`, `QUERY_*`, `SHAPE_MISMATCH`, `SANDBOX_ERROR`, `SOURCE_ERROR`, …; runtime codes: `UNAUTHORIZED`, `ENDPOINT_NOT_FOUND`, `NOT_READY`, `INTERNAL` |
| `GET /v0/lifecycle` returns `{endpointId, status, policy, handlers}` | returns `{handlers, stats, thresholds, warnings, instance?}` |
| endpoint `status` enum `pending, ready, updating, error` | `pending, provisioning, ready, failed, updating, deleting` (`platform/admin/lib/endpoints.ts`) |
| crystallize: `POST /v0/handlers/{handlerKey}/crystallize` | `POST /v0/crystallize {keys?}`; tokens are issued by the admin, not the runtime |

The new routes (`/v1/accounts`, `/v1/endpoints`, per-handler crystallize) are
proposals and are not listed as drift. PR #60 (`docs/agent-api-v1-main`) carries
PR #30's commits rebased onto main and marks each route and field shipped or
proposed against these contracts.

## Matches (no change needed)

Contract 1 of the cloud MVP design, the runtime README route table (apart from
A8), the admin README mode table, the landing page (`POST /ep/<id>/v0/query`,
`/v0/e/<key>`; the old `GET /slurp` is gone), `customer-demo-use-cases.md`,
`crystal_static_host.md`, `product_frame_v0_2.md`, `examples/customer-site`
(it trims a trailing `/` from `SLIME_URL`), the CI post-deploy checks (root
`/healthz` → 401, `/ep/ep-0000000000/healthz` → 404) and both Playwright specs.
`docs/architecture/architecture-spec.md` (`POST /dispatch`) is indexed as a
design implemented only on unmerged branches, so it is not drift.

## Verification

Local entry (`src/local.ts`, canned handlers, demo Postgres, DynamoDB Local),
2026-11-22:

| Request | Answer |
|---|---|
| `GET /healthz` without key / with key | 401 `UNAUTHORIZED` / 200 `database.ok: true` |
| `POST /v0/query` ×12 | 200, 4 rows; handler Liquid |
| `POST /v0/query` with `{bad` / 17 KB body | 400 `INVALID_REQUEST` / 413 `INVALID_REQUEST` |
| `POST //v0/query` | 404, text `404 Not Found` |
| `GET /v0/events?limit=2` / `limit=0` | 200 `{total: 12, events, hasOlder, hasNewer}` / 400 |
| `GET /v0/lifecycle` | 200, keys `handlers, stats, thresholds, warnings`; `thresholds: {liquidRuns: 3, crystalRuns: 10}` |
| `POST /v0/crystallize {}` | 200 `reports`; module and `manifest.json` in `SLIME_CRYSTAL_DIR` |
| `POST /v0/reload` | 204 |
| `DELETE /v0/handlers/nope`, `POST /v0/e/nope` | 404 `{"evicted": false}`, 404 `HANDLER_NOT_FOUND` |
| after restart with `CRYSTAL_TOKENS`: `POST /v0/e/<key>` with `slc_` / `slm_` / unknown input | 200 `tier: crystal` / 200 / 400 `INVALID_REQUEST` |
| `slc_` on `POST /v0/query`, `GET /v0/lifecycle` | 401, 401 |

Lambda router (`createRouter` with a fake tenant): `/ep/<id>/v0/query` 200;
`/ep/<id>//v0/query`, `/ep/<id>`, `/ep/<id>/`, `/ep/<id>/healthz/` all 404 as
text. Suites: runtime 95/95, admin 68/68 (`REQUIRE_DYNAMO=1`), both typechecks
clean.
