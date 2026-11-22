# Atlas public site: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

* **Status:** Plan (2026-11-22). Nothing in this file is deployed yet.
* **Why:** hackathon visitors should open a real URL on their own phone and see the
  customer's console answered by Slime Cloud, instead of trusting a localhost demo.
* **Related:** [atlas-demo.md](atlas-demo.md) (what Atlas is, for the audience),
  [atlas-demo-cheatsheet.md](atlas-demo-cheatsheet.md) (user side vs service side),
  [customer-demo-use-cases.md](customer-demo-use-cases.md) (the three cases and the demo script).

**Goal:** serve the existing `examples/customer-site` app at `https://atlas.amaslakov.com`
with its two Slime Cloud panels live and the self-hosted panel marked "shown live".

**Architecture:** one new Terraform stack `platform/infra/atlas/`, a copy of the admin's
pattern: a Lambda (`slime-atlas`, Node 22, arm64) runs the Hono app through
`hono/aws-lambda`; a Function URL (auth `NONE`) sits behind CloudFront, which adds a
secret origin header; ACM (us-east-1) and Route 53 give it `atlas.amaslakov.com`. Slime keys
live in SSM under `/slime/atlas/` and are loaded at cold start, never in Terraform state.

**Tech stack:** Hono 4 (`hono/aws-lambda`), Node 22 Lambda runtime (bundled AWS SDK v3),
Terraform `~> 6.0` AWS provider, existing CI `terraform.yml` (plan on PR, apply on merge).

## Global constraints

- Resource names start with `slime-` and SSM paths with `/slime/` (the CI roles refuse anything else, `platform/infra/bootstrap/github_oidc.tf`).
- Region `eu-central-1`; the certificate in `us-east-1` (CloudFront requirement).
- The browser never gets a key and never sends an intent: unchanged from `examples/customer-site/src/app.mjs`.
- No new npm dependencies: `@aws-sdk/client-ssm` comes with the Lambda runtime.
- Customer 360 (panel 3) stays off the public site: it needs the self-hosted multi-source server, a model key and Notion. Its card says so.
- `meta` (SQL and shape code) stays visible: the data is synthetic and the generated SQL is the convincing part of the demo.
- Fast path over polish: no WAF, no custom error pages, no CI test job for the site.

## Decisions taken

| Question | Decision | Why |
|---|---|---|
| Where | `atlas.amaslakov.com`, a subdomain of the zone the landing and admin already use | A real domain reads as a real customer; the zone, ACM and CloudFront patterns exist (`platform/infra/landing/domain.tf`, `platform/infra/platform/admin.tf`) |
| Lambda vs container/VM | Lambda + Function URL + CloudFront | Same as admin; about $0 idle; CI already deploys every `platform/infra/<stack>/` |
| CloudFront → Function URL auth | URL auth `NONE` + secret header `x-atlas-origin` checked in the handler | OAC cannot sign browser POSTs (needs `x-amz-content-sha256`), the reason the admin does the same |
| Secrets | SSM SecureString `/slime/atlas/*`, written by hand from 1Password | Keeps `slm_`/`slc_` out of Terraform state and the Lambda console |
| Panel 3 | `MULTI_SOURCE_URL=""` on Lambda → `route: null` → card shows "not configured" and Run returns `NOT_CONFIGURED` with a clear message | Running multi-source in the cloud is a separate project; the page already renders `route: null` (`ROUTE_LABEL.null`) |
| Abuse | The page can only send offered input values, so no new generation tokens; kill switch = reserved concurrency 0 | Worst case is Lambda and RDS reads, cents |

## File map

