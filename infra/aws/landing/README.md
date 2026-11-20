# Landing on AWS Lambda

Serves [`landing/`](../../../landing/) at https://amaslakov.com/ through
CloudFront in front of a Lambda Function URL in `eu-central-1`.

| Resource | Notes |
|---|---|
| Layer `slime-landing-site` | `landing/` minus `README.md` and `tools/`; unpacked at `/opt` |
| Function `slime-landing` | Node 22, arm64, 256 MB; [`function/index.mjs`](function/index.mjs) serves only files present in the layer (allowlist = path-traversal guard), gzips text, sets cache and security headers |
| Function URL | `AWS_IAM` auth; only the CloudFront distribution may call it (Origin Access Control signs requests). Direct hits get 403 and never run the function, so nobody can bypass the cache and exhaust the account's shared Lambda concurrency (10) |
| Log group `/aws/lambda/slime-landing` | 14-day retention |

State: `s3://slime-tfstate-025772230981/landing/terraform.tfstate` (bucket from
`infra/aws/bootstrap`, S3 lockfile).

## Deploy

[`terraform.yml`](../../../.github/workflows/terraform.yml) plans this stack on
pull requests and applies it on merge to `main` (then invalidates CloudFront).
Apply by hand only for recovery:

```sh
cd infra/aws/landing
AWS_PROFILE=slime terraform init
AWS_PROFILE=slime terraform apply      # any change in landing/ publishes a new layer version
terraform output -raw site_url
```

## Test

```sh
node --test infra/aws/landing/function/index.test.mjs
```

## Custom domain

[`domain.tf`](domain.tf) serves `https://amaslakov.com` and `www.` through
CloudFront (Function URLs do not accept custom domains). CloudFront caching
also shields the function: the account Lambda concurrency limit is 10.

| Resource | Notes |
|---|---|
| ACM certificate (`us-east-1`) | apex + `www`, DNS-validated in the registrar-created zone |
| CloudFront distribution | `PriceClass_100`, HTTP→HTTPS redirect, `Managed-CachingOptimized`, origin = Function URL host |
| Route 53 `A`/`AAAA` aliases | apex and `www` → CloudFront |

The hosted zone is not managed here and keeps the iCloud mail records (MX,
SPF, DKIM, DMARC). The apex `A` record previously pointed at `142.93.162.168`
(unreachable); `allow_overwrite` replaced it. Rollback: `terraform destroy`
removes the aliases; recreate that `A` record by hand if it is needed again.

After a `landing/` change, HTML refreshes within 5 min and assets within a
day; to force it:
`aws cloudfront create-invalidation --distribution-id $(terraform output -raw cloudfront_distribution_id) --paths '/*'`.

**Known issue:** `CreateDistribution` repeatedly failed under `slime-deployer`
with `InvalidViewerCertificate` although the certificate was `ISSUED`; the
same apply under the admin `default` profile succeeded a minute later. Cause
not yet isolated (role vs. ACM→CloudFront propagation). If a distribution
must be recreated, retry under `AWS_PROFILE=default`.
