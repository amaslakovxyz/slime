#!/usr/bin/env bash
# Builds the artifacts this stack zips (run from the repo root; CI calls it
# before terraform plan/apply). Output: slime-cloud/runtime/dist/lambda/.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
# The runtime compiles @slime-kit/core from sandbox/src: both need their deps.
npm ci --no-audit --no-fund --prefix "$repo/sandbox"
npm ci --no-audit --no-fund --prefix "$repo/slime-cloud/runtime"
npm run build --prefix "$repo/slime-cloud/runtime"