| File | Change |
|---|---|
| `examples/customer-site/src/app.mjs` | An explicitly empty `MULTI_SOURCE_URL` turns panel 3 off; panel-specific `NOT_CONFIGURED` message |
| `examples/customer-site/test/app.test.mjs` | One test for the off switch |
| `examples/customer-site/src/lambda.mjs` | New: Lambda entry (SSM settings, origin-header guard, `hono/aws-lambda`) |
| `platform/infra/atlas/{versions,variables,main,domain,outputs}.tf`, `build.sh`, `README.md` | New stack |
| `.github/workflows/terraform.yml` | Add `examples/customer-site/**` to both trigger path lists and `DEPLOY_PATHS` |
| `examples/customer-site/README.md`, `platform/infra/README.md`, `platform/infra/FINOPS.md`, `docs/README.md` | Public URL, stack row, cost row, status flip of this plan to Record |

---

### Task 1: Site app ready for Lambda

**Files:**
- Modify: `examples/customer-site/src/app.mjs:14,18,38`
- Create: `examples/customer-site/src/lambda.mjs`
- Test: `examples/customer-site/test/app.test.mjs`

**Interfaces:**
- Consumes: `createApp({ env, fetchImpl, panels })` from `src/app.mjs` (unchanged signature).
- Produces: `export const handler` in `src/lambda.mjs`; env names `ATLAS_SSM_PREFIX`, `ATLAS_ORIGIN_SECRET`, `MULTI_SOURCE_URL` (Task 2 sets them).

- [ ] **Step 1: Write the failing test** (append to `test/app.test.mjs`)

```js
test('an empty MULTI_SOURCE_URL turns the Customer 360 panel off instead of calling localhost', async () => {
  const slime = fakeSlime();
  const app = createApp({ env: { ...CLOUD, MULTI_SOURCE_URL: '' }, fetchImpl: slime.fetchImpl });
  const panels = await (await app.request('/api/panels')).json();
  assert.equal(panels.find((panel) => panel.id === 'customer-360').route, null);
  const response = await post(app, 'customer-360', { plan: 'Enterprise', currency: 'USD' });
  assert.equal(response.status, 503);
  const { error } = await response.json();
  assert.equal(error.code, 'NOT_CONFIGURED');
  assert.match(error.message, /self-hosted/);
  assert.equal(slime.calls.length, 0);
});
```

- [ ] **Step 2: Run it, expect FAIL** (today `''` falls back to `http://localhost:3000`)

Run: `cd examples/customer-site && npm ci && npm test`
Expected: the new test fails on `route` (`'self-hosted'` instead of `null`).

- [ ] **Step 3: Implement** in `src/app.mjs`

```js
  // Unset = the local default; set to '' = no multi-source server (the public site).
  const multiUrl = trimSlash(env.MULTI_SOURCE_URL ?? DEFAULT_MULTI_SOURCE_URL);
```

```js
    if (panel.upstream === 'multi') return multiUrl ? { route: 'self-hosted', url: `${multiUrl}/slime`, headers: {}, full: true } : null;
```

```js
      if (!target) {
        const hint = panel.upstream === 'multi'
          ? 'Customer 360 runs on a self-hosted Slime (MULTI_SOURCE_URL); on the public site it is shown live at the demo table.'
          : 'Set SLIME_URL and SLIME_API_KEY (see .env.example).';
        return fail(c, 503, 'NOT_CONFIGURED', hint);
      }
```

- [ ] **Step 4: Run tests, expect PASS** — `npm test` in `examples/customer-site`: all tests pass, including the existing `the Customer 360 panel goes to the self-hosted multi-source server without a key`.

- [ ] **Step 5: Create `src/lambda.mjs`**

