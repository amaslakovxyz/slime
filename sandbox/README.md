# Slime sandbox

A working prototype of Slime v0, used to measure how fast and how correct
request-time code generation is. One data endpoint receives
`{ intent, input, output }`. On a new request, Claude writes a read-only SQL query
plus an optional JavaScript shaping function. Slime runs them safely against a
demo Postgres, checks the result matches `output`, caches the handler, and returns
the data. Repeat requests skip Claude.

## Setup

1. Start Docker, then the demo database. It contains a made-up SaaS billing
   schema and two users: `slime_reader`, which can only read, and
   `slime_writer`, which owns Slime's own `slime_meta` schema.
   ```bash
   npm install
   npm run db:up
   ```
   If you created the database before `slime_writer` existed, recreate it with
   `npm run db:down && npm run db:up`. This deletes only demo data.
2. Create `.env` from the template:
   ```bash
   cp .env.example .env
   ```
   Then choose who writes handlers with `SLIME_PROVIDER`:
   * `groq`: Groq has a free tier. Put the key in `GROQ_API_KEY`.
   * `claude`: get an API key at <https://console.anthropic.com> → Settings →
     API Keys. The Claude API is billed separately from a Claude.ai Pro/Max
     subscription.
   * `offline`: uses the hand-written handlers in
     [offline/handlers.json](offline/handlers.json). No key needed.

   `.env` is git-ignored; never commit a key.

## Run the tests

```bash
npm run db:up   # database tests are skipped if Postgres isn't running
npm test
```

The tests use stub generators and reviewers, so they need no API key. They
cover the cache key, lint, the shaping sandbox, the read-only database user,
the engine and tiers, and saving Liquid handlers. Persistence tests use their
own table (`slime_meta.handlers_test`), so they never touch a dev server's
saved handlers.

CI runs the same tests against a Postgres service on every push and pull
request (`.github/workflows/ci.yml`).

## Measure speed and correctness

```bash
npm run bench                       # all cases
npm run bench -- revenue_by_month   # one case
```

For each case the bench:

1. sends a new request (Gas);
2. sends it again (must be a cache hit);
3. sends it with different input values (must still be a hit, and still correct).

Answers are compared to hand-written reference queries in
[src/bench-cases.ts](src/bench-cases.ts). Two cases check refusals: a hidden
column and a delete request. All timings are measured on the server.

The bench always starts from an empty in-memory store, so earlier saved
handlers can't turn its new requests into cache hits. With
`SLIME_PROVIDER=offline npm run bench` you get Slime's own overhead with no
model time (about 5–40 ms for a new request).

## Run the server

```bash
npm run dev
```

```bash
curl -s localhost:3000/v0/query -H 'content-type: application/json' -d '{
  "intent": "top N accounts by total paid invoice amount in cents, highest first",
  "input":  { "limit": 5 },
  "output": [ { "name": "string", "totalPaidCents": "integer" } ]
}' | jq
```

The response is `{ data, meta }`. `meta` includes:

* `tier` (`gas` / `liquid`);
* `cache` (`miss` / `hit` / `coalesced`);
* `timingsMs` (`generate`, `check`, `execute`, `shape`, `total`);
* the generated `sql` and `shapeJs`;
* the model's `assumptions`;
* `warnings`.

Errors are `{ error: { code, message, retryable } }`.

| Endpoint | Purpose |
|---|---|
| `POST /v0/query` | The data endpoint. |
| `GET /healthz` | Read-only self-check of the DB user, plus handler counts per tier. |
| `GET /v0/handlers` | Every cached handler with its SQL, tier and hit count. |
| `DELETE /v0/handlers/:id` | Evict a handler, for example after a wrong answer. |

Admin routes have no authentication: the server listens on `127.0.0.1` only.

### Writing `output`

* **Leaves:** type names: `"string"`, `"number"`, `"integer"`, `"boolean"`,
  optionally with `"|null"`.
