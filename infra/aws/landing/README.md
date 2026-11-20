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

## Custom domain (next step)

Function URLs do not accept custom domains. Put CloudFront in front (ACM
certificate in `us-east-1`, origin = the Function URL host, Route 53 alias).
CloudFront caching also shields the function from traffic spikes: the account
has a concurrency limit of 10 shared by every Lambda in it.