```js
// slime-atlas Lambda entry: the customer site behind CloudFront
// (platform/infra/atlas). Slime settings (SLIME_URL, SLIME_API_KEY, CRYSTAL_*)
// are read from SSM under ATLAS_SSM_PREFIX at cold start, so keys never sit in
// Terraform state or the Lambda console. Local runs keep using server.mjs.
import { GetParametersByPathCommand, SSMClient } from '@aws-sdk/client-ssm';
import { handle } from 'hono/aws-lambda';
import { createApp } from './app.mjs';

async function loadSettings(prefix) {
  const settings = {};
  if (!prefix) return settings;
  const ssm = new SSMClient({});
  let NextToken;
  do {
    const page = await ssm.send(new GetParametersByPathCommand({ Path: prefix, WithDecryption: true, NextToken }));
    for (const { Name, Value } of page.Parameters ?? []) settings[Name.slice(Name.lastIndexOf('/') + 1)] = Value;
    NextToken = page.NextToken;
  } while (NextToken);
  return settings;
}

const app = handle(createApp({ env: { ...process.env, ...(await loadSettings(process.env.ATLAS_SSM_PREFIX)) } }));
const originSecret = process.env.ATLAS_ORIGIN_SECRET;

// The Function URL is auth NONE (CloudFront OAC cannot sign browser POSTs).
// Only CloudFront sends this header, so direct *.lambda-url.* hits get 403.
// A missing secret refuses everything rather than opening the URL.
export const handler = async (event, context) => {
  if (!originSecret || event.headers?.['x-atlas-origin'] !== originSecret) {
    return { statusCode: 403, headers: { 'content-type': 'text/plain' }, body: 'Forbidden' };
  }
  return app(event, context);
};
```

- [ ] **Step 6: Commit**

```bash
git add examples/customer-site/src/app.mjs examples/customer-site/src/lambda.mjs examples/customer-site/test/app.test.mjs
git commit -m "feat(customer-site): Lambda entry and an off switch for the self-hosted panel"
```

### Task 2: Terraform stack `platform/infra/atlas/`

**Files:**
- Create: `platform/infra/atlas/versions.tf`, `variables.tf`, `main.tf`, `domain.tf`, `outputs.tf`, `build.sh`, `README.md`, `.gitignore`
- Modify: `.github/workflows/terraform.yml:28-34,37-43,212`

**Interfaces:**
- Consumes: `src/lambda.handler` and env names from Task 1; zone `amaslakov.com` (exists, owned outside Terraform).
- Produces: outputs `site_url`, `cloudfront_distribution_id` (CI invalidates any stack that outputs it), `function_name`.

- [ ] **Step 1: `versions.tf`** — copy `platform/infra/landing/versions.tf` and change only: backend `key = "atlas/terraform.tfstate"`, `Stack = "aws-atlas"`, and add the `random` provider:

```hcl
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
```

- [ ] **Step 2: `variables.tf`**

```hcl
variable "project" {
  description = "Project name; Project tag and resource name prefix."
  type        = string
  default     = "slime"
}

variable "region" {
  description = "Home region."
  type        = string
  default     = "eu-central-1"
}

variable "zone_name" {
  description = "Existing public Route 53 zone."
  type        = string
  default     = "amaslakov.com"
}

variable "site_domain" {
  description = "Public host of the Atlas customer site."
  type        = string
  default     = "atlas.amaslakov.com"
}

variable "log_retention_days" {
  description = "CloudWatch retention for the site function logs."
  type        = number
  default     = 14
}
```

- [ ] **Step 3: `build.sh`** (`chmod +x`; CI runs it from the repo root before plan/apply)

```bash
#!/usr/bin/env bash
# Builds the Atlas site bundle this stack zips: examples/customer-site with
# production node_modules. Output: platform/infra/atlas/.build/site/.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
out="$repo/platform/infra/atlas/.build/site"
rm -rf "$out" && mkdir -p "$out"
cp -R "$repo/examples/customer-site/src" "$repo/examples/customer-site/public" "$out/"
cp "$repo/examples/customer-site/package.json" "$repo/examples/customer-site/package-lock.json" "$out/"
npm ci --omit=dev --no-audit --no-fund --prefix "$out"
```

Create `platform/infra/atlas/.gitignore` as a copy of `platform/infra/landing/.gitignore` (`.terraform/`, `*.tfstate`, `*.tfstate.*`, `*.tfplan`, `tfplan`, `.build/`).

- [ ] **Step 4: `main.tf`**

