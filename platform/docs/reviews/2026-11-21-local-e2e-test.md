# Local end-to-end test, 2026-11-21

The whole product run on one machine: local infra, the CI-parity suites, a
live runtime smoke through Gas → Liquid → Crystal, and a zero-context tester
who started from the landing page as a new user. Base: `origin/main` at
`2837580`; fixes are on `fix/local-e2e-findings`.

## Setup

| Item | Value |
|---|---|
| Worktree | `.worktrees/local-e2e`, branch `fix/local-e2e-findings` off `origin/main` (`2837580`) |
| Versions | Node v26.7.0, Docker 29.7.2, just 1.58.0, Postgres 16.16, Next.js 16.4.6 |
| `MODEL_MODE` | `offline`: neither `ANTHROPIC_API_KEY` nor `GROQ_API_KEY` was set |
| Install | `npm ci && npm run build -w @slime-cloud/core`, then `npm ci` in `platform/runtime`, `platform/admin`, `examples/express`, `examples/multi-source`; all clean |
| Postgres | shared `slime-local-pg-postgres-1` on :54329; `plans,accounts,subscriptions` = `4,200,200` |
| DynamoDB Local, Jaeger | shared `admin-dynamodb-1` (:8000), `admin-jaeger-1` (:16686/:4318); `npm run tables` → `Tables exist: slime-control, slime-handlers` |
| Admin | `platform/admin`: `.env.local` from `.env.example` with a fresh 48-char `SESSION_SECRET`; `PORT=3300 npm run local`; `/login` → 200 |
| Landing | `python3 -m http.server 8090 --bind 127.0.0.1 --directory platform/landing`; `/` → 200 (`just landing` failed on :8000, see E2E-01) |

## Core logic

