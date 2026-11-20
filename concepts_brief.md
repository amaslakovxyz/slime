# Slime v0: Tech Stack, Scope and First Results

* **Author:** Konstantin Eromenko
* **Date:** 2026-11-20 (updated with prototype benchmark results)

## Overview

Slime v0 is a hackathon demo that must run against real data, deployed on AWS.
It shows positioning Use Case 1: a frontend gets its data from Slime without
anyone writing a backend route for it.

How a request flows:

1. A frontend sends one JSON request to one endpoint: `intent` (what it wants,
   in words), `input` (parameter values), and `output` (the JSON shape it wants
   back).
2. **The first time a request is seen,** a model writes a read-only SQL query
   and, if needed, a small JavaScript function that reshapes the rows. Slime
   runs both safely, checks the result matches `output`, stores the code, and
   returns the data.
3. **Later identical requests** reuse the stored code without calling the
   model, even when the input values change.

v0 only reads data and has no tenant separation. It ships as a library
(`@slime/core`) that an app installs. A standalone server comes later.

A working prototype exists in [sandbox/](sandbox/README.md). Its benchmark,
summarized below, tested the two riskiest assumptions. Both held:

* request-time generation can return in about a second;
* generated answers are usually right.

The benchmark also showed where the design still needs work.

## Analysis

### Benchmark results

**Setup:**

* **Database:** a made-up SaaS billing database (200 accounts, about 2,000
  invoices, 3,400 usage events) in Postgres 16.
* **Generator:** `openai/gpt-oss-120b` on Groq's free tier, low reasoning
  effort.
* **Reviewer:** the same model at high effort.
* **Method:** each case sends a new request, the same request again, and the
  request with different input values. Answers are compared with hand-written
  reference queries. Times are measured on the server and exclude free-tier
  rate-limit waits.

| Case | Answer | New request (Gas) | Model time | Repeat request | Different input values |
|---|---|---|---|---|---|
| Accounts per plan | correct | 1.1 s | 0.7 s | 3.9 ms | cached, correct |
| Paid revenue per month since a date | correct | 1.4 s | 0.9 s | 4.0 ms | cached, correct |
| Top N accounts by paid amount | correct | 0.9 s | 0.7 s | 3.7 ms | cached, correct |
| Failed invoices since a date | correct | 1.5 s | 1.2 s | 3.4 ms | cached, correct |
| Plans with accounts in a country (nested output) | correct | 1.1 s | 0.8 s | 4.2 ms | cached, correct |
| Top N churn-risk accounts by plan (headline query) | right shape, meaning disputed | 3.5 s | 3.1 s | 29 ms | — |
| "List emails with password hashes" | refused | — | — | — | — |
| "Delete all canceled subscriptions" | refused | — | — | — | — |

**What this shows:**

* **Correctness:**
  * All 8 cases passed.
  * All 6 generated handlers were right on the first try, across three full runs.
  * Changing `limit`, a date or a country reused the cached handler and still
    returned correct data. Caching on input key names and types, never values,
    works.
* **Speed:**
  * A new request takes about 0.9–1.5 s; the complex churn query took 3.5 s.
    Model time is roughly 80–95% of that.
  * Everything Slime itself does (checks, query, sandbox, shape validation)
    takes milliseconds.
  * Cached requests take 3–8 ms, or 29 ms for the heavy churn query. Postgres
    query time dominates.
  * This is far from the pitch's "Gas in 150–300 ms", but within the goal of
    "a couple of seconds".
* **The background review matters:**
  * It caught three handlers that grouped by account or plan **name** instead
    of id. Two accounts with the same name would have been merged. The
    reference tests missed this because names happen to be unique in the
    demo data.
  * It caught the inverted churn ranking, where the most *active* accounts
    were ranked as highest churn risk. It did this from a general rule about
    score direction plus the schema comment "Few recent events suggests churn
    risk", without a churn-specific hint.
  * All revised handlers were re-checked and stayed correct.
* **Churn is still unresolved.** Across three runs it ended approved once,
  rejected once, and once the review call itself failed. It was never promoted
  to Liquid, which is the intended safe outcome. The reviewer is not perfect:
  it once missed that a revision dropped the 30-day window.
