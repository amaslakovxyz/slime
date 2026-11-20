#!/usr/bin/env bash
# Builds the artifacts this stack zips (run from the repo root; CI calls it
# before terraform plan/apply). Output: sandbox/dist/lambda/.
set -euo pipefail
cd "$(dirname "$0")/../../../sandbox"
npm ci --no-audit --no-fund
npm run build:lambda