* **Lists:** `[ X ]` means a list of `X`.
* **Objects:** an object means exactly those keys.

Put values in `input`, never in `intent`. The cache key uses the intent text,
the output shape and the input key names and types, never the values. So
`limit: 5` and `limit: 10` share one handler, while "top 5" written into the
intent does not.

## Tiers

* **Gas:** newly generated. It lives in memory only, in a holding area, for
  `GAS_WINDOW_MS`.
* **Liquid:** a Gas handler that had `GAS_TO_LIQUID_HITS` **successful** runs
  within the window **and** passed the background review. Failed runs don't
  count.
* **Crystal:** (not built yet) optimized code that ships as part of the app.

### Saved Liquid handlers

On promotion, a Liquid handler is saved to `slime_meta.handlers` as
`slime_writer`. On startup, Slime loads every saved handler that matches the
current schema hash, prompt hash and model, so a restart keeps them.
A handler saved under a different schema, prompt or model is ignored and gets
regenerated.

Each saved row holds:

* the code, plus a hash of it. A row whose code no longer matches its hash
  is refused on load.
* the review result and the previous versions.
* up to `FIXTURES_PER_HANDLER` recorded successful runs on distinct inputs.
  Crystal's equivalence test will replay these.

Locked mode loads saved handlers too. So you can warm the cache in explore
mode, restart with `SLIME_MODE=locked`, and serve only those handlers.

### Background review

A new handler can pass every automatic check and still mean the wrong thing.
For example, it might rank the most *active* accounts as the highest churn
risk. So each new Gas handler gets a background review. The review is queued
off the request path, so the response never waits for it.

1. A second model pass reads the request and the generated SQL and shaping
   code. It never sees row data. It returns `approve`, or `reject` with
   concrete problems.
2. **On reject,** Slime regenerates the handler with the reviewer's notes.
   The revision replaces the old code only if it passes the same database and
   shape checks. The old version is kept in the handler's history, and
   responses show the revision number in `meta.review`.
3. **Still rejected after `MAX_REVIEWS` reviews:** the handler stays Gas, so it
   never becomes Liquid and expires with the window. Every response it serves
   carries a warning.

`GET /v0/handlers` shows each handler's review status, the reviewer's notes and
any previous versions. The schema's table and column comments are shown to
both models, so documenting what columns mean helps both of them.

On Groq's free tier, reviews share the rate limit with live generations. While
reviews are running, new requests can wait. Use a separate key or a paid tier
for demos.

## Safety

The real boundary is the database user. Each layer below it is extra protection.

| Layer | What it does |
|---|---|
| Postgres role `slime_reader` | `SELECT` only on allowed tables and columns; `password_hash` is not granted. The server refuses to start if its user can write. |
| Read-only transaction + timeouts | Every query runs inside `BEGIN READ ONLY`, with a 2 s timeout set both in Postgres and in Node. A query can't lift the Node timeout. |
| Subquery wrapper + row cap | `SELECT * FROM (<generated>) LIMIT cap+1`. A second statement becomes a syntax error, and the row count is capped. |
| Lint | Rejects write keywords and wrong `$n` mappings. Also rejects input values hardcoded into the code. |
| QuickJS in a worker thread | Shaping code has no I/O and is limited to 200 ms and 32 MB. If a long native call can't be interrupted, the worker is killed. |
| Model never sees values | Only input names and types are sent to Claude, never values or rows. |
| Separate storage user | Saved handlers live in `slime_meta`, owned by `slime_writer`. `slime_reader`, which runs generated SQL, can't read or change them. |

## Tuning for speed

Generation time is almost all model time. Settings to try, comparing the bench
output each time:

* `SLIME_EFFORT=low|medium|high`
* `SLIME_THINKING=on|off`
* `SLIME_MODEL=claude-haiku-5-5` (default), or a larger model if first-try
  correctness is too low