```hcl
# Atlas customer site (examples/customer-site) on Lambda behind CloudFront.
#
#   https://<site_domain>/ -> CloudFront (adds x-atlas-origin) -> Function URL
#     -> slime-atlas: src/lambda.mjs loads /slime/atlas/* from SSM, then Hono
#
# Function URL auth is NONE for the same reason as the admin (OAC cannot sign
# browser POSTs); the handler refuses requests without the origin header.

locals {
  name        = "${var.project}-atlas"
  ssm_prefix  = "/${var.project}/atlas/"
  origin_host = trimsuffix(trimprefix(aws_lambda_function_url.site.function_url, "https://"), "/")
}

data "aws_caller_identity" "current" {}

data "archive_file" "site" {
  type             = "zip"
  source_dir       = "${path.module}/.build/site"
  output_path      = "${path.module}/.build/site.zip"
  output_file_mode = "0644"
}

resource "random_password" "origin" {
  length  = 40
  special = false
}

data "aws_iam_policy_document" "lambda_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "site" {
  name               = local.name
  assume_role_policy = data.aws_iam_policy_document.lambda_trust.json
}

resource "aws_cloudwatch_log_group" "site" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = var.log_retention_days
}

data "aws_iam_policy_document" "site" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.site.arn}:*"]
  }

  # SLIME_URL, SLIME_API_KEY, CRYSTAL_* (SecureString, AWS managed key aws/ssm).
  statement {
    sid       = "Settings"
    actions   = ["ssm:GetParametersByPath"]
    resources = [
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${trimsuffix(local.ssm_prefix, "/")}",
      "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter${local.ssm_prefix}*",
    ]
  }
}

resource "aws_iam_role_policy" "site" {
  name   = "site"
  role   = aws_iam_role.site.id
  policy = data.aws_iam_policy_document.site.json
}

resource "aws_lambda_function" "site" {
  function_name    = local.name
  description      = "Atlas demo customer site (examples/customer-site)"
  role             = aws_iam_role.site.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "src/lambda.handler"
  filename         = data.archive_file.site.output_path
  source_code_hash = data.archive_file.site.output_base64sha256
  memory_size      = 256
  timeout          = 30 # a Gas generation on the cloud panels took 5.6 s; CloudFront waits 30 s

  environment {
    variables = {
      ATLAS_SSM_PREFIX    = local.ssm_prefix
      ATLAS_ORIGIN_SECRET = random_password.origin.result
      MULTI_SOURCE_URL    = "" # panel 3 is self-hosted only; see src/app.mjs
    }
  }

  logging_config {
    log_format = "JSON"
    log_group  = aws_cloudwatch_log_group.site.name
  }

  depends_on = [aws_iam_role_policy.site]
}

resource "aws_lambda_function_url" "site" {
  function_name      = aws_lambda_function.site.function_name
  authorization_type = "NONE"
}
```

- [ ] **Step 5: `domain.tf`** — the landing's certificate and DNS blocks for one host, plus the admin's uncached behavior with the origin header:

```hcl
data "aws_route53_zone" "site" {
  name         = var.zone_name
  private_zone = false
}

resource "aws_acm_certificate" "site" {
  provider          = aws.us_east_1
  domain_name       = var.site_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "cert_validation" {
  for_each = {
    for dvo in aws_acm_certificate.site.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  }

  zone_id         = data.aws_route53_zone.site.zone_id
  name            = each.value.name
  type            = each.value.type
  ttl             = 300
  records         = [each.value.record]
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "site" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site.arn
  validation_record_fqdns = [for r in aws_route53_record.cert_validation : r.fqdn]
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

data "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "Managed-SecurityHeadersPolicy"
}

resource "aws_cloudfront_distribution" "site" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2and3"
  comment         = "${local.name}: ${var.site_domain}"
  aliases         = [var.site_domain]
  price_class     = "PriceClass_100"

  origin {
    origin_id   = "function-url"
    domain_name = local.origin_host

    custom_header {
      name  = "x-atlas-origin"
      value = random_password.origin.result
    }

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }
  }

  # Every answer is live (tiers and timings change per call): no caching.
  default_cache_behavior {
    target_origin_id           = "function-url"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
    compress                   = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.site.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

resource "aws_route53_record" "site" {
  for_each = toset(["A", "AAAA"])

  zone_id = data.aws_route53_zone.site.zone_id
  name    = var.site_domain
  type    = each.value

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
```

