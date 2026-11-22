#!/usr/bin/env bash
# Builds the bundle this stack zips (run from anywhere; CI calls it before
# terraform plan/apply): examples/customer-site with production node_modules.
# Output: platform/infra/atlas/.build/site/.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../.." && pwd)"
site="$repo/examples/customer-site"
out="$repo/platform/infra/atlas/.build/site"
rm -rf "$out"
mkdir -p "$out"
cp -R "$site/src" "$site/public" "$site/package.json" "$site/package-lock.json" "$out/"
npm ci --omit=dev --no-audit --no-fund --prefix "$out"
