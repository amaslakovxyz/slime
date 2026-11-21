#!/usr/bin/env bash
# Builds the artifacts this stack zips (run from the repo root; CI calls it
# before terraform plan/apply). Output: platform/runtime/dist/{lambda,layer}/
# and platform/provisioner/dist/lambda/.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
# The runtime links @slime-cloud/core (core/) and bundles its built dist/.
npm ci --no-audit --no-fund --prefix "$repo"
npm run build --prefix "$repo" -w @slime-cloud/core
npm ci --no-audit --no-fund --prefix "$repo/platform/runtime"
npm run build --prefix "$repo/platform/runtime"
npm ci --no-audit --no-fund --prefix "$repo/platform/provisioner"
npm run build --prefix "$repo/platform/provisioner"
