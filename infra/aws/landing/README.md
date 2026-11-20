# Landing on AWS Lambda

Serves [`landing/`](../../../landing/) from a Lambda Function URL in
`eu-central-1`. GitHub Pages ([`pages.yml`](../../../.github/workflows/pages.yml))
keeps working in parallel.

| Resource | Notes |
|---|---|
| Layer `slime-landing-site` | `landing/` minus `README.md` and `tools/`; unpacked at `/opt` |
| Function `slime-landing` | Node 22, arm64, 256 MB; [`function/index.mjs`](function/index.mjs) serves only files present in the layer (allowlist = path-traversal guard), gzips text, sets cache and security headers |
| Function URL | Public (`NONE`); the paired `InvokeFunction` permission is limited to URL invocations |
| Log group `/aws/lambda/slime-landing` | 14-day retention |

State: `s3://slime-tfstate-025772230981/landing/terraform.tfstate` (bucket from
`infra/aws/bootstrap`, S3 lockfile).

## Deploy

```sh
cd infra/aws/landing
AWS_PROFILE=slime terraform init
AWS_PROFILE=slime terraform apply      # any change in landing/ publishes a new layer version
terraform output -raw url
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
