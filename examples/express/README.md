# Slime example: Express

## Overview

An Express app whose endpoints are answered by `@slime-cloud/core` against
the demo database. It shows the setup PLAN.md recommends (R8, R11):

- Each endpoint picks its intent and output and builds the input on the
  server. Clients never send an intent or an identity value.
- A Groq or Claude key is required: a request no saved handler (`.slime/`)
  or Crystal handler (`slime-crystal/`) answers is written by that model.
- Crystallize the handlers you rely on, so production serves reviewed code.

It also holds the demo database (`db/init.sql` and `docker-compose.yml`) that
core's tests and CI use.

## Interface

Run from this folder:

```bash
npm run build -w @slime-cloud/core -w @slime-cloud/crystal --prefix ../..   # once: the example imports their dist/
npm install
npm run db:up                                          # the demo Postgres on localhost:54329
npm start                                              # http://localhost:3000
```

Endpoints:

| Route | Intent |
|---|---|
| `GET /api/plans/accounts` | number of accounts on each plan |
| `GET /api/accounts/top?limit=5` | top N accounts by total paid invoice amount |
| `GET /api/revenue/monthly?since=2026-06-01` | paid revenue per month since a date |
| `GET /api/accounts/failed-invoices?since=2026-01-01` | accounts with failed invoices since a date |
| `GET /health` | `slime.stats()` |
| `POST /dev/query` | any `{ intent, input, output }`, **only with `SLIME_DEV_QUERY=1`** |
| `POST /dev/crystallize` | `{ keys? }`: ready handlers → Crystal in `slime-crystal/`, **only with `SLIME_DEV_CRYSTALLIZE=1`** |

Environment (put it in `.env`: `npm start` and `npm run crystallize` load it,
and git ignores it; `.env.example` lists the variables):

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | the demo `slime_reader` | a read-only database user |
| `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | unset | **required for `npm start`**: the model that writes handlers |
| `SLIME_DEV_QUERY` | unset | `1`: add `POST /dev/query` (local development only) |
| `SLIME_DEV_CRYSTALLIZE` | unset | `1`: add `POST /dev/crystallize` (local development only: it writes into `slime-crystal/`) |
| `SLIME_STORE_DIR` | `./.slime` | where saved (Liquid) handlers are kept |
| `PORT` | `3000` | |

From a new request to Crystal:

1. Call the endpoints. After 3 successful runs a handler is
   reviewed (with a model key) and saved to `.slime/`.
2. After 10 runs it is ready: with `SLIME_DEV_CRYSTALLIZE=1`,
   `curl -X POST localhost:3000/dev/crystallize` writes it to `slime-crystal/`
   (a `Crystallizer` on the running instance, which sees the live run counts;
   `npm run crystallize` reads only the store, whose counts stop at promotion).
   With a model key, an optimizer tries to simplify the code first.
3. Commit `slime-crystal/`. CI runs `npm run check:crystal`.
4. The server loads `slime-crystal/index.mjs` at startup and serves those
   handlers in-process; app code can also call `slime-crystal/services.mjs`
   directly, typed, without Slime.

## Invariants

- **`/dev/query` is off unless `SLIME_DEV_QUERY=1`.** It lets a caller
  generate queries against everything the database user can read.
- **Values from the query string are passed as values,** never written into
  an intent.
- **Run `check:crystal` in CI.** Crystal code runs without a sandbox, and the
  check is what catches a hand-edited module.

## Side Effects

- Reads and writes `.slime/` (handlers) and `slime-crystal/` (Crystal).
- Calls the model provider for every new request.

## Verification

- `npm test` runs the endpoints against the demo database with canned
  handlers (`test/canned-handlers.json`, through `cannedGenerator` from
  `@slime-cloud/core/testing`), so it needs no model key. It is skipped when Postgres is down, unless `REQUIRE_DB=1`.
- CI's "Example app" job packs core, installs the tarball here instead of the
  local link, and runs the tests and `check:crystal`.