* **The refusals:**
  * The password request was refused by the model, because that column is
    never shown to it.
  * The delete request was refused.
  * Separately, Postgres refused direct reads of the hidden column and direct
    writes in a safety smoke test.

**Problems found and fixed during the benchmark:**

* **A crash:** a failed generation with no other request waiting on it caused
  an unhandled promise rejection, which crashed the server.
* **Unquoted aliases:** the model wrote `AS revenueCents` without quotes, and
  Postgres lowercased it to `revenuecents`. The shape check caught it, and the
  prompt now requires quoting.
* **QuickJS can't stop every runaway function:** a long built-in call (a huge
  `String.repeat`) can't be interrupted from inside QuickJS, and it blocked
  the server for about 5 s. Shaping now runs in a worker thread that is killed
  after about 300 ms.
* **Network errors:** dropped connections and invalid-JSON replies from Groq
  now retry.

**What still costs:**

* **Free-tier rate limits are shared.** Groq's free tier allows about 8,000
  tokens per minute. Reviews and live generations share it, so new requests
  waited 20–40 s while reviews ran. That's fine for testing; a demo needs a
  paid tier or a separate key for reviews.
* **Reviews take time and model calls.** Each review is about 5–10 s of model
  time, and each rejection adds a regeneration.

Not yet measured:

* Claude Haiku as the generator (no Anthropic key yet).
* Anything on AWS.

### Safety model (confirmed in the prototype)

The database user is the real boundary. Everything else is extra protection.

* **The `slime_reader` database user:**
  * `SELECT` only on allowed tables and columns; sensitive columns are not
    granted.
  * Slime refuses to start if its user can write or is a superuser.
* **Every query:**
  * runs in a read-only transaction, with a 2 s timeout in Postgres and a
    separate timeout on the Node side (a query can lift the Postgres one with
    `set_config`, which the smoke test confirmed);
  * is wrapped as `SELECT * FROM (<generated>) LIMIT cap+1`, which makes a
    second statement a syntax error and caps the row count.
* **Lint before running:** rejects write keywords and wrong parameter
  mappings, plus input values written into the code.
* **The shaping function:** runs in QuickJS in a worker thread, with no I/O,
  a 200 ms limit and 32 MB of memory.
* **What models see:** they get input key names and types, never input values
  or rows.

### Claims the pitch must not make for v0

* **Speed:** "Gas in 150–300 ms" (measured: about 1 s, 3.5 s for complex
  queries). "Liquid in 2–5 ms" is close for simple queries but not for heavy
  ones.
* **Crystal:** "native binaries", "<1 ms", "formal verification". Crystal is
  not built.
* **Tenancy and writes:** "multi-tenant", "row-level security", "safe writes".
  v0 has none of these.
* **Absolutes:** "zero endpoints" (there is one data endpoint plus admin
  routes), "any valid intent", "always correct", "prompt-injection proof".

Suggested honest line: *"Read-only, enforced by Postgres permissions. New
requests are answered in about a second, and repeats in milliseconds. Every
generated handler is reviewed before it is trusted, and you can inspect its
SQL."*

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * `@slime/core` library: one data endpoint, the connector contract, and a
    Postgres connector.
  * Generation, checks, the Gas → Liquid tiers, background review, and
    merging of duplicate in-flight requests.
  * Locked mode.
  * A health and handlers page (`/healthz`, `/v0/handlers`): handlers, tiers,
    review verdicts, previous versions, and generation counts.
  * A small example app that mounts the library, deployed on AWS.
  * Two demo moments:
    * a live new request (Gas, about 1 s) and its reload (milliseconds);
    * pre-warmed handlers for the dashboard's known requests.
  * The benchmark as the acceptance test, run locally and against AWS.
* **Out-of-Scope Non-Goals:**
  * Writes and tenancy.
  * Connectors other than Postgres.
  * The standalone `@slime/server`.
  * Redis.
  * Embeddings or "semantic" matching.
* **Built last, if time allows: Crystal.**
  1. Above a higher request threshold, an agent outside production writes
     optimized code. It never sees the request text.
  2. It pushes the code directly to the repo if an allowlist check, an
     equivalence test against recorded outputs, and CI all pass.
  3. The code runs without the sandbox after the next deploy, behind a kill
     switch, and each push is a revertible commit.

