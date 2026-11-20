# Slime sandbox

A working prototype of Slime v0, used to measure how fast and how correct
request-time code generation is. One data endpoint receives
`{ intent, input, output }`. On a new request, Claude writes a read-only SQL query
plus an optional JavaScript shaping function. Slime runs them safely against a
demo Postgres, checks the result matches `output`, caches the handler, and returns
the data. Repeat requests skip Claude.

## Setup

1. Start Docker, then the demo database (a made-up SaaS billing schema and a
   read-only `slime_reader` user):
   ```bash
   npm install
   npm run db:up
   ```
2. Create `.env` from the template and add a Claude API key:
   ```bash
   cp .env.example .env
   ```
   Get a key at <https://console.anthropic.com> → Settings → API Keys. The Claude
   API is billed separately from a Claude.ai Pro/Max subscription, so the
   console account needs credits. `.env` is git-ignored; never commit the key.

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

* **Gas:** newly generated. It stays in a holding area for `GAS_WINDOW_MS`.
* **Liquid:** a Gas handler that reached `GAS_TO_LIQUID_HITS` requests within
  the window. It is kept.
* **Crystal:** (not built yet) optimized code that ships as part of the app.

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

## Tuning for speed

Generation time is almost all model time. Settings to try, comparing the bench
output each time:

* `SLIME_EFFORT=low|medium|high`
* `SLIME_THINKING=on|off`
* `SLIME_MODEL=claude-haiku-5-5` (default), or a larger model if first-try
  correctness is too low