Each command was run from the worktree. `REQUIRE_DB=1` / `REQUIRE_DYNAMO=1`
turn skips into failures, as in CI. The counts are for the base plus the fix
commits; the later merge of `origin/main` (with #22) into the branch was not
re-counted.

| Suite | Command | Result |
|---|---|---|
| Core import guard | `! grep -rnE "@slime-cloud/(runtime\|server\|control-plane)\|platform/runtime\|@aws-sdk/" core/src` | pass |
| Core | `npm run typecheck -w @slime-cloud/core && REQUIRE_DB=1 npm test -w @slime-cloud/core && npm run check:pack -w @slime-cloud/core` | 330 pass, 0 fail, 0 skipped; pack check 226 files (332 pass after E2E-13) |
| Express example | `REQUIRE_DB=1 npm test && npm run check:crystal` | 4 pass, 0 fail, 0 skipped; crystal check passed |
| Multi-source example | `REQUIRE_DB=1 npm test` | 12 pass, 0 fail, 0 skipped |
| Runtime | `npm run typecheck && npm test` | typecheck ok; 53 pass, 0 fail, 0 skipped |
| Admin | `npm run typecheck && REQUIRE_DYNAMO=1 npm test` (with `.env.local`) | typecheck ok; 43 pass, 0 fail, 0 skipped (44 pass after E2E-16) |
| Landing function | `node --test platform/infra/landing/function/index.test.mjs` | 5 pass, 0 fail |

Live runtime smoke: one endpoint process (`platform/runtime`, `node --import
tsx src/local.ts`) on :8950, `SLIME_PROVIDER=offline`, a fresh tenant, shared
DynamoDB Local and the demo Postgres.

| # | Request | Expected | Actual |
|---|---|---|---|
| a | `GET /healthz` with key | 200, `database.ok` | 200, `database.ok: true`, user `slime_reader` |
| b | `GET /healthz` without key | 401 | 401 `UNAUTHORIZED` |
| c | `$Q` (accounts per plan), 1st | 200, 4 rows summing to 200, gas, miss | 200; Free 56, Growth 48, Starter 48, Enterprise 48; `gas`/`miss` |
| d | `$Q` calls 2–5 | liquid by the 4th call; review `none` | call 2 `gas`/`hit`, call 3 onward `liquid`/`hit`; review `none` |
| e | intent `delete all canceled subscriptions` | 422 `INTENT_UNSATISFIABLE` | 403 `WRITE_REFUSED` "This request asks to delete data; Slime only reads." The expectation was wrong: a write-like refusal reason becomes `WRITE_REFUSED` (`core/src/engine/README.md:49-50`) |
| f | intent `churn by plan` | 422; message names the offline handlers | 422 `INTENT_UNSATISFIABLE` "No offline handler for this intent. Add it to the offline handlers." The message names no intents: E2E-03 |
| g | body `{bad json` | 400 `INVALID_REQUEST`, not retryable | 400 `INVALID_REQUEST` "Body must be valid JSON.", `retryable: false` |
| h | `GET /v0/lifecycle` | handler at `liquid` | handler `liquid`, 5 runs; thresholds `liquidRuns: 3`, `crystalRuns: 10` |
| i | `$Q` to 10 runs, `POST /v0/crystallize` | `outcome: "crystallized"`, `index.mjs` written | `outcome: "crystallized"`; `index.mjs`, `manifest.json` and the handler module written |
| j | restart, `$Q` once | `tier: "crystal"` | startup `crystals: 1`; `tier: "crystal"`, `cache: "hit"` |

## New-user journey

A zero-context subagent got only the landing URL, the console URL, the demo
database URL, a fresh identity and "only the Offline option will work". It
was told not to read the repository.

| Step | Result | Notes |
|---|---|---|
| 1. Read landing page | pass | Renders; the `/slurp` demo is client-side only; no link to the console or sign-up |
| 2. Sign up | pass | Wrong-password and short-password errors are clear; sign-up lands on Overview |
| 3. Create endpoint (Offline, Postgres) | pass | Test connection reports bad credentials clearly; endpoint READY at `http://localhost:8700/` |
| 4. Find how to call it | pass | Lifecycle → "Connect your agent": `POST <url>/v0/query`, `x-api-key`, body `{intent,input,output}`; contradicts the landing's `GET /slurp` |
| 5a. Landing's API (`GET /slurp`) | fail | 404 |
| 5b. ≥5 plain-language questions | fail | Only the console's example intent works; 8 others → 422 "No offline handler…" with no hint at what is supported |
| 5c. Repeat a question | pass | gas/miss 17 ms → gas/hit 1.8 ms → liquid/hit 2–4 ms; Crystallize offered at 10 runs |
| 5d. Modify/delete | pass | delete → 403 `WRITE_REFUSED`; update/drop → 422; data unchanged |
| 5e. Malformed requests | pass | Bad/empty JSON, missing fields, bad type → 400; wrong/missing key → 401; a different output shape → 500 `SHAPE_MISMATCH` |
| 6a. Console reflects activity | pass | Lifecycle, Usage, Overview and Billing agree on successful traffic; failures invisible; rows don't sum |
| 6b. Crystallize | pass | Restart on the same URL, own `/v0/e/<key>` route and `slc_` token; calls return `crystal` |
| 6c. Default provider (Claude) without key | pass | Warning after creation; query → 502 "The Claude API rejected the API key." (that message is E2E-13) |
| 7. Delete endpoint | pass | Confirm dialog; endpoint gone, page 404, URL refuses connections; billing resets to $0.00 |

What passed, per the tester:

- Sign-up validation and account creation.
- Test connection: clear error on a bad password; user, database and server version on success.
- Endpoint creation: a live URL within seconds, status READY.
- The console shows how to call the endpoint (prompt and curl, Reveal token, Copy).
- The example query returns correct data (56/48/48/48, checked against the database).
- Repeats get faster, and the tier moves gas → liquid → crystal.
- The delete intent is refused with 403; the database is unchanged; the reader role is read-only at the database level.
- Malformed requests return 400 with helpful messages; wrong, missing or Bearer credentials return 401.
- Crystallize appears at 10 runs, restarts on the same URL and issues its own route and token.
- Usage, Overview and Billing reflect successful traffic by tier.
- A Claude endpoint without `ANTHROPIC_API_KEY` shows a clear warning.
- Delete endpoint asks for confirmation; the endpoint disappears and its URL stops answering.

Every tester finding was reproduced against the running stack: endpoint-API
findings with curl against a runtime on :8950/:8951, console findings in the
browser by a second agent following fixed steps (R1–R6).

## Backlog

| ID | Severity | Area | Title | Repro | Expected | Actual | Status |
|---|---|---|---|---|---|---|---|
| E2E-01 | minor | tooling | `just landing` collides with DynamoDB Local on :8000 | `just landing` with the admin stack up | landing served | `OSError: [Errno 48] Address already in use` | fixed (3875d49) |
| E2E-02 | major | landing | Landing advertises `GET /slurp?want=…&shape=…`, which does not exist | `curl '<endpoint>/slurp?want=…' -H 'x-api-key: …'` | the landing's request works, or the landing shows the real API | 404; the real API is `POST <endpoint>/v0/query` with `{intent,input,output}` (`platform/runtime/src/app.ts`); `/slurp` at `platform/landing/index.html:720,726,732,782,794,842` | fixed (35f5720): option (a), the landing shows the real request |
| E2E-03 | major | endpoint-api | Offline misses don't say which intents work and point to an action the console doesn't have | Offline endpoint, any intent but the console's example | the supported intents are discoverable | 422 "No offline handler for this intent. Add it to the offline handlers." (`core/src/models/offline/offline-generator.ts:14`); the console has no offline-handlers screen. Listing the intents in that reason is unsafe: `WRITE_LIKE_REASON` (`core/src/engine/generate.ts:52`) would match the canned intent "delete all canceled subscriptions" and turn every miss into `WRITE_REFUSED` | obsolete: #40 (3c69c54) removed the Offline provider |
| E2E-04 | major | landing | No path from the landing page to the console or sign-up | list the landing's links | a sign-up / console CTA | every CTA is an in-page anchor (`#top`, `#how`); the only external links are LinkedIn | fixed (35f5720): the closing CTA "Open the console" links to the console, beside the nav's Sign in |
| E2E-05 | major | endpoint-api | A different output shape for a known intent returns 500 `SHAPE_MISMATCH` | Offline, `number of accounts on each plan` with output `[{"planName":"string","n":"integer"}]` | reshaped data or a 4xx | 500 `SHAPE_MISMATCH` with the mismatch list | by-design: a handler that can't produce `output` is a server-side failure (`core/docs/request-format.md:101`, `core/src/shared/errors.ts:11`); offline handlers were canned and ignored `output`, while a model generates per shape. #40 (3c69c54) removed Offline, so every endpoint now generates per shape |
| E2E-06 | major | console | Deleting an endpoint wipes month-to-date usage and bill | 12 requests ($0.03), delete, open Overview/Billing | the month keeps traffic already served | $0.00, 0 requests. `USAGE#<id>` items survive deletion (`platform/admin/README.md:52`), but `listWithStats` sums only live endpoints (`platform/admin/lib/endpoints.ts:440-442`) | backlog |
| E2E-07 | minor | console | Failed requests are invisible in the console | 3 valid + 3 failing (400/422/401) requests, reload Lifecycle and Usage | errors visible | counter "3 requests", 3 log rows; the runtime records only answered queries (`platform/runtime/src/app.ts:109-110`, `usage.ts:68-76`) | backlog |
| E2E-08 | minor | landing | Landing demo shows Liquid on the 2nd call; the product promotes on the 3rd | repeat `$Q` | 2nd call `liquid` | 2nd call `gas`/`hit`, 3rd `liquid` (`gasToLiquidRuns` = 3, `platform/runtime/src/local.ts:115`). `review: "none"` is expected offline: there is no reviewer | fixed (35f5720): the demo shows Gas miss, Gas hit, then Liquid after 3 runs and the review |
| E2E-09 | minor | console | Usage rows don't add up to the total; offline generations are billed | 12 requests on an Offline endpoint, open Usage/Billing | rows sum to the total; no LLM charge without an LLM | rows $0.00 + $0.00 + $0.00 + $0.02, total $0.03; "Generations 1 · $0.02" with "0 LLM tokens". `platform/admin/lib/pricing.ts` rounds each row but the total from the raw sum. The runtime counts every cache miss as a generation whatever the provider (`platform/runtime/src/usage.ts:75`), and `pricing.ts` charges per counted generation | backlog |
| E2E-10 | minor | console | Lifecycle request counter and log reset after Crystallize | 10 requests, Crystallize, 2 more | history kept | "2 requests since 23:47:50" | by-design: the feed is per process and in memory (`platform/runtime/src/events.ts:1-2`), and the label says "since <start>"; Usage keeps the totals |
| E2E-11 | minor | landing | Crystal doesn't match "ordinary code, committed to your repo" | Crystallize, inspect | code in the user's repo | a module in the endpoint's data folder served at `/v0/e/<key>`; no repo integration. The main key also opens the Crystal route, which is by design (`platform/runtime/src/auth.ts:26-30`) | fixed (35f5720): Crystal is its own route with an `slc_` token in the cloud; the repo path is named as self-hosted (`slime-crystal`) |
| E2E-12 | minor | console | New endpoint defaults to Claude with no Claude key, and warns only after creation | New endpoint with no `ANTHROPIC_API_KEY` | a working default, or a warning before creation | Claude pre-selected (`platform/admin/app/(console)/endpoints/new/form.tsx:45`); the warning appears on the Lifecycle tab after creation. Since #40 removed Offline, every keyless endpoint fails its first new request with E2E-13's "No Claude API key is set." | decision needed |
| E2E-13 | minor | endpoint-api | A missing provider key is reported as "rejected" | Claude endpoint without `ANTHROPIC_API_KEY`, one query | "key not set" | 502 "The Claude API rejected the API key.": the runtime passes `''` (`platform/runtime/src/config.ts:88`) and the 401 maps to "rejected"; Groq likewise | fixed (3d4514c; 7ca8632 adds an unset `undefined` key, which 3d4514c threw a `TypeError` on) |
| E2E-14 | minor | endpoint-api | Write intents refused with different codes (403 delete, 422 update/drop) | Offline: `set every plan price to zero`, `drop table invoices` | one explicit refusal | 422 "No offline handler…" | obsolete: #40 (3c69c54) removed the Offline provider. It was by-design: offline answered only canned intents (`core/src/models/offline/README.md:21-22`); writes were still blocked by the SQL lint and the read-only role, and the data stayed unchanged |
| E2E-15 | cosmetic | landing | "Feed the Slime" widget lists REST APIs, SOAP, CSVs; the console offers only PostgreSQL | landing widget vs New endpoint | matching sources | console: "PostgreSQL · Postgres 12+" only | fixed (35f5720): Postgres (cloud), REST APIs and Notion (self-hosted), more sources (next) |
| E2E-16 | cosmetic | console | Test connection reports TABLES 6 for 5 user tables | Test connection with the demo reader URL | 5 | 6: counted `slime_meta.probe`, which `slime_reader` can't read (`platform/admin/lib/connectors/postgres.ts`) | fixed (2df266e; 77d2b65 counts exactly what the runtime describes: `public`, views in, materialized views out) |
| E2E-17 | minor | tooling | Rebuilding core breaks `npm run check:crystal` in `examples/express` | `npm run build -w @slime-cloud/core`, then `npm run check:crystal` in `examples/express` | crystal check passes | `slime-crystal: Permission denied`: `tsc` rewrites `core/dist/crystallize/bin.js` as `-rw-r--r--`, and npm sets the exec bit only on install, so the `file:../../core` link loses it. `npm ci` in the example restores it. CI is unaffected: it installs the packed tarball | backlog |

Fix verification, after rebuilding core and restarting the admin:

- E2E-01: `just landing` serves `http://localhost:8090/` (200) while DynamoDB Local holds :8000.
- E2E-13: a Claude endpoint without a key now answers 502 `GENERATION_FAILED` "No Claude API key is set." in 6 ms, with no API call; core suite 332 pass.
- E2E-16: Test connection in the console now shows `TABLES 5`; admin suite 44 pass. Its regression test creates a table in `slime_meta` that the reader can't read and expects 5.
- E2E-16 follow-up (77d2b65): the count is the runtime's describe query (`core/src/sources/sql/postgres/describe.ts`), so a readable table outside `public` or a materialized view no longer counts, and a view in `public` does. The admin CI job now runs these tests against the demo Postgres with `REQUIRE_DB=1` (2d67e15); before, they skipped there.

None of the open items overlapped PR #22 (`fix/request-errors`, merged into
the branch before the PR) or PR #33 (`feat/cloud-mvp`, docs only).