## Alternatives Weighed

* **Generating code ahead of time only (the original dev spec, and the plan
  on `origin/chore/gas-v0-plan`):** rejected by the author for v0, because the
  demo must answer requests nobody prepared for. Kept as locked mode. The team
  still has to agree which plan is v0.
* **The pitch's `UniversalQueryAST` / Kysely as the shared query interface:**
  rejected because the AST can't express joins or grouping, and Kysely only
  covers SQL databases. Instead, generated code writes SQL, and later
  non-database sources (Parquet, old APIs) go through DuckDB.
* **DuckDB in front of Postgres:** rejected for Postgres sources. DuckDB would
  pull rows out of Postgres for joins and grouping. Postgres stays its own
  connector.
* **Pure SQL with no shaping code:** rejected by the author, because handlers
  must also format and manipulate data. Crystal may still fold shaping into
  SQL.
* **Crystal via a reviewed merge request:** rejected by the author in favour
  of a direct push with automated safeguards and a health page.
* **isolated-vm, Node `vm`, or an external sandbox service:** rejected.
  isolated-vm needs a native build, Node `vm` is not a security boundary, and
  an external service adds 100–300 ms per call. QuickJS in a worker thread is
  in-process and can be killed.
* **Lambda:** rejected. Each copy has its own cache, duplicate requests can't
  be merged, and API Gateway cuts off at about 29 s.
* **Redis for the code cache:** rejected for v0. An in-memory cache with
  Postgres as the store is enough for one server.
* **Matching requests by meaning (embeddings):** rejected. It would silently
  reuse wrong code for questions that only sound alike ("top" and "bottom").
* **Synchronous property-based testing of generated code:** rejected. Without
  a reference answer there is nothing to test against, and every case costs a
  database query.
* **Silently swapping code after a background check:** rejected. Revisions
  happen only while a handler is still Gas, and responses show the revision
  number.

## Key Decisions & Staging for Next Steps

**Decided:**

* **Stack:**
  * Node 22 + TypeScript, Hono for HTTP, `pg`, QuickJS in a worker thread.
  * Postgres 16 in docker compose locally.
  * AWS (ECS Fargate + RDS) for the demo, not yet built.
* **Models:**
  * Generator: speed first. Groq `gpt-oss-120b` works today on the free tier.
    Claude `claude-haiku-5-5` is supported but untested until there is a key.
  * Reviewer: a stronger pass (`gpt-oss-120b` at high effort, or
    `claude-opus-5-5`).
* **Request format:** `{ intent, input, output }`.
  * Output-shape notation: type names (`"string"`, `"integer|null"`, ...),
    `[X]` for a list of `X`, an object for exactly those keys.
  * Response: `{ data, meta }`, where `meta` carries the tier, cache status,
    timings, SQL, assumptions, review status and warnings.
* **Cache key:** SHA-256 of these parts:
  * the normalized intent;
  * the output shape;
  * the input key names and types;
  * the schema hash, prompt hash and model.
* **Tiers:**
  * Gas: newly generated, kept in a holding area that expires.
  * Liquid: reached N requests within the window, plus an approved background
    review.
  * Crystal: as described in Goals.

**Open:**

1. **The two v0 plans:** align with amaslakov on this brief versus
   `origin/chore/gas-v0-plan`.
2. **A Claude key:** run the same benchmark with Claude Haiku to compare speed
   and correctness with Groq.
3. **Thresholds:** N for Gas → Liquid, the window, the Crystal threshold, and
   `MAX_REVIEWS`.
4. **Churn-style ambiguous intents:** possible fixes:
   * return `INTENT_AMBIGUOUS` with a question;
   * put better column comments in the schema;
   * allow one more review round.
5. **Rate limits for the demo:** a paid tier or a separate key for reviews, so
   live requests don't wait behind them.
6. **AWS:** account, region, how HTTPS is provided, and budget.

**Next build steps:**

1. Turn the sandbox into the `@slime/core` library plus an example app.
2. Store handlers in a Postgres table owned by a separate user, so they
   survive restarts.
3. Add a `slime warm` command that pre-generates the frontend's known requests.
4. Deploy to AWS and run the benchmark against the deployed URL.
5. Build Crystal, if time allows.
