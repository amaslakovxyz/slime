#!/usr/bin/env bash
# Walks one question through Gas -> Liquid -> Crystal on the real server.
#
#   npm run db:up          # demo database must be running
#   npm run demo           # uses SLIME_PROVIDER from .env (groq, claude or offline)
#
# Uses its own store table (slime_meta.handlers_demo) and a scratch Crystal
# folder, so it never touches a dev server's saved handlers or the repo.
set -euo pipefail
cd "$(dirname "$0")/.."

export PORT="${PORT:-3077}"
export SLIME_META_TABLE=handlers_demo
export SLIME_CRYSTAL_DIR="${SLIME_CRYSTAL_DIR:-$(mktemp -d)/crystal}"
export GAS_TO_LIQUID_HITS="${GAS_TO_LIQUID_HITS:-3}"
export CRYSTAL_MIN_RUNS="${CRYSTAL_MIN_RUNS:-6}"
LOG="$(mktemp)"
URL="http://127.0.0.1:${PORT}"

INTENT='top N accounts by total paid invoice amount in cents, highest first'
OUTPUT='[{"name":"string","totalPaidCents":"integer"}]'

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '   %s\n' "$*"; }

start_server() {
  node --import tsx src/index.ts >"$LOG" 2>&1 &
  PID=$!
  for _ in $(seq 1 60); do curl -sf "$URL/healthz" >/dev/null 2>&1 && return; sleep 0.25; done
  echo "server did not start:"; cat "$LOG"; exit 1
}
stop_server() { kill -INT "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; }
trap stop_server EXIT

# Sends the question with a given limit and prints what happened.
ask() {
  local limit="$1" show_sql="${2:-}"
  curl -s "$URL/v0/query" -H 'content-type: application/json' \
    -d "{\"intent\":\"$INTENT\",\"input\":{\"limit\":$limit},\"output\":$OUTPUT}" |
    python3 scripts/show.py query ${show_sql:+show-sql}
}

wait_for_review() {
  for _ in $(seq 1 120); do
    local status
    status=$(curl -s "$URL/v0/handlers" | python3 scripts/show.py review-status)
    if [ "$status" != "pending" ]; then
      curl -s "$URL/v0/handlers" | python3 scripts/show.py review
      return
    fi
    sleep 1
  done
  note "review still pending after 2 minutes"
}

bold "Setup"
note "provider: $(grep -E '^SLIME_PROVIDER=' .env 2>/dev/null | cut -d= -f2 || echo claude)   crystal folder: $SLIME_CRYSTAL_DIR"
docker compose exec -T postgres psql -q -U slime_writer -d slime -c "DROP TABLE IF EXISTS slime_meta.handlers_demo" >/dev/null 2>&1
start_server

bold "1. A question nobody asked before: the model writes the SQL (Gas)"
ask 5 show-sql

bold "2. Same question, another value: reuses the generated code"
ask 10

bold "3. Background review (off the request path)"
wait_for_review

bold "4. More successful runs: Gas becomes Liquid after $GAS_TO_LIQUID_HITS runs + approved review"
ask 3
ask 7

bold "5. Restart the server: Liquid was saved, so nothing is regenerated"
stop_server; start_server
note "$(curl -s "$URL/healthz" | python3 scripts/show.py store)"
ask 4
for n in 6 8 9; do ask "$n" >/dev/null; done
note "(3 more runs sent, to reach CRYSTAL_MIN_RUNS=$CRYSTAL_MIN_RUNS)"
stop_server

bold "6. Crystallize: the agent rewrites the Liquid handler into a module, checked for equivalence"
npm run -s crystallize -- ${OPTIMIZER:+--optimizer "$OPTIMIZER"} 2>&1 | sed 's/^/   /'
for f in "$SLIME_CRYSTAL_DIR"/*.mjs; do [ -e "$f" ] && { note "module $(basename "$f"):"; sed 's/^/      /' "$f"; }; done

bold "7. Restart: the server loads the Crystal folder and serves it without the sandbox worker"
start_server
note "$(curl -s "$URL/healthz" | python3 scripts/show.py crystal)"
ask 5
ask 2

bold "Done"
note "Server log: $LOG"
