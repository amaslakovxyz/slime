# Customer site example

"Atlas", a made-up SaaS, has a customer console with three panels and no data
backend. Its coding agent wrote one Slime request per panel (`src/panels.mjs`)
instead of SQL, endpoints and a data layer. The use cases and the demo script are in
[docs/product/customer-demo-use-cases.md](../../docs/product/customer-demo-use-cases.md).
For the hackathon audience: [atlas-demo.md](../../docs/product/atlas-demo.md) (one page)
and [atlas-demo-cheatsheet.md](../../docs/product/atlas-demo-cheatsheet.md) (who does what,
with diagrams). Public deploy plan:
[2026-11-22-atlas-public-site-plan.md](../../docs/product/2026-11-22-atlas-public-site-plan.md).

| File | What |
|---|---|
| `src/panels.mjs` | The three panel specs: intent, output, offered input values, upstream, Crystal env names |
| `src/app.mjs` | Hono: serves the page and `POST /api/panels/:id`, which forwards to Slime with the key |
| `src/server.mjs` | Node entry (`PORT`, default 4000) |
| `public/index.html` | The page: one card per panel, the answering tier, timings and the code that answered |
| `test/app.test.mjs` | Routing, keys and input checks against a fake Slime |

| Panel | Upstream | Route |
|---|---|---|
| Revenue by plan | Slime Cloud endpoint (Postgres) | `POST /v0/e/<crystal key>` with `slc_` once `CRYSTAL_PLAN_REVENUE_*` are set, else `POST /v0/query` |
| Churn risk by country | Slime Cloud endpoint (Postgres) | `POST /v0/query` (or its Crystal, `CRYSTAL_CHURN_RISK_*`) |
| Customer 360 | Self-hosted [examples/multi-source](../multi-source/README.md) (Postgres + Notion + euro rates) | `POST /slime` |

## Run it

1. Create an endpoint in the admin on a database with the demo schema
   (`examples/express/db/init.sql`; the test RDS has it) and copy its URL and `slm_` key.
2. Start the multi-source example for the third panel (`npm start` there, with a model key).
3. Here: copy `.env.example` to `.env`, fill it, then `npm install && npm start` and open
   <http://localhost:4000>.
4. After a panel's handler is Liquid with 10 runs, Crystallize it in the admin, reveal the
   Crystal's token, and set its `CRYSTAL_*_KEY` (the Hash column) and `CRYSTAL_*_TOKEN`.

With 1Password, keep `op://` references in the env file instead of values:
`op run --env-file=.env -- npm start`.

## Boundaries

- The browser sends a panel id and input values only. Intent and output are fixed on the
  server and each input must be one of the panel's offered values, so the page cannot ask
  Slime for anything new or spend generation tokens.
- Keys stay on this server: the runtime has no CORS, and `slm_` opens the generator.
- The page shows `meta` (SQL and shape code) to explain the demo. A real public page
  would drop it.
