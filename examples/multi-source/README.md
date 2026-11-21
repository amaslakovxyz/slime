# Multi-source example

One Slime instance over three sources: the demo Postgres database (`db`),
Notion (`notion`) and the public Studio Ghibli films API (`films`). A handler
can read from several of them and combine the rows in `shape(data, input)`.
The design is in [core/docs/multi-source.md](../../core/docs/multi-source.md).

| File | What |
|---|---|
| `src/app.mjs` | Hono: `GET /health` and `POST /slime` |
| `src/config.mjs` | The three sources, the model choice, fixture replay |
| `src/films.mjs` | The films API as an app-defined source (`defineApiSource`) |
| `offline-handlers.json` | Hand-written handlers for the three demo intents, used without a model key |
| `test/fixtures/` | Recorded Notion and films responses |

## Run it with recorded APIs (no accounts needed)

```sh
(cd ../express && npm run db:up)   # the demo database
npm install
npm run start:fixtures
curl localhost:3000/slime -H 'content-type: application/json' -d '{
  "intent": "accounts on a given plan with their total paid revenue in cents and their number of open negative feedback items, most open items first",
  "input": { "plan": "Enterprise" },
  "output": [{ "name": "string", "paidCents": "integer", "openNegative": "integer" }]
}'
```

The other two demo intents are in `offline-handlers.json`.

## Run it against your own Notion

1. In Notion, create a page for the demo data.
2. At notion.so/my-integrations, create two internal integrations:
   - **Slime reader** with only the *Read content* capability. Slime uses this
     one. It is read-only because the adapter calls only read endpoints *and*
     the integration can't write.
   - **Slime seeder** with *Insert content*, used only to create demo data.
3. Share the page with both integrations (page menu → Connections).
4. Copy `.env.example` to `.env` and set `NOTION_TOKEN` (reader),
   `NOTION_SEED_TOKEN` (seeder) and `NOTION_PARENT_PAGE_ID`.
5. Seed the data and put the printed ids into `.env`
   (`NOTION_FEEDBACK_ID`, `NOTION_MOVIE_NIGHTS_ID`).
6. `npm start`. Set `GROQ_API_KEY` or `ANTHROPIC_API_KEY` to let a model write
   handlers; without one, the offline handlers answer the three demo intents.

## Development only

`POST /slime` passes the request body straight to Slime. In explore mode
anyone who can reach it can make Slime generate queries over everything the
database user and the Notion integration can read, and spend your Notion and
model quota (core/docs/multi-source.md, S7). In production, run locked mode
(no generator), and let each endpoint choose its intent and set identity
values on the server.
