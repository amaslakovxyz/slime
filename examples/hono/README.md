# Hono example

The smallest app around `@slime-cloud/core`: one file, two endpoints.

- `GET /health` returns `slime.stats()`.
- `POST /slime` takes `{ intent, input, output }` from the frontend and passes
  it to `slime.query()`.

```sh
(cd ../express && npm run db:up)   # the demo database
npm install
GROQ_API_KEY=... npm start
curl localhost:3000/slime -H 'content-type: application/json' -d '{
  "intent": "number of accounts on each plan",
  "input": {},
  "output": [{ "plan": "string", "accounts": "integer" }]
}'
```

`DATABASE_URL` and `PORT` override the defaults. Generated handlers are saved
in `.slime/`. For locked mode, Crystal, offline handlers and tests, see
[examples/express](../express/README.md).
