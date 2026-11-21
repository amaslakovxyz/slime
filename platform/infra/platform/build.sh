#!/usr/bin/env bash
# Builds the artifacts this stack zips (run from anywhere; CI calls it before
# terraform plan/apply). Output: platform/runtime/dist/lambda/,
# platform/admin/dist/lambda/ and platform/admin/dist/source-hash.txt.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
# The runtime links @slime-cloud/core (core/) and bundles its built dist/.
npm ci --no-audit --no-fund --prefix "$repo"
npm run build --prefix "$repo" -w @slime-cloud/core
npm ci --no-audit --no-fund --prefix "$repo/platform/runtime"
npm run build --prefix "$repo/platform/runtime"
# The admin: Next standalone build plus the Lambda start scripts.
npm ci --no-audit --no-fund --prefix "$repo/platform/admin"
(cd "$repo/platform/admin" && NEXT_TELEMETRY_DISABLED=1 npm run build:lambda)