- [ ] **Step 6: `outputs.tf`**

```hcl
output "site_url" {
  description = "Public Atlas site."
  value       = "https://${var.site_domain}/"
}

output "cloudfront_distribution_id" {
  description = "CI invalidates it after each apply."
  value       = aws_cloudfront_distribution.site.id
}

output "function_name" {
  value = aws_lambda_function.site.function_name
}
```

- [ ] **Step 7: CI triggers** — in `.github/workflows/terraform.yml` add `- examples/customer-site/**` to `on.pull_request.paths` and `on.push.paths`, and `examples/customer-site` to `DEPLOY_PATHS=(…)` (line 212); update the "Trigger paths" header comment to name it.

- [ ] **Step 8: Validate locally**

```bash
bash platform/infra/atlas/build.sh
terraform fmt -check -recursive platform/infra
terraform -chdir=platform/infra/atlas init -backend=false && terraform -chdir=platform/infra/atlas validate
```
Expected: no fmt diff, `Success! The configuration is valid.`

- [ ] **Step 9: `platform/infra/atlas/README.md`** — resources table (function, Function URL, CloudFront, ACM, Route 53 records, log group), the SSM parameter list from Task 3, deploy (`terraform.yml` on merge; recovery `AWS_PROFILE=slime terraform apply`), kill switch (Task 4), rollback (`terraform destroy`).

- [ ] **Step 10: Commit**

```bash
git add platform/infra/atlas .github/workflows/terraform.yml
git commit -m "feat(infra): serve the Atlas customer site at atlas.amaslakov.com"
```

### Task 3: Settings in SSM (by hand, before the first apply)

The values are in 1Password vault `Slime Hackathon`: `Slime — Atlas demo endpoint` (endpoint URL `https://<runtime host>/ep/ep-290cbb5eb4` and `slm_` key) and `Slime — Atlas demo Crystal (plan revenue)` (Crystal key and `slc_` token). Read each field reference with `op item get <item> --vault 'Slime Hackathon' --format json` (field labels only, no `--reveal`), then:

```bash
export AWS_PROFILE=slime AWS_REGION=eu-central-1
put() { aws ssm put-parameter --name "/slime/atlas/$1" --type SecureString --overwrite --value "$(op read "$2")" >/dev/null; }
put SLIME_URL                  'op://Slime Hackathon/Slime — Atlas demo endpoint/<url field>'
put SLIME_API_KEY              'op://Slime Hackathon/Slime — Atlas demo endpoint/<key field>'
put CRYSTAL_PLAN_REVENUE_KEY   'op://Slime Hackathon/Slime — Atlas demo Crystal (plan revenue)/<key field>'
put CRYSTAL_PLAN_REVENUE_TOKEN 'op://Slime Hackathon/Slime — Atlas demo Crystal (plan revenue)/<token field>'
aws ssm get-parameters-by-path --path /slime/atlas/ --query 'Parameters[].Name'
```
Expected: four names, no values printed. Settings are read at cold start: after a change, `aws lambda update-function-configuration --function-name slime-atlas --description "settings $(date +%s)"` forces new instances.

### Task 4: Deploy and smoke

- [ ] **Step 1:** Push the branch, open the PR; `terraform.yml` plans `atlas` (all adds, no changes to other stacks).
- [ ] **Step 2:** Anton merges; CI applies. Fallback if CloudFront fails with `InvalidViewerCertificate` (known issue, `platform/infra/landing/README.md`): `cd platform/infra/atlas && bash build.sh && AWS_PROFILE=default terraform init && AWS_PROFILE=default terraform apply`.
- [ ] **Step 3: Smoke** (all must hold):

