# Slime example: Express

## Overview

An Express app with three endpoints: Slime (`POST /slime`), crystallize
(`POST /crystallize`) and health (`GET /health`), against the demo database.

- A client sends the whole request: `{ intent, input, output }`.
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

| Route | Body | Answer |
|---|---|---|
| `POST /slime` | `{ intent, input?, output }` | Slime's `{ data, meta }` |
| `POST /crystallize` | `{ keys? }` | `{ reports }`: ready handlers → Crystal in `slime-crystal/` |
| `GET /health` | | `slime.stats()` |

```bash
curl -X POST localhost:3000/slime -H 'content-type: application/json' \
  -d '{"intent":"top N accounts by total paid invoice amount in cents, highest first","input":{"limit":5},"output":[{"name":"string","totalPaidCents":"integer"}]}'
```

Environment (put it in `.env`: `npm start` loads it, and git ignores it;
`.env.example` lists the variables):

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | the demo `slime_reader` | a read-only database user |
| `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | unset | **required for `npm start`**: the model that writes handlers (and, Claude first, optimizes them on crystallize) |
| `SLIME_STORE_DIR` | `./.slime` | where saved (Liquid) handlers are kept |
| `PORT` | `3000` | |

From a new request to Crystal:

1. Call the endpoints. After 3 successful runs a handler is
   reviewed (with a model key) and saved to `.slime/`.
2. After 10 runs it is ready: `curl -X POST localhost:3000/crystallize`
   writes it to `slime-crystal/` (a `Crystallizer` on the running instance,
   which sees the live run counts). An optimizer tries to simplify the code first.
3. Commit `slime-crystal/`. CI runs `npm run check:crystal`.

`node scripts/grow-crystals.mjs` does steps 1–2 through the same two endpoints,
without a model (canned handlers, the demo database): it is how `.github/workflows/crystal-agents.yml`
feeds the Crystal agent loop (`crystal/README.md`, "Agent loop"). The tests
set `crystal: false`, so whatever `slime-crystal/` holds, they grow their own.
4. The server loads `slime-crystal/index.mjs` at startup and serves those
   handlers in-process; app code can also call `slime-crystal/services.mjs`
   directly, typed, without Slime.

## Invariants

- **Three endpoints.** Each request carries its own intent; there are no named routes.
- **`/slime` answers anything the database user can read,** and `/crystallize`
  writes into this app's source folder: outside a demo, put both behind your
  own auth and use a read-only database user that sees only what callers may.
- **Input values are passed as values,** never written into an intent.
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