## Decisions needed

1. **Landing contract (E2E-02, E2E-08, E2E-11, E2E-15).** The landing page
   promises an API and behaviour the product doesn't have.
   - (a) Rewrite the landing demo to the real API (`POST /v0/query`,
     `{intent, input, output}`), Liquid on the 3rd call, Crystal as "its own
     route", and Postgres as the only live source. Cheapest; landing only.
   - (b) Implement `GET /slurp?want=&shape=` as an alias of `/v0/query` in the
     runtime, keep the copy. A new public contract to support; the other three
     mismatches remain.
   - Recommended: (a).
   - Decided: (a), done in 35f5720.
2. **Landing → console (E2E-04).** Add a "Get started" CTA. It needs the
   production console URL, which is not fixed yet. Recommended: add it once
   the cloud URL exists (#33).
   - Decided: the console runs at https://admin.amaslakov.com/; the closing
     CTA links there since 35f5720.
3. **Offline discoverability (E2E-03).** Obsolete: #40 removed the Offline
   provider.
4. **Default provider (E2E-12).**
   - (a) Pre-select Offline when the admin has no model key. Obsolete since #40.
   - (b) Keep Claude and show the missing-key warning in the form before
     creation.
   - Recommended: (b): it keeps the production default and shows the problem
     before the user commits.

## Limits

- Offline only: no live generation, no reviewer, no Groq/Claude repair loop
  was exercised. Free-form questions return 422 by construction in this mode.
- DynamoDB Local and the demo Postgres were shared with other local sessions;
  core and example DB tests wrote `slime_meta` in that Postgres, as CI does on
  a fresh database.
- The tester's "don't read the repository" rule was enforced by instruction
  only; every finding was reproduced independently, so leaked knowledge could
  not create a false bug.
- The provisioner (AWS-only) and the cloud stack were not run.
