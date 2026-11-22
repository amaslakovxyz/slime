# Multi-source example

One Slime instance over four sources: the demo Postgres database (`db`),
Notion (`notion`), the public Studio Ghibli films API (`films`) and the public
Frankfurter euro exchange rates (`rates`). A handler can read from several of
them and combine the rows in `shape(data, input)`.
The design is in [core/docs/multi-source.md](../../core/docs/multi-source.md).

| File | What |
|---|---|
| `src/app.mjs` | Hono: `POST /slime`, `POST /crystallize` and `GET /health` |
| `src/config.mjs` | The four sources, the model choice, fixture replay, the Crystal folder |
| `src/films.mjs`, `src/rates.mjs` | The two public APIs as app-defined sources (`defineApiSource`) |
| `test/canned-handlers.json` | Hand-written handlers for the four demo intents, used by the tests instead of a model |
| `test/fixtures/` | Recorded Notion, films and rates responses |

## Run it with recorded APIs (no Notion account needed)

```sh
(cd ../express && npm run db:up)   # the demo database
npm run build -w @slime-cloud/core -w @slime-cloud/crystal --prefix ../..   # once
npm install
GROQ_API_KEY=... npm run start:fixtures   # or ANTHROPIC_API_KEY: a model writes the handlers
curl localhost:3000/slime -H 'content-type: application/json' -d '{
  "intent": "accounts on a given plan with their total paid revenue in cents and their number of open negative feedback items, most open items first",
  "input": { "plan": "Enterprise" },
  "output": [{ "name": "string", "paidCents": "integer", "openNegative": "integer" }]
}'
```

The other demo intents are in `test/canned-handlers.json`. The fourth one
(Postgres + Notion + rates) is the Customer 360 panel of
[examples/customer-site](../customer-site/README.md).

## Run it against your own Notion

1. Fill `.env`: copy `.env.example`; the comments at its top walk through
   creating the page and the two integrations:
   - **Slime reader** with only *Read content*. Slime uses this one. It is
     read-only because the adapter calls only read endpoints *and* the
     integration can't write.
   - **Slime seeder** with *Insert content*, used only to create demo data.
2. `npm run notion:check` checks both tokens and that both integrations can
   open the page.
3. `npm run notion:seed` creates "Customer feedback" and "Movie nights" under
   the page and writes their ids into `.env`.
4. `npm run notion:record` records the responses the tests replay into
   `test/fixtures/notion/` and `core/test/fixtures/notion-recorded/`. It keeps
   only the fields the adapter reads and replaces real ids with placeholders.
   Review the diff before committing.
5. `npm start` serves the app against real Notion. Set `GROQ_API_KEY` or
   `ANTHROPIC_API_KEY`: the model writes a handler for each new request.
6. `npm run live` runs the three intents against real Notion, the films API
   and a model until each is promoted (P6.5).

## Crystal

`POST /crystallize` (`{ keys? }`) runs a `Crystallizer` from
`@slime-cloud/crystal` on the instance, as in the other examples. A handler that
is ready (10 successful runs) becomes a module in `slime-crystal/`: its steps
(Postgres, Notion, films) unchanged, and its `shape(data, input)` checked by the
allowlist, then run in the app's process. The equivalence test calls the real
sources (or the recorded ones with `FETCH_FIXTURES=1`), so it runs on the
instance. Its service in `slime-crystal/services.mjs` takes the app's sources
map, not only the connector.

## Development only

`POST /slime` passes the request body straight to Slime, so anyone who can
reach it can make Slime generate queries over everything the
database user and the Notion integration can read, and spend your Notion and
model quota (core/docs/multi-source.md, S7); `POST /crystallize` writes into
this folder. In production, let each endpoint
choose its intent and set identity values on the server (R11), and
crystallize the handlers you rely on.
