#!/usr/bin/env bash
# OpenRecord hosted pilot: backup and restore rehearsal.
#
# Backs up the pilot PostgreSQL (custom format, compressed) from the private
# compose network — the database publishes no ports, so the dump runs inside
# the db container. Restore lands in a SEPARATE database inside the same
# container (`pilot_restore_check`): the live pilot database is never touched.
#
# Usage:
#   scripts/hosted-pilot-backup.sh backup  [output-file]   # default backups/openrecord-<ts>.dump
#   scripts/hosted-pilot-backup.sh verify  <backup-file>   # restore + row-count comparison
#
# Environment: expects the stack from deploy/hosted-pilot.compose.yaml to be
# running (docker compose -f deploy/hosted-pilot.compose.yaml ... up).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
compose="docker compose -f $root/deploy/hosted-pilot.compose.yaml --env-file $root/deploy/.env"
db_service="db"
db_name="${POSTGRES_DB:-openrecord}"
db_user="${POSTGRES_USER:-openrecord}"
restore_db="pilot_restore_check"

env_value() {
  # Read a variable from deploy/.env without echoing anything else.
  grep -E "^$1=" "$root/deploy/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true
}
db_name="$(env_value POSTGRES_DB || true)"; db_name="${db_name:-openrecord}"
db_user="$(env_value POSTGRES_USER || true)"; db_user="${db_user:-openrecord}"

cmd="${1:-backup}"
case "$cmd" in
  backup)
    out="${2:-$root/backups/openrecord-$(date +%Y%m%d-%H%M%S).dump}"
    mkdir -p "$(dirname "$out")"
    $compose exec -T "$db_service" pg_dump -U "$db_user" -d "$db_name" -Fc > "$out"
    echo "backup written: $out ($(wc -c < "$out" | tr -d ' ') bytes)"
    ;;
  verify)
    dump="${2:?usage: verify <backup-file>}"
    test -s "$dump"
    echo "restoring into the disposable database '$restore_db' (live database untouched)"
    $compose exec -T "$db_service" dropdb --if-exists -U "$db_user" "$restore_db"
    $compose exec -T "$db_service" createdb -U "$db_user" "$restore_db"
    $compose exec -T "$db_service" pg_restore -U "$db_user" -d "$restore_db" --no-owner --exit-on-error < "$dump"
    # Compare live vs restored on the tables that carry business evidence.
    tables="accounts users businesses buyer_questions record_profiles interventions growth_metric_imports growth_metric_rows growth_reports growth_report_shares"
    counts_sql="SELECT t, n FROM ($(for t in $tables; do echo "SELECT '$t' AS t, count(*) AS n FROM $t UNION ALL"; done | sed '$s/ UNION ALL$//')) x ORDER BY t"
    # Content integrity, not just row counts: digest the immutable evidence
    # payloads (report snapshots, raw observations, import rows) row by row.
    content_sql="SELECT md5(coalesce(string_agg(h, '' ORDER BY h_id), '')) FROM (
      SELECT id::text AS h_id, md5(snapshot_text) AS h FROM growth_reports
      UNION ALL SELECT id::text, md5(content_text) FROM raw_evidence
      UNION ALL SELECT id::text, md5(raw_text) FROM growth_metric_imports
      UNION ALL SELECT id::text, md5(coalesce(answer_text,'')) FROM observations
    ) y"
    live=$($compose exec -T "$db_service" psql -U "$db_user" -d "$db_name" -At -c "$counts_sql")
    restored=$($compose exec -T "$db_service" psql -U "$db_user" -d "$restore_db" -At -c "$counts_sql")
    live_digest=$($compose exec -T "$db_service" psql -U "$db_user" -d "$db_name" -At -c "$content_sql")
    restored_digest=$($compose exec -T "$db_service" psql -U "$db_user" -d "$restore_db" -At -c "$content_sql")
    if [ "$live" = "$restored" ] && [ "$live_digest" = "$restored_digest" ]; then
      echo "restore verified: row counts identical for all tables"
      echo "content digest identical: $live_digest"
      echo "$live"
    else
      echo "MISMATCH between live and restored data:" >&2
      diff <(echo "$live") <(echo "$restored") >&2 || true
      [ "$live_digest" = "$restored_digest" ] || echo "content digest mismatch: $live_digest vs $restored_digest" >&2
      exit 1
    fi
    $compose exec -T "$db_service" dropdb --if-exists -U "$db_user" "$restore_db"
    ;;
  *)
    echo "usage: $0 backup [output-file] | verify <backup-file>" >&2
    exit 2
    ;;
esac
