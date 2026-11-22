#!/usr/bin/env bash
# (Re)creates database `shop` on the cloud test RDS (slime-test-db) from db/shop.sql,
# gives role shop_reader a fresh random password and stores its URL in SSM
# /slime/test-db/SHOP_READER_URL. Recreating is the reload: the data is generated.
# Any Slime endpoint holding the old reader URL must get the new one afterwards.
#
# Needs: aws CLI with access to the slime account (AWS_PROFILE, default `slime`),
# docker (psql runs in the postgres:16 image), node, openssl.
# Never prints a URL or password: they travel in environment variables only.
set -euo pipefail
cd "$(dirname "$0")/.."

export AWS_PROFILE="${AWS_PROFILE:-slime}" AWS_REGION=eu-central-1

MASTER_URL=$(aws ssm get-parameter --with-decryption --name /slime/test-db/MASTER_URL --query Parameter.Value --output text)

# URL edits with node's WHATWG URL, which handles percent-encoded passwords.
rewrite() { MASTER_URL="$MASTER_URL" READER_PASSWORD="${READER_PASSWORD:-}" node -e "$1"; }
# libpq (psql) rejects uselibpqcompat, a node-postgres-only option.
ADMIN_URL=$(rewrite 'const u = new URL(process.env.MASTER_URL); u.searchParams.delete("uselibpqcompat"); process.stdout.write(u.href)')
SHOP_ADMIN_URL=$(rewrite 'const u = new URL(process.env.MASTER_URL); u.searchParams.delete("uselibpqcompat"); u.pathname = "/shop"; process.stdout.write(u.href)')

run_psql() { # $1 = connection URL, rest = psql args; stdin passes through
  PGURL="$1" docker run --rm -i -e PGURL -v "$PWD/db:/sql:ro" postgres:16 \
    sh -c 'exec psql "$PGURL" -X -q -v ON_ERROR_STOP=1 "$@"' psql "${@:2}"
}

echo "recreating database shop (this drops it if it exists)"
run_psql "$ADMIN_URL" -c 'DROP DATABASE IF EXISTS shop WITH (FORCE)' -c 'DROP ROLE IF EXISTS shop_reader' -c 'CREATE DATABASE shop'
echo "loading db/shop.sql"
run_psql "$SHOP_ADMIN_URL" -f /sql/shop.sql >/dev/null

READER_PASSWORD=$(openssl rand -hex 24)
printf "ALTER ROLE shop_reader PASSWORD '%s';\n" "$READER_PASSWORD" | run_psql "$SHOP_ADMIN_URL" -f -

# For Slime (node-postgres): keeps sslmode=require&uselibpqcompat=true.
READER_URL=$(rewrite 'const u = new URL(process.env.MASTER_URL); u.username = "shop_reader"; u.password = process.env.READER_PASSWORD; u.pathname = "/shop"; process.stdout.write(u.href)')
READER_PSQL_URL=$(READER_URL="$READER_URL" node -e 'const u = new URL(process.env.READER_URL); u.searchParams.delete("uselibpqcompat"); process.stdout.write(u.href)')

printf '%s' "$READER_URL" | aws ssm put-parameter --name /slime/test-db/SHOP_READER_URL --type SecureString --overwrite --value file:///dev/stdin >/dev/null

# Proves the reader can log in and read; the counts are not secret.
run_psql "$READER_PSQL_URL" -c "SELECT
  (SELECT count(*) FROM categories) AS categories, (SELECT count(*) FROM products) AS products,
  (SELECT count(*) FROM warehouses) AS warehouses, (SELECT count(*) FROM inventory) AS inventory,
  (SELECT count(*) FROM customers) AS customers, (SELECT count(*) FROM discount_codes) AS discount_codes,
  (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_items) AS order_items,
  (SELECT count(*) FROM payments) AS payments, (SELECT count(*) FROM returns) AS returns,
  (SELECT count(*) FROM reviews) AS reviews, (SELECT count(*) FROM carts) AS carts,
  (SELECT count(*) FROM cart_items) AS cart_items"
run_psql "$SHOP_ADMIN_URL" -c "SELECT pg_size_pretty(pg_database_size('shop')) AS shop_size"

echo "shop loaded; reader URL in SSM /slime/test-db/SHOP_READER_URL (password rotated: update any endpoint that used the old URL)"
