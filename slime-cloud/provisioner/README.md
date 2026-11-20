# @slime-cloud/provisioner

Lambda `slime-provisioner`. It reads the `slime-control` DynamoDB stream; the event source mapping only passes endpoint items whose status is `pending` or `deleting` (`infra/aws/platform/provisioner.tf`).

- **pending** (`src/provision.ts`): claims the item (`provisioning`), then creates the log group, the IAM role `slime-ep-<hex>` (behind the endpoint permissions boundary, `dynamodb:LeadingKeys` pinned to the endpoint), and the Lambda `slime-ep-<hex>`. The Lambda is the shim (`shim/index.mjs`) on the Gas layer. It then adds a public Function URL and calls `GET <url>healthz` with the endpoint's key. The item ends as `ready` (with `url`) or `failed` (with `error`).
- **deleting** (`src/teardown.ts`): removes the Function URL, function, role, log group, the `/slime/endpoints/<id>/` parameters and the endpoint's Liquid handlers, then deletes the control item. Usage items stay as billing history. If a step fails, the item becomes `failed`, so the user can delete it again.

Every step is idempotent ("already exists" and "not found" count as done), so redelivered stream records are safe.

Env (set by Terraform): `SLIME_CONTROL_TABLE`, `SLIME_HANDLERS_TABLE`, `SLIME_GAS_LAYER_ARN`, `SLIME_ENDPOINT_BOUNDARY_ARN`, `SLIME_ENDPOINT_SHIM_ZIP_B64`, `SLIME_SHARED_SSM_PREFIX`, `SLIME_LOG_RETENTION_DAYS`. The region and account for policy ARNs are taken from the layer ARN.

```sh
npm ci && npm run typecheck && npm test && npm run build   # -> dist/lambda/index.mjs
```
