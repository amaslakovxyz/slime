# Slime example: Express

## Overview

An Express app whose endpoints are answered by `@slime-cloud/core` against
the demo database. It shows the setup PLAN.md recommends (R8, R11):

- Each endpoint picks its intent and output and builds the input on the
  server. Clients never send an intent or an identity value.
- **Explore mode in development** generates handlers for new requests:
  - with a Groq or Claude key, a model writes them;
  - without a key, the offline handlers in `offline-handlers.json` stand in.
- **Locked mode in production** (`SLIME_LOCKED=1`) serves only handlers
  saved in `.slime/` and Crystal handlers in `slime-crystal/`.

It also holds the demo database (`db/init.sql` and `docker-compose.yml`) that
core's tests and CI use.

## Interface

Run from this folder:

```bash
npm run build -w @slime-cloud/core --prefix ../../..   # once: the example imports core's dist/
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
| `POST /dev/query` | any `{ intent, input, output }`, **explore mode only** |

Environment (put it in `.env`: `npm start` and `npm run crystallize` load it,
and git ignores it; `.env.example` lists the variables):

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | the demo `slime_reader` | a read-only database user |
| `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | unset | a model writes handlers; without a key, the offline handlers do |
| `SLIME_LOCKED` | unset | `1`: locked mode, no generation |
| `SLIME_STORE_DIR` | `./.slime` | where saved (Liquid) handlers are kept |
| `PORT` | `3000` | |

From explore to Crystal:

1. Call the endpoints in explore mode. After 3 successful runs a handler is
   reviewed (with a model key) and saved to `.slime/`.
2. `npm run crystallize` writes proven handlers to `slime-crystal/`. With a
   model key, an optimizer tries to simplify them first.
3. Commit `slime-crystal/`. CI runs `npm run check:crystal`.
4. The server loads `slime-crystal/index.mjs` at startup and serves those
   handlers in-process.

## Invariants

- **`/dev/query` is never on in locked mode.** It lets a caller generate
  queries against everything the database user can read.
- **Values from the query string are passed as values,** never written into
  an intent.
- **Run `check:crystal` in CI.** Crystal code runs without a sandbox, and the
  check is what catches a hand-edited module.

## Side Effects

- Reads and writes `.slime/` (handlers) and `slime-crystal/` (Crystal).
- Calls the model provider when a key is set.

## Verification

- `npm test` runs the endpoints against the demo database with the offline
  handlers. It is skipped when Postgres is down, unless `REQUIRE_DB=1`.
- CI's "Example app" job packs core, installs the tarball here instead of the
  local link, and runs the tests and `check:crystal`.
