# @slime-cloud/runtime

Slime Cloud's hosted runtime: the open-source core (`sandbox/`, future
`@slime-cloud/core`) running on AWS Lambda, with reviewed Liquid handlers in
DynamoDB. Deployed by [`infra/aws/platform`](../../infra/aws/README.md#platform-slime-runtime)
as the `slime-runtime` function.

**Boundary:** this package imports the core; the core never imports this
package or anything AWS-specific. `sandbox/` stays exactly what gets published.

## How the core is consumed

Until `sandbox/` is published as `@slime-cloud/core`, the core is compiled from
source through one mapping in [tsconfig.json](tsconfig.json):

```json
"paths": { "@slime-cloud/core/*": ["../../sandbox/src/*"] }
```

TypeScript, tsx (tests) and esbuild (bundle) all read it, so code here already
imports `@slime-cloud/core/engine.js` etc. When the package exists: delete the
mapping, add `"@slime-cloud/core"` to `dependencies`, and nothing else changes.
The core's own dependencies resolve from `sandbox/node_modules`, so run
`npm ci` there too.

| File | Role |
|---|---|
| [src/lambda.ts](src/lambda.ts) | Lambda entry: SSM settings at cold start, `x-api-key` auth, lazy engine boot (503 `NOT_READY` and retry), store flush before each response |
| [src/app.ts](src/app.ts) | HTTP routes (mirror `sandbox/src/index.ts` until `@slime-cloud/server` exists) |
| [src/store-dynamodb.ts](src/store-dynamodb.ts) | Core `HandlerStore` port on DynamoDB, one partition per tenant |
| [scripts/build.mjs](scripts/build.mjs) | Deterministic bundle into `dist/lambda/` (same source, same zip hash) |

## Commands

```sh
(cd ../../sandbox && npm ci) && npm ci
npm run typecheck
npm test              # no AWS, no database
npm run build         # dist/lambda/, zipped by Terraform
```

Behavior differences from the local `npm start` server:

* Every route needs `x-api-key: $SLIME_API_KEY`; with no key configured every
  request gets 401.
* Queued store writes are flushed before each response because Lambda freezes
  the process afterwards. A background review not finished by then continues
  on that instance's next invocation, or is lost if the instance is retired;
  the handler then stays Gas.
