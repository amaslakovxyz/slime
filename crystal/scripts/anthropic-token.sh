#!/usr/bin/env bash
# Prints a short-lived Anthropic access token (sk-ant-oat01-…) for this GitHub Actions job,
# through Workload Identity Federation: a fresh GitHub OIDC token for the audience
# https://api.anthropic.com, exchanged at POST /v1/oauth/token. No API key is stored.
#
# Needs `permissions: id-token: write` (GitHub then sets ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN)
# and ANTHROPIC_FEDERATION_RULE_ID, ANTHROPIC_ORGANIZATION_ID, ANTHROPIC_SERVICE_ACCOUNT_ID,
# ANTHROPIC_WORKSPACE_ID. Every call mints a new OIDC token: Anthropic accepts each one once.
# Used as the `claude` CLI's apiKeyHelper (crystal/scripts/agent-loop.mjs).
set -euo pipefail

jwt=$(curl -sS --fail -H "Authorization: Bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=https://api.anthropic.com" | jq -er .value)

response=$(jq -n --arg assertion "$jwt" '{
  grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
  assertion: $assertion,
  federation_rule_id: env.ANTHROPIC_FEDERATION_RULE_ID,
  organization_id: env.ANTHROPIC_ORGANIZATION_ID,
  service_account_id: env.ANTHROPIC_SERVICE_ACCOUNT_ID,
  workspace_id: env.ANTHROPIC_WORKSPACE_ID
}' | curl -sS https://api.anthropic.com/v1/oauth/token -H 'content-type: application/json' --data @-)

if ! token=$(jq -er .access_token <<<"$response"); then
  # The 401 is opaque by design; these claims are what the federation rule matched against.
  claims=$(jq -rR 'split(".")[1] | gsub("-";"+") | gsub("_";"/") | . + "=" * ((4 - length % 4) % 4) | @base64d | fromjson | {sub, aud, repository, ref, event_name}' <<<"$jwt" | jq -c .)
  echo "Anthropic token exchange failed: $(jq -c '.error // .' <<<"$response"); token claims: $claims" >&2
  exit 1
fi