```bash
site=https://atlas.amaslakov.com
curl -s "$site/" | grep -o '<title>.*</title>'                      # <title>Atlas · Customer console</title>
curl -s "$site/api/panels" | jq -c '[.[] | {id, route}]'            # plan-revenue crystal, churn-risk query, customer-360 null
curl -s "$site/api/panels/plan-revenue" -H 'content-type: application/json' -d '{"input":{}}' | jq -c '{tier: .meta.tier, route, rows: (.data | length)}'   # crystal, crystal, 4
curl -s "$site/api/panels/churn-risk" -H 'content-type: application/json' -d '{"input":{"country":"FR"}}' | jq -c '{tier: .meta.tier, rows: (.data | length)}' # liquid, 6
curl -s -o /dev/null -w '%{http_code}\n' "$site/api/panels/customer-360" -H 'content-type: application/json' -d '{"input":{"plan":"Growth","currency":"USD"}}'  # 503
curl -s -o /dev/null -w '%{http_code}\n' "$(aws lambda get-function-url-config --function-name slime-atlas --query FunctionUrl --output text)"  # 403
```

Open the site on a phone: three cards, Run on "Revenue by plan" shows the Crystal badge.

- [ ] **Step 4: Kill switch (record, do not run):** `aws lambda put-function-concurrency --function-name slime-atlas --reserved-concurrent-executions 0` stops all traffic; `aws lambda delete-function-concurrency --function-name slime-atlas` restores it.

### Task 5: Docs

- [ ] `examples/customer-site/README.md`: a "Public site" section: URL, which panels are live, `src/lambda.mjs` in the file table, link to `platform/infra/atlas/README.md`.
- [ ] `platform/infra/README.md`: add the `atlas` stack to its stack list.
- [ ] `platform/infra/FINOPS.md`: row `Atlas site (Lambda + CloudFront, atlas.amaslakov.com) | ≈ $0 idle; pay-per-request | never`.
- [ ] `docs/README.md`: flip this plan to `Record` and add the URL to [atlas-demo.md](atlas-demo.md).
- [ ] Commit: `docs: Atlas public site URL, stack and cost`.

## Verification summary

| Check | Expected |
|---|---|
| `npm test` in `examples/customer-site` | all pass, including the off-switch test |
| `terraform validate` on `platform/infra/atlas` | valid |
| PR `terraform.yml` plan | `atlas` adds only; other stacks no changes |
| Smoke (Task 4 Step 3) | title, routes, Crystal 4 rows, Liquid FR 6 rows, panel 3 503, direct URL 403 |

## Review ledger (plan gate, 2026-11-22)

- **Answered — "a public page with an `slm_` key burns model tokens."** The browser sends only a panel id and one of the offered values (`inputProblem` in `app.mjs`); intent and output are fixed server-side, so every request maps to an existing Liquid or Crystal handler. A new generation needs a code change.
- **Answered — "OAC is safer than a public Function URL."** OAC breaks browser POSTs (admin.tf header comment). The origin header, plus a refuse-all when the secret is missing, keeps direct hits out the same way the admin does.
- **Answered — "secrets end up in state."** Only the random origin header is in state (same as admin). `slm_`/`slc_` are in SSM and read at runtime.
- **Answered — "CI will not redeploy on site changes."** Task 2 Step 7 adds `examples/customer-site/**` to the trigger paths and `DEPLOY_PATHS`.
- **Deferred — panel 3 on the public site.** Needs a hosted multi-source server with a model key and Notion tokens; out of the fast path. The card says it is shown live.
- **Deferred — rate limiting.** No WAF (≈ $5+/month). Kill switch in Task 4 Step 4.
- **Survived (risk) — `InvalidViewerCertificate` under `slime-deployer`.** Seen on the landing; fallback is a hand apply under `AWS_PROFILE=default` (Task 4 Step 2).
