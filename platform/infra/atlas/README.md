# Atlas customer site on AWS Lambda

Serves [`examples/customer-site`](../../../examples/customer-site/README.md), the demo
customer "Atlas", at a public Lambda Function URL in `eu-central-1`:
<https://g2a4gnm6afgghto6jah6qdxrpu0ycxbq.lambda-url.eu-central-1.on.aws/>
(`terraform output -raw site_url`). Deployed 2026-11-22.

| Resource | Notes |
|---|---|
| Function `slime-atlas` | Node 22, arm64, 256 MB, 30 s; handler `src/lambda.handler` ([`src/lambda.mjs`](../../../examples/customer-site/src/lambda.mjs)) runs the site's Hono app through `hono/aws-lambda` |
| Function URL | Auth `NONE`, plus the two resource-policy statements a public URL needs (as `slime-runtime`). No CloudFront: answers are live, so a cache adds nothing, and OAC cannot sign the browser's `POST /api/panels/:id` |
| Role `slime-atlas` | Logs, and `ssm:GetParametersByPath` on `/slime/atlas/` only |
| Log group `/aws/lambda/slime-atlas` | 14-day retention |
| Env | `ATLAS_SSM_PREFIX=/slime/atlas/`, `MULTI_SOURCE_URL=off` (Customer 360 needs a self-hosted Slime, so its card says "not configured") |

State: `s3://slime-tfstate-025772230981/atlas/terraform.tfstate`.

## Settings (SSM, not in Terraform)

SecureStrings under `/slime/atlas/`, read at cold start, so keys never sit in state or
the Lambda console:

| Name | Value |
|---|---|
| `SLIME_URL` | `<runtime URL>/ep/ep-290cbb5eb4` (the `atlas-demo` endpoint) |
| `SLIME_API_KEY` | that endpoint's `slm_` key |
| `CRYSTAL_PLAN_REVENUE_KEY`, `CRYSTAL_PLAN_REVENUE_TOKEN` | the Revenue-by-plan Crystal's key and `slc_` token |

They were copied from the endpoint's own settings without printing them. Re-copy after
the key is rotated in the admin or the panel is crystallized again:

```sh
export AWS_PROFILE=slime AWS_REGION=eu-central-1
ep=/slime/endpoints/ep-290cbb5eb4
get() { aws ssm get-parameter --with-decryption --name "$1" --query Parameter.Value --output text; }
put() { aws ssm put-parameter --name "/slime/atlas/$1" --type SecureString --overwrite --value "$2" >/dev/null; }
runtime=$(aws lambda get-function-configuration --function-name slime-admin --query Environment.Variables.SLIME_RUNTIME_URL --output text)
put SLIME_URL "${runtime%/}/ep/ep-290cbb5eb4"
put SLIME_API_KEY "$(get $ep/SLIME_API_KEY)"
tokens=$(get $ep/CRYSTAL_TOKENS)   # one Crystal on this endpoint today
put CRYSTAL_PLAN_REVENUE_KEY "$(jq -r 'keys[0]' <<<"$tokens")"
put CRYSTAL_PLAN_REVENUE_TOKEN "$(jq -r '.[keys[0]]' <<<"$tokens")"
# running instances keep old values until a cold start; force one:
aws lambda update-function-configuration --function-name slime-atlas --description "Atlas demo customer site (settings $(date +%s))" >/dev/null
```

The next Terraform apply resets the description; that is harmless.

## Deploy

[`terraform.yml`](../../../.github/workflows/terraform.yml) plans this stack on pull
requests and applies it on merge to `main`; `examples/customer-site/**` is one of its
trigger paths. By hand (recovery):

```sh
bash platform/infra/atlas/build.sh            # bundles the site with production node_modules into .build/site
cd platform/infra/atlas
AWS_PROFILE=slime terraform init
AWS_PROFILE=slime terraform apply
```

## Abuse and kill switch

The page can only send a panel id and one of the panel's offered values; intent and
output are fixed on the server. Every request therefore hits an existing Liquid handler
or the Crystal and spends no model tokens. The worst case is Lambda and RDS reads.

Stop all traffic: `aws lambda put-function-concurrency --function-name slime-atlas --reserved-concurrent-executions 0`.
Restore: `aws lambda delete-function-concurrency --function-name slime-atlas`.
Remove: `terraform destroy`, then `aws ssm delete-parameters --names /slime/atlas/SLIME_URL /slime/atlas/SLIME_API_KEY /slime/atlas/CRYSTAL_PLAN_REVENUE_KEY /slime/atlas/CRYSTAL_PLAN_REVENUE_TOKEN`.

## Custom domain (not done)

`atlas.amaslakov.com` would need CloudFront in front of the Function URL with the
admin's pattern (`platform/infra/platform/admin.tf`: URL auth `NONE`, a random origin
header only CloudFront sends, checked by the app, caching disabled) plus an ACM
certificate in `us-east-1` and Route 53 aliases, as in
[`landing/domain.tf`](../landing/domain.tf).
