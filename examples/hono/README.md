# Hono example

The smallest app around `@slime-cloud/core`: one file, two endpoints.

- `GET /health` returns `slime.stats()`.
- `GET /plans` asks Slime for the number of accounts on each plan.

```sh
(cd ../express && npm run db:up)   # the demo database
npm install
GROQ_API_KEY=... npm start
curl localhost:3000/plans
```

`DATABASE_URL` and `PORT` override the defaults. Generated handlers are saved
in `.slime/`. For locked mode, Crystal, offline handlers and tests, see
[examples/express](../express/README.md).
