# Hono example

The smallest app around `@slime-cloud/core`: one file, three endpoints.

- `POST /slime` takes `{ intent, input, output }` from the frontend and passes
  it to `slime.query()`.
- `POST /crystallize` (`{ keys? }`) turns the handlers that are ready (10
  successful runs) into Crystal modules in `slime-crystal/`, through a
  `Crystallizer` from `@slime-cloud/crystal`. Commit the folder; the server
  serves those handlers in-process from its next start.
- `GET /health` returns `slime.stats()`.

```sh
(cd ../express && npm run db:up)   # the demo database
npm run build -w @slime-cloud/core -w @slime-cloud/crystal --prefix ../..   # once
npm install
GROQ_API_KEY=... npm start
curl localhost:3000/slime -H 'content-type: application/json' -d '{
  "intent": "number of accounts on each plan",
  "input": {},
  "output": [{ "plan": "string", "accounts": "integer" }]
}'
```

`DATABASE_URL` and `PORT` override the defaults. Generated handlers are saved
in `.slime/`. Anyone who can reach `/slime` can ask for anything the database
user can read, and `/crystallize` writes into this folder: outside a demo, put
both behind your own auth. For tests with canned handlers and the Crystal
agent loop, see [examples/express](../express/README.md).
