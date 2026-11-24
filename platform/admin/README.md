# @slime-cloud/admin

The Slime Cloud admin (Next.js): sign up, create endpoints, the Lifecycle tab
(Gas → Liquid → Crystal, Crystallize), usage, and an estimated bill. It is
hosted at https://admin.amaslakov.com (invite-only) and also runs locally.
Design: [2026-11-21-cloud-mvp-design.md](../../docs/architecture/2026-11-21-cloud-mvp-design.md)
(hosting, cloud mode); Lifecycle tab and local runner:
[endpoint-lifecycle-tab-design.md](../../docs/architecture/2026-11-21-endpoint-lifecycle-tab-design.md).

## Two modes

`SLIME_RUNTIME_URL` picks the mode ([lib/env.ts](lib/env.ts)).

| | Local (unset) | Cloud (set: the shared runtime's Function URL) |
|---|---|---|
| Endpoint | one `platform/runtime/src/local.ts` process per endpoint on `localhost:87xx` | the path `<runtime URL>ep/<id>/` on the one `slime-runtime` Lambda |
| Who moves the status | the local runner ([scripts/local-runner.ts](scripts/local-runner.ts)) | the admin's server action, in the request ([lib/cloud-endpoints.ts](lib/cloud-endpoints.ts)) |
| Create | `pending` → runner starts it → `ready` / `failed` | `provisioning` + URL → `GET healthz` (retried 1 s, up to 20 s) → `ready` / `failed` + reason |
| Connector or provider change | `updating` → runner restarts it | `updating` → `GET healthz?fresh=1` (re-reads the settings in that call) → `ready` / `failed` |
| After Crystallize | `updating` → runner restarts it with the new tokens | `POST v0/reload`; other instances catch up within 30 s |
| Delete | `deleting` → runner stops it, then the teardown | the teardown, in the request; any status, and a `deleting` the admin timeout cut off (older than 90 s) resumes; a failure leaves `failed` (deletable again) |
| Secrets | `.data/secrets.json` (`SLIME_SECRETS=file`) | SSM `/slime/endpoints/<id>/` (`SLIME_SECRETS=ssm`) |
| Crystal storage | `.data/endpoints/<id>/crystal/` | S3 `endpoints/<id>/crystal/` in `SLIME_CRYSTAL_BUCKET` |

Both modes write `DATABASE_URL`, `SLIME_API_KEY`, `SLIME_PROVIDER` and (after
Crystallize) `CRYSTAL_TOKENS` to the endpoint's secrets. One teardown
([lib/teardown.ts](lib/teardown.ts)) removes locally, in order: the Liquid
handlers, the Crystal folder, the control item, then the secrets. In the cloud the
SSM secrets go first, which stops the shared runtime serving the endpoint within
30 s even if a later step fails; then the handlers, every S3 object version, the
item. Usage items (`USAGE#<id>`) stay as billing history. In the cloud, Settings
offers **Retry check** for an endpoint an interrupted action left `provisioning`
or `updating`.

**Invite-only.** When `ADMIN_ALLOWED_EMAILS` is set (comma-separated,
case-insensitive), sign-up accepts only those emails and shows "This email is
not invited" to anyone else; existing users still sign in. Unset, sign-up is
open (local default).

## Run the local stack

Needs Node ≥ 22 and Docker. Run from the repository root once:

```sh
npm ci && npm run build -w @slime-cloud/core -w @slime-cloud/crystal   # the runtime imports their dist/
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

Open http://localhost:3100: with `ADMIN_DEV_USER` (in `.env.example`) you are
already signed in as that user, no account needed; **Log out** opens the login form, and a
session from it takes precedence, and cloud mode ignores the variable. Create an endpoint with
the demo database's read-only role:
`postgres://slime_reader:slime_reader@localhost:54329/slime`. Claude or Groq
need `ANTHROPIC_API_KEY` or `GROQ_API_KEY` in the environment of `npm run local` (the runner passes it to
the endpoints, nothing else reads it). The endpoint turns `ready` within a few
seconds, and its URL (`http://localhost:87xx/`) is in the Lifecycle tab.

| Command | Does |
|---|---|
| `npm run local` | `next dev` and [scripts/local-runner.ts](scripts/local-runner.ts) together; Ctrl+C stops both and every endpoint |
| `npm run runner` | the runner alone (the local stand-in for the cloud admin flows) |
| `npm run seed -- <ep-id>` / `-- --owner <email>` | a month of demo usage, for the Usage and Billing charts |
| `npm test` | unit tests; DynamoDB Local tests skip unless it is up (`REQUIRE_DYNAMO=1` makes that a failure, as in CI) |
| `npm run typecheck`, `npm run build` | as CI runs them |
| `npm run build:lambda` | the Lambda package, see below |
| `npm run e2e` | Playwright against the local stack, see below |
| `npm run e2e:cloud` | the Playwright smoke against the hosted admin |

## Connectors

[lib/connectors.ts](lib/connectors.ts) lists them. Both available ones store one
secret, `DATABASE_URL`, which the runtime opens with core's Postgres connector;
**Test connection** ([lib/connectors/postgres.ts](lib/connectors/postgres.ts))
runs the runtime's safety check from the admin and warns, without failing, about
readable tables whose row level security (RLS) shows the role no rows.

- **PostgreSQL**: any `postgres://` URL, stored as typed.
- **Supabase**: the create form shows SQL for a `slime_reader` role (password
  generated in the browser) and where the pooler URL is. The role gets `SELECT`
  on `public` and `BYPASSRLS`: Supabase's `ensure_rls` event trigger turns RLS on
  for every new table with policies for app users only, so without it every query
  returns no rows. The URL must use the
  pooler (`*.pooler.supabase.com`, port 5432 session or 6543 transaction, user
  `<role>.<project-ref>`): the direct host `db.<ref>.supabase.co` is IPv6-only and
  the runtime Lambda reaches the internet over IPv4. TLS is enforced: without
  `sslmode` node `pg` logs in to the pooler in plaintext (measured), so no
  `sslmode`, `prefer` or `require` is stored as `sslmode=require&uselibpqcompat=true`
  (node `pg` 8 treats a bare `require` as `verify-full`, which fails on Supabase's
  own CA); `disable`/`allow` and `verify-ca`/`verify-full` are refused, and so are
  `sslrootcert`/`sslcert`/`sslkey`, which node `pg` reads as file paths on the admin
  and runtime servers. The connection is encrypted, the certificate not verified.
  After a role's password changes, the pooler kept accepting only the old one for
  about a minute (seen on both ports), so a Test connection right after a
  rotation can fail with `password authentication failed`; retry after a minute.

## Local runner

Runs each endpoint as a `platform/runtime/src/local.ts` process on localhost
through the `slime-control` states of the table above: `pending`/`updating` →
start → `ready` | `failed`; `deleting` → stop, then the shared teardown with
the Crystal folder (`.data/endpoints/<id>/`) and the file secrets. An endpoint
keeps its port across restarts, so the URL an agent holds survives. The
provider comes from the `SLIME_PROVIDER` secret (the control item's `provider`
for endpoints created before that secret existed).

## Requests log and trace drawer

The endpoint's Requests log reads the runtime feed (`GET /v0/events`, newest
500, `?before=`/`?after=` pages, refreshed every 2 s). Clicking a row opens a
non-modal drawer on the right (`Escape` closes, `↑`/`↓` move between rows)
showing which harness layers the request passed, where it was stopped and why,
and its route: **Layers**, **Route map** and **Waterfall**, all built from
[lib/request-trace.ts](lib/request-trace.ts). Refused requests are in the log
too (`✕ <CODE> · <layer>`); unauthenticated ones are not recorded. The feed
holds input names, never input values or result rows.

