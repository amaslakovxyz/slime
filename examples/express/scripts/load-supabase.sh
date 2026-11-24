#!/usr/bin/env bash
# Loads the Atlas demo data (db/init.sql: plans, accounts, subscriptions, invoices,
# usage_events) into the public schema of the Supabase test project, as the RDS
# slime-test-db held it in database `slime`, and grants the existing slime_reader
# role what init.sql grants it there. Rerunning is the reload: these five tables are
# dropped and generated again (fixed seed); other public tables are left alone.
#
# Needs: aws CLI with access to the slime account (AWS_PROFILE, default `slime`),
# docker (psql runs in the postgres:16 image), node. Role slime_reader must exist
# (the admin's Supabase connector shows its SQL); its password and
# /slime/test-db/SUPABASE_READER_URL are not changed.
# Never prints a URL or password: they travel in environment variables only.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_PROFILE="${AWS_PROFILE:-slime}" AWS_REGION=eu-central-1

param() { aws ssm get-parameter --with-decryption --name "$1" --query Parameter.Value --output text; }
# libpq (psql) rejects uselibpqcompat, a node-postgres-only option.
psql_url() { U="$1" node -e 'const u = new URL(process.env.U); u.searchParams.delete("uselibpqcompat"); process.stdout.write(u.href)'; }
ADMIN_URL=$(psql_url "$(param /slime/test-db/SUPABASE_MASTER_URL)")
READER_URL=$(psql_url "$(param /slime/test-db/SUPABASE_READER_URL)")

run_psql() { # $1 = connection URL, rest = psql args; stdin passes through
  PGURL="$1" docker run --rm -i -e PGURL postgres:16 \
    sh -c 'exec psql "$PGURL" -X -q -v ON_ERROR_STOP=1 "$@"' psql "${@:2}"
}

# init.sql up to its role section: Supabase already has slime_reader, and the
# section's database-level grants name database `slime` (Supabase has only `postgres`).
MARKER='-- The read-only user Slime connects as'
grep -q "^$MARKER" db/init.sql || { echo "db/init.sql: role section marker not found" >&2; exit 1; }

echo "reloading the Atlas tables in Supabase public (other tables are kept)"
{
  cat <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'slime_reader') THEN
    RAISE EXCEPTION 'role slime_reader is missing: create it with the SQL the admin shows for the Supabase connector';
  END IF;
END $$;
DROP TABLE IF EXISTS usage_events, invoices, subscriptions, accounts, plans;
SQL
  sed "/^$MARKER/,\$d" db/init.sql
  cat <<'SQL'
-- Supabase's default privileges hand new public tables to anon, authenticated and
-- slime_reader (whole table, password_hash included): start from none, as on RDS.
REVOKE ALL ON plans, accounts, subscriptions, invoices, usage_events FROM anon, authenticated, slime_reader;
GRANT SELECT ON plans, subscriptions, invoices, usage_events TO slime_reader;
GRANT SELECT (id, name, email, country, plan_id, created_at) ON accounts TO slime_reader;
ALTER ROLE slime_reader SET default_transaction_read_only = on;
ALTER ROLE slime_reader SET statement_timeout = '2s';
ALTER ROLE slime_reader SET idle_in_transaction_session_timeout = '5s';
SQL
} | run_psql "$ADMIN_URL" -1 -f - >/dev/null

# Proves the reader can log in and read; the counts are not secret.
run_psql "$READER_URL" -c "SELECT p.name AS plan, count(*) AS accounts FROM accounts a JOIN plans p ON p.id = a.plan_id GROUP BY p.name ORDER BY p.name" \
  -c "SELECT (SELECT count(*) FROM subscriptions) AS subscriptions, (SELECT count(*) FROM invoices) AS invoices, (SELECT count(*) FROM usage_events) AS usage_events"
echo "Atlas data loaded; slime_reader reads it via /slime/test-db/SUPABASE_READER_URL"
