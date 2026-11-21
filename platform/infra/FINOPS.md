# FinOps: costs, free tier, guard rails

Account `025772230981`. Snapshot taken 2026-11-20 with Cost Explorer and the
Free Tier API.

## Where the money goes

| Item | Cost | Free tier? |
|---|---|---|
| Domain registration (Route 53 Registrar) | ~$16-17 per domain per year, billed in the renewal month | never |
| Route 53 hosted zones (4) | ~$1.50-2/month | never |
| Tax | ~20% on top | never |
| S3 (state, other buckets) | cents | partly |
| **slime** (Lambda, CloudFront, logs, S3 state) | **$0.001 this month** | Always Free |

Baseline is ~$2/month; renewal months reach ~$21-23. WAF cost $7-8/month in
May-June 2026 and is gone now.

The cloud MVP (2026-11-21) adds only resources that are free when idle: the
`slime-admin` Lambda, its CloudFront distribution, an ACM certificate, the
`slime-crystals-<account>` bucket and two Route 53 records in the existing
zone. No WAF on the admin distribution, for the same reason as the landing
(see `.trivyignore.yaml`).

**Model spend is outside the AWS budget.** Every endpoint spends the shared
`/slime/shared/` model keys, and the budgets and the freeze below see none of
it. Set a spend limit on the Anthropic workspace (and Groq, if used) by hand
before inviting anyone; sign-up is invite-only (`ADMIN_ALLOWED_EMAILS`).

Always Free usage (all far below limits): Lambda 1.6k / 1M requests and
183 / 400k GB-s, CloudFront 3k / 10M requests and 0.02 / 1024 GB out,
CloudWatch 0.05 / 5 GB. The account is on the legacy free tier (no free-plan
credits); 12-month offers no longer apply, only Always Free.

### What would leave the free tier first

- **Lambda concurrency, not cost:** the account limit is 1000 for every
  function together (checked 2026-11-21; it was 10 earlier in 2026). Nothing is
  reserved: `slime-runtime` serves every Slime Cloud endpoint, so a burst on one
  endpoint shares the pool with the admin and the landing.
- **DynamoDB PITR** (planned `slime-handlers` table): not free, billed per GB of
  table size; trivial at hackathon size.
- **WAF, NAT Gateway, KMS CMKs, provisioned concurrency, RDS**: no free tier;
  the budget freeze blocks creating most of these (see below).
- **CloudWatch log groups without retention** grow forever. Out of slime's
  scope, but `/ecs/blog` (83 MB), `/aws/lambda/seccura-dev` and an Amplify
  group currently have none.
- **Cost Explorer API**: $0.01 per request (scripts that poll it cost money).

## Guard rails (platform/infra/bootstrap)

| Control | Setting | Effect |
|---|---|---|
| Budget `slime-account-monthly` | $50, alerts 50/80% actual, 100% forecast | Whole account |
| Budget `slime-monthly` | $15, alerts $10.50 + $15 actual, $15 forecast | Region `eu-central-1` until the `Project` tag is active, then tag `Project=slime` |
| Budget action `freeze` | 100% actual of `slime-monthly`, automatic | Attaches `slime-budget-freeze` to `slime-deployer` and `slime-gha-apply`: no new paid resources or capacity increases (ECS/RDS/DynamoDB updates are blocked too); reads, code updates and deletes still work |
| Cost Anomaly Detection | SERVICE monitor, daily email at >= $5 impact | Whole account, free |

Two budgets with one action stay inside AWS Budgets' free allowance.

Undo a freeze after review (admin profile):

```sh
aws budgets describe-budget-actions-for-budget --account-id 025772230981 --budget-name slime-monthly
aws budgets execute-budget-action --account-id 025772230981 --budget-name slime-monthly \
  --action-id <ActionId> --execution-type REVERSE_BUDGET_ACTION
```

### Follow-up: switch the project budget to the tag

The `Project` tag was first used on 2026-11-20; AWS only lets it be activated
after it appears in billing data (about 24 hours).

```sh
aws ce list-cost-allocation-tags --tag-keys Project   # wait until it is listed
cd platform/infra/bootstrap && terraform apply -var project_cost_tag_active=true
```

Then set `project_cost_tag_active = true` as the default in `variables.tf`.

## Linters and cost tools

| Tool | Where | What it checks |
|---|---|---|
| `tflint` + AWS ruleset ([`.tflint.hcl`](../../.tflint.hcl)) | CI `Terraform quality`, local | Invalid types/arguments, deprecated syntax, unused declarations |
| `trivy config` ([`.trivyignore.yaml`](../../.trivyignore.yaml)) | CI `Terraform quality`, local | HIGH/CRITICAL misconfigurations; accepted findings carry a cost rationale |
| Infracost | local only for now | Monthly cost estimate per resource and per PR diff; needs a free Infracost login |

Local runs from the repo root:

```sh
tflint --init --config "$PWD/.tflint.hcl"
for d in platform/infra/*/; do (cd "$d" && tflint --config "$OLDPWD/.tflint.hcl"); done
trivy config --severity HIGH,CRITICAL --ignorefile .trivyignore.yaml .
infracost auth login && infracost scan platform/infra   # once logged in
```

Infracost prices mostly usage-based services (Lambda, CloudFront, DynamoDB
on-demand) at $0 without a usage file, so it matters most when fixed-price
resources (NAT, RDS, provisioned capacity) appear.