Code: a generation (`cache: miss`) event carries its SQL and shape; for a hit
the drawer calls the `loadHandlerCode` server action once per handler key,
which reads `GET /v0/handlers/:key/code` (Crystal, then the instance's live
record, then the store). If none has it, the drawer reuses a miss event of the
same key on the page, else says the code is not available on this instance.
Events written before traces existed show `Trace not recorded for this request.`
Design: [2026-11-22-request-trace-drawer-design.md](../../docs/architecture/2026-11-22-request-trace-drawer-design.md).

## End-to-end tests (Playwright)

```sh
npx playwright install chromium   # once
npm run e2e                       # starts `npm run local` itself (or reuses one on :3100)
```

The `local` project ([e2e/local.spec.ts](e2e/local.spec.ts)) needs DynamoDB
Local with the tables and the demo Postgres. It starts the stack with
`ADMIN_ALLOWED_EMAILS=e2e@example.com` and walks the user journeys: a
non-invited sign-up is refused, the invited one gets in, an endpoint on the
demo database turns `ready` (locally its model is replaced by canned handlers:
`SLIME_CANNED_HANDLERS`, read only by the local runtime entry), twelve queries make its handler Liquid,
Crystallize, the Crystal route answers with its `slc_` token (which `/v0/query`
refuses), and delete removes the endpoint.

