# Adversarial infrastructure review — 2026-11-20

Scope: everything on `main` at `3087937` — `infra/aws/{bootstrap,landing,platform}`,
`.github/workflows/{terraform,terraform-quality,ci}.yml`, `.tflint.hcl`,
`.trivyignore.yaml` — plus the live account `025772230981`. Open PR #12
(Terraform matrix CD + runtime) was read for overlap, not reviewed.

Two lenses:

- **DevOps / IaC / reliability** (`devops` skill: state and ownership
  boundaries, least privilege, pinning, rollout, recovery).
- **Architecture** (`feature-dev:code-architect` posture: minimise moving
  parts, replace custom code with vendor-managed features, keep one decisive
  shape).

Each objection was raised in its strongest form and either fixed, defended,
or parked. The ledger is the deliverable.

## Survived — real risks, need an owner decision

| # | Objection | Evidence | Proposed fix |
|---|---|---|---|
| S1 | **Two Terraform states own the `amaslakov.com` apex.** The next ex-infra apply reverts the apex to `142.93.162.168` and takes the site down; `allow_overwrite = true` here hides the conflict instead of resolving it. | ex-infra `origin/main` `infra/terraform/aws/route53.tf:34` `aws_route53_record.com_a`; ex-infra PR #87 also targets the apex. | In ex-infra: `removed { from = aws_route53_record.com_a  lifecycle { destroy = false } }` (Terraform >= 1.7), or move the landing aliases into ex-infra. One owner per record. |
| S2 | **One account-wide Lambda concurrency pool of 10** is shared by `slime-landing`, `seccura-dev` and the runtime in #12. A burst on any public function starves landing cache misses (visitors get the origin's 429 instead of the page). | `aws service-quotas get-service-quota --quota-code L-B99A9384` → 10; no increase requested. | Free Service Quotas request to 1000, then reserve concurrency for the landing. Optionally codify with `aws_servicequotas_service_quota`. |
| S3 | **The static site runs on custom code.** AWS's reference pattern for a static site is S3 + CloudFront OAC. That removes the function, layer, role, log group, Function URL, both permissions and ~120 lines of JS/tests, and it cannot hit S2. | `landing/` is 160 KB of static files; the function only maps paths to bytes. | Swap the origin to a private `slime-landing-*` bucket with OAC. This conflicts with the original "on Lambda" request, so it needs a decision. |
| S4 | **The CI trust gap is still open.** Without branch protection, any collaborator push to `main` gets the apply role (Admin minus fences). The plan role's `ReadOnlyAccess` includes data-plane reads such as `dynamodb:Scan`/`GetItem` and `sqs:ReceiveMessage` on non-slime resources, and a PR can rewrite the workflow to dump them. | `README.md` "Known trust gap"; GitHub rulesets return 403 on Free; IAM simulator on `slime-gha-plan`: `dynamodb:Scan`, `dynamodb:GetItem`, `sqs:ReceiveMessage` on a foreign resource → allowed. | GitHub Pro (protected `main`) or a separate AWS account. Short of that: deny data-plane reads outside `slime-*` on the plan role. |
| S5 | **CloudFront spend has no fast brake.** The project budget filters by region until the `Project` tag is active, so CloudFront is not counted. Budgets lag 8-24 h, and the freeze stops deploys, not requests. | `bootstrap/main.tf` project budget; `FINOPS.md` follow-up. | Activate the tag (`project_cost_tag_active=true`) once AWS lists it. For a hard cap, evaluate CloudFront flat-rate pricing plans or a WAF rate rule (~$5+/month). Check origin compatibility first. |

## Answered — fixed in this PR (already applied, drift 0)

