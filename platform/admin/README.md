# @slime-cloud/admin

The Slime Cloud admin (Next.js): sign up, create endpoints, the Lifecycle tab
(Gas → Liquid → Crystal, Crystallize), usage, and an estimated bill. It runs
locally. Design: [docs/architecture/slime-cloud.html](../../docs/architecture/slime-cloud.html);
Lifecycle tab and local runner:
[endpoint-lifecycle-tab-design.md](../../docs/architecture/2026-11-21-endpoint-lifecycle-tab-design.md).

## Run the local stack

Needs Node ≥ 22 and Docker. Run from the repository root once:

```sh
npm ci && npm run build -w @slime-cloud/core      # the runtime imports core's dist/
(cd platform/runtime && npm ci)                   # the runner starts endpoints from here
(cd examples/express && npm run db:up)            # demo Postgres on localhost:54329
```

Then from `platform/admin`:

```sh
npm ci
cp .env.example .env.local    # set SESSION_SECRET to 32+ random characters
npm run infra:up              # DynamoDB Local :8000, Jaeger :16686 (OTLP :4318)
npm run tables                # slime-control and slime-handlers
npm run local                 # admin on :3100 (PORT=…) + local runner
```

Open http://localhost:3100, create an account, and create an endpoint with
the demo database's read-only role:
`postgres://slime_reader:slime_reader@localhost:54329/slime`. Pick **Offline**
to run without a model key; Claude or Groq need `ANTHROPIC_API_KEY` or
`GROQ_API_KEY` in the environment of `npm run local` (the runner passes it to
the endpoints, nothing else reads it). The endpoint turns `ready` within a few
seconds, and its URL (`http://localhost:87xx/`) is in the Lifecycle tab.

| Command | Does |
|---|---|
| `npm run local` | `next dev` and [scripts/local-runner.ts](scripts/local-runner.ts) together; Ctrl+C stops both and every endpoint |
| `npm run runner` | the runner alone (the local stand-in for `slime-provisioner`) |
| `npm run seed -- <ep-id>` / `-- --owner <email>` | a month of demo usage, for the Usage and Billing charts |
| `npm test` | unit tests; DynamoDB Local tests skip unless it is up (`REQUIRE_DYNAMO=1` makes that a failure, as in CI) |
| `npm run typecheck`, `npm run build` | as CI runs them |

## Local runner

Runs each endpoint as a `platform/runtime/src/local.ts` process on localhost
instead of a Lambda, through the same `slime-control` states as the
provisioner: `pending`/`updating` → start → `ready` | `failed`; `deleting` →
stop, remove the Liquid handlers, the Crystal folder
(`.data/endpoints/<id>/`), the control item, then the secrets
(`.data/secrets.json`). Usage items (`USAGE#<id>`) stay, as on AWS. An
endpoint keeps its port across restarts, so the URL an agent holds survives.

## Several checkouts on one machine

Every checkout's `docker compose` project is named `admin` (the folder name),
so all worktrees share one DynamoDB Local and one Jaeger. That is supported:
each runner acts only on endpoints whose secrets its own `.data/` holds. Two
consequences:

* Run each admin on its own port: `PORT=3200 npm run local`.
* DynamoDB Local runs `-inMemory`: `npm run infra:down` (or restarting the
  container) wipes the users and endpoints of **every** checkout. Stop it only
  when no other stack uses it.