`npm run e2e:cloud` ([e2e/cloud-smoke.spec.ts](e2e/cloud-smoke.spec.ts)) runs
against https://admin.amaslakov.com (`ADMIN_URL` overrides it) with
`SMOKE_EMAIL` / `SMOKE_PASSWORD`, and is skipped without them. The email must
be in `/slime/admin/ADMIN_ALLOWED_EMAILS`; the account is created on the first
run. It has no database, so it checks only: sign-in, create → `failed` with the
database reason, the endpoint URL refuses `/v0/query` without a key (401), an
unknown id answers 404, and delete (plus the empty SSM path when AWS credentials
are present). Reports go to `playwright-report/` and `test-results/`.

## Hosted admin (AWS Lambda)

`npm run build:lambda` ([scripts/build-lambda.mjs](scripts/build-lambda.mjs))
needs no AWS access:

1. hashes every input file of this folder (not `node_modules/`, `.next/`,
   `dist/`, `.data/`, test outputs, `.env*` or generated `next-env.d.ts` /
   `*.tsbuildinfo`) plus `ADMIN_ORIGIN` (default `admin.amaslakov.com`) and the
   Node major version;
2. runs `next build` with that hash as the build id (`output: 'standalone'`,
   server actions allowed from `ADMIN_ORIGIN`);
3. assembles `dist/lambda/`: the standalone server, `.next/static`,
   [lambda/run.sh](lambda/run.sh) (the handler) and
   [lambda/start.mjs](lambda/start.mjs), which loads `SLIME_ADMIN_SSM_PREFIX`
   (`/slime/admin/`: `SESSION_SECRET`, `ADMIN_ALLOWED_EMAILS`) from SSM into
   the environment before starting `server.js`; it fails above 200 MB unzipped;
4. writes the hash, base64, to `dist/source-hash.txt`: Terraform's
   `source_code_hash`, so an unchanged admin is not redeployed although the
   zip itself differs on every build.

The function runs behind the AWS Lambda Web Adapter and CloudFront
(`platform/infra/platform/admin.tf`). CloudFront adds `x-slime-origin`; with
`SLIME_ORIGIN_SECRET` set, [proxy.ts](proxy.ts) answers 403 to any request
without the right value, so the public Function URL is usable only through
CloudFront. OpenTelemetry is registered only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set (locally, for Jaeger).

## Several checkouts on one machine

Every checkout's `docker compose` project is named `admin` (the folder name),
so all worktrees share one DynamoDB Local and one Jaeger. That is supported:
each runner acts only on endpoints whose secrets its own `.data/` holds. Two
consequences:

* Run each admin on its own port: `PORT=3200 npm run local`.
* DynamoDB Local runs `-inMemory`: `npm run infra:down` (or restarting the
  container) wipes the users and endpoints of **every** checkout. Stop it only
  when no other stack uses it.
