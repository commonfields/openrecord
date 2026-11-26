#!/usr/bin/env bash
# Runs a command against a throwaway PostgreSQL database: creates it in the
# dev container, applies the migrations, exports TEST_DATABASE_URL and
# DATABASE_URL for the command, and drops the database afterwards, whatever
# the command's outcome. Integration tests refuse the dev database itself.
#
#   scripts/test-db.sh pnpm --filter @openrecord/api exec vitest run src/campaigns.integration.test.ts
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$#" -gt 0 ] || { echo "usage: scripts/test-db.sh <command…>" >&2; exit 2; }
container="${OPENRECORD_DEV_PG_CONTAINER:-openrecord-dev-restored-20261030}"
name="openrecord_test_$(date +%Y%m%d%H%M%S)_$$"
psql_admin() { docker exec "$container" psql -U openrecord -d postgres -v ON_ERROR_STOP=1 -qc "$1"; }
psql_admin "CREATE DATABASE $name"
trap 'psql_admin "DROP DATABASE IF EXISTS $name WITH (FORCE)" || echo "could not drop $name" >&2' EXIT
url="postgres://openrecord:openrecord@localhost:5432/$name"
DATABASE_URL="$url" pnpm db:migrate >/dev/null
echo "test database $name ready" >&2
TEST_DATABASE_URL="$url" DATABASE_URL="$url" "$@"