| # | Objection | Fix |
|---|---|---|
| A1 | `bootstrap` declared `required_version >= 1.9` and `landing` declared `>= 1.10`, but `use_lockfile` is GA only from 1.11 (experimental in 1.10, unknown to 1.9). The constraint promised a version that cannot init the backend. | `>= 1.11` in `bootstrap` and `landing`. `platform` is left to #12, which rewrites that file. |
| A2 | The apply role could overwrite or delete `bootstrap/terraform.tfstate`. That is the state of the stack defining its own guard rails, and the next human apply would act on a forged picture. | New `DenyBootstrapStateWrites` statement on `slime-gha-apply`. IAM simulator: Put/Delete on `bootstrap/*` → explicitDeny; `platform/*` state and lock → allowed. |
| A3 | The function re-implemented features CloudFront already provides: gzip (and never brotli) plus a hand-maintained header set. | Removed. CloudFront compresses at the edge (now serves `br`, 25 KB vs 26 KB gzip, 97 KB raw). `Managed-SecurityHeadersPolicy` adds HSTS, nosniff, Referrer-Policy, X-Frame-Options and XSS protection. `fs.readdirSync({recursive})` replaces the hand-written walker. `index.mjs` went from 96 to 74 lines. |
| A4 | `ci.yml` pinned actions by mutable tags and had no `permissions:` block, so it inherited the repo default token scope. | Full-SHA pins (same major versions) and `permissions: contents: read`. |
| A5 | `landing` repeated its tag map in both providers. | `local.tags`, same pattern as `bootstrap`. |
| A6 | The `landing/main.tf` header still said "URL public, auth NONE". | Corrected to `AWS_IAM` + OAC. |

## Answered — defended, no change

| # | Objection | Defence |
|---|---|---|
| D1 | "Use `terraform-aws-modules` (lambda, cloudfront, acm, iam-github-oidc-role) instead of hand-written resources." | The whole codebase is about 600 lines. Adopting modules means `moved` blocks on human-applied bootstrap and on live landing. The lambda module brings its own Python packaging. The OIDC role module would accept the immutable-ID subject, but it saves only ~40 lines of trust policy in the one stack CI must never touch. The vendor reuse that pays off is already here: AWS managed policies (CachingOptimized, SecurityHeaders, ReadOnly/Admin), OAC, native S3 locking, `aws-actions/configure-aws-credentials`, `hashicorp/setup-terraform`. |
| D2 | "Use `setup-tflint` / `trivy-action` instead of curl." | The release binaries are verified against pinned SHA-256 sums. That gives the same immutability guarantee without third-party JavaScript in the job, at the cost of about 6 lines. |
| D3 | "Landing is applied by hand, so drift and concurrent applies are likely; it is not even validated in CI." | Covered by #12: matrix CD over `infra/aws/*` except bootstrap, plus a validate glob. This PR does not touch `terraform.yml`, to avoid adding conflicts to #12, which is already `CONFLICTING`. |
| D4 | "Three backend blocks and provider configs are duplication; merge the stacks or add Terragrunt." | One state per ownership boundary is the point: bootstrap is human-only and owns the CI roles, while the others are CI-applied. Five duplicated lines of backend config are cheaper than a wrapper tool. |
| D5 | "No KMS CMK on state, no WAF." | Accepted Trivy findings with a written cost rationale in `.trivyignore.yaml`. |
| D6 | "The freeze denies `ecs:UpdateService`, `rds:ModifyDB*` and `dynamodb:UpdateTable`, contradicting 'updates still work'." | Intentional: these updates add capacity. The wording in `FINOPS.md` now says so. |

## Deferred — parked, not resolved

| # | Item | Why parked |
|---|---|---|
| F1 | Dependabot for action SHAs and provider lock files | Dependabot-triggered runs get no secrets or OIDC, so the plan job would fail on every bump that touches `infra/aws/` or `terraform.yml`. The workflow needs a Dependabot-aware skip first. |
| F2 | Alarms: CloudFront 5xx rate, Lambda throttles (10 alarms are free) | CloudFront metrics live in us-east-1, where `region-guard` denies `cloudwatch:*`. This needs a guard exemption and an SNS email subscription. |
| F3 | `pre-commit-terraform` hooks | The CI pre-commit runner has no Terraform, and the Terraform workflows already run fmt, validate, tflint and trivy. |
| F4 | `bootstrap`/`platform` on AWS provider `~> 5`, `landing` on `~> 6` | There is no functional need. Upgrade bootstrap the next time it changes (#12 moves platform to 6). |
| F5 | `CreateDistribution` fails under `slime-deployer` (see landing README) | Root cause not isolated. Only matters if the distribution is recreated. |
