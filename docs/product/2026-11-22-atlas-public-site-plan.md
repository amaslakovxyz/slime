# Atlas public site: plan and record

* **Status:** Record. Executed 2026-11-22: live at
  <https://g2a4gnm6afgghto6jah6qdxrpu0ycxbq.lambda-url.eu-central-1.on.aws/>.
  The custom domain (step 2) is not done.
* **Why:** hackathon visitors open a real URL on their own phone and see the customer's
  console answered by Slime Cloud, instead of trusting a localhost demo.
* **Related:** [atlas-demo.md](atlas-demo.md) (what Atlas is, for the audience),
  [atlas-demo-cheatsheet.md](atlas-demo-cheatsheet.md) (user side vs service side),
  [platform/infra/atlas/README.md](../../platform/infra/atlas/README.md) (operating the stack).

## Goal

Serve the existing `examples/customer-site` app (Hono, three panels, keys on the server)
publicly, fast. The two Slime Cloud panels run live; the self-hosted Customer 360 panel
says it is shown at the demo table.

## Decisions

| Question | Decision | Why |
|---|---|---|
| What to deploy | The existing site, unchanged except an off switch and a Lambda entry | It already proxies panels to Slime with keys server-side and refuses unoffered input values |
| Where | Lambda `slime-atlas` with a public Function URL (auth `NONE`) | Fastest path. CI already deploys every `platform/infra/<stack>/`; about $0 idle |
| CloudFront / domain | Not now (step 2) | Answers are live, so a cache adds nothing. CloudFront OAC cannot sign browser POSTs, so a domain would copy the admin's pattern (URL auth `NONE` + secret origin header), not the landing's |
| Secrets | SSM SecureString `/slime/atlas/*`, read at cold start by `src/lambda.mjs` | `slm_`/`slc_` stay out of Terraform state and the Lambda console |
| Customer 360 | `MULTI_SOURCE_URL=off` → `route: null` → `503 NOT_CONFIGURED` with a self-hosted hint | It needs a self-hosted Slime with a model key and Notion. `off` is an explicit value, because SSM cannot store an empty string and `''` already meant "use localhost" |
| Abuse | No WAF. Kill switch: reserved concurrency 0 | The page can only send offered values, so it never triggers a generation; the worst case is Lambda and RDS reads |

## Step 1: Function URL (done)

| Change | File |
|---|---|
| `MULTI_SOURCE_URL=off` turns the Customer 360 panel off, with a panel-specific message; test added | `examples/customer-site/src/app.mjs`, `test/app.test.mjs` |
| Lambda entry: settings from SSM, `hono/aws-lambda` `handle()` | `examples/customer-site/src/lambda.mjs` |
| The page no longer shows an empty route badge and "round trip undefined ms" for the site's own errors | `examples/customer-site/public/index.html` |
| Stack: role (logs + `GetParametersByPath` on `/slime/atlas/`), log group, function (Node 22, arm64, 256 MB, 30 s), public URL and its two permissions | `platform/infra/atlas/*.tf` |
| Bundle: the site with production `node_modules` into `.build/site` | `platform/infra/atlas/build.sh` |
| CI redeploys on site changes | `.github/workflows/terraform.yml`: `examples/customer-site/**` in both trigger lists and `DEPLOY_PATHS` |
| SSM: `SLIME_URL`, `SLIME_API_KEY`, `CRYSTAL_PLAN_REVENUE_KEY/TOKEN`, copied from `/slime/endpoints/ep-290cbb5eb4/` without printing values | by hand; the command is in the stack README |

First apply by hand from the branch (`AWS_PROFILE=slime`, role `slime-deployer`):
7 added. After merge, CI applies the same code.

### Verified (2026-11-22)

| Check | Result |
|---|---|
| `npm test` in `examples/customer-site` | 10/10 pass, including the off switch |
| `terraform fmt`, `validate`, `tflint` | clean |
| `trivy config --severity HIGH,CRITICAL` (the CI gate) | no findings (two LOW: log group KMS, X-Ray, same as the other stacks) |
| `GET /` | `<title>Atlas · Customer console</title>` |
| `GET /api/panels` | plan-revenue `crystal`, churn-risk `query`, customer-360 `null` |
| Revenue by plan ×2 | `tier: crystal`, 4 rows, 5.4-5.8 ms engine, 460 ms cold / 28 ms warm round trip |
| Churn risk FR / ES / DE | `tier: liquid`, `cache: hit`, 6 / 5 / 0 rows, 5.7-7.5 ms engine |
| Customer 360 | 503 `NOT_CONFIGURED`, card says "not configured" |
| Unoffered value (`country: XX`) | 400 `INVALID_REQUEST`, Slime not called |
| Browser (headless Chromium) | three cards render; Crystal and Liquid badges, tables, "The code that answered" |

## Step 2: `atlas.amaslakov.com` (optional, not done)

Add `domain.tf` to `platform/infra/atlas` following `platform/infra/platform/admin.tf`:

1. `random_password` origin secret; the function gets it as `ATLAS_ORIGIN_SECRET`, and
   `src/lambda.mjs` returns 403 unless `x-atlas-origin` equals it (and refuses all when
   it is unset).
2. ACM certificate for `atlas.amaslakov.com` in `us-east-1`, DNS-validated in the
   existing zone (copy `landing/domain.tf`).
3. CloudFront: origin = Function URL host with the `x-atlas-origin` custom header,
   `origin_read_timeout = 30`, `Managed-CachingDisabled`,
   `Managed-AllViewerExceptHostHeader`, `Managed-SecurityHeadersPolicy`, all methods
   allowed.
4. Route 53 `A`/`AAAA` aliases; output `cloudfront_distribution_id` so CI invalidates it.
5. Add an `AWS-0011` (no WAF) entry to `.trivyignore.yaml`, as for the landing and admin.

Known risk: `CreateDistribution` failed with `InvalidViewerCertificate` under
`slime-deployer` for the landing; retry under `AWS_PROFILE=default`.

## Review ledger

- **Answered: "a public page with an `slm_` key burns model tokens."** The browser
  sends only a panel id and one of the offered values (`inputProblem` in `app.mjs`);
  intent and output are fixed on the server, so every request maps to an existing Liquid
  handler or the Crystal. A new generation needs a code change.
- **Answered: "copy the landing's OAC setup."** OAC needs `x-amz-content-sha256` on POST,
  which browsers do not send. Step 1 uses no CloudFront; step 2 follows the admin.
- **Answered: "secrets end up in state."** Only names and the SSM prefix are in state;
  values are read at runtime.
- **Answered: "CI will not redeploy on site changes."** `examples/customer-site/**`
  is a trigger path and in `DEPLOY_PATHS`.
- **Deferred: Customer 360 on the public site.** Needs a hosted multi-source server with a
  model key and Notion tokens.
- **Deferred: rate limiting.** No WAF (≈ $5+/month); kill switch in the stack README.
- **Survived (risk): the copied keys go stale.** Rotating the endpoint key or
  re-crystallizing in the admin breaks the public panels until `/slime/atlas/*` is
  re-copied (stack README, "Settings").
