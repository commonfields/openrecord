-- M2 pre-merge check: existing campaign delivery links that the stricter
-- link rule in migration 0083 would refuse if they were made today.
--
-- Read only. It changes nothing and prints ids and counts only, never page
-- content. It works before or after migrations 0082 and 0083 are applied.
--
-- Hosted pilot (from the repository root, on the host):
--   docker compose -f deploy/hosted-pilot.compose.yaml --env-file deploy/.env \
--     exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < scripts/m2-premerge-link-check.sql
-- Any other database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/m2-premerge-link-check.sql
--
-- If it stops with 'relation "marketing_campaign_deliveries" does not exist',
-- that database predates migration 0072 and has no links: its count is 0.
--
-- Report the "would_reject" count. If it is above 0, stop: keeping, marking or
-- leaving those links is an operator decision, not part of the migration.

BEGIN TRANSACTION READ ONLY;

-- The same link check feeds both queries below.
WITH m2_link_check AS (
  SELECT d.task_id,
         d.business_id,
         r.campaign_id,
         d.run_id,
         d.wordpress_change_id,
         w.created_at < r.created_at AS change_before_run,
         w.decided_at IS NOT NULL AND w.decided_at <= d.created_at AS decided_before_link,
         -- Read through jsonb so the check runs before 0082 adds the column.
         (to_jsonb(w) ->> 'objective_goal_id') IS DISTINCT FROM (to_jsonb(c) ->> 'objective_goal_id') AS objective_mismatch,
         count(*) OVER (PARTITION BY d.wordpress_change_id) > 1 AS change_linked_twice,
         w.business_id IS DISTINCT FROM d.business_id AS change_other_business
  FROM marketing_campaign_deliveries d
  JOIN marketing_campaign_runs r ON r.id = d.run_id AND r.business_id = d.business_id
  JOIN marketing_campaigns c ON c.id = r.campaign_id AND c.business_id = r.business_id
  JOIN wordpress_changes w ON w.id = d.wordpress_change_id
)
SELECT current_database() AS database,
       (SELECT max(filename) FROM public.schema_migrations) AS latest_migration,
       count(*) AS links,
       count(*) FILTER (WHERE change_before_run OR decided_before_link OR objective_mismatch OR change_linked_twice OR change_other_business) AS would_reject,
       count(*) FILTER (WHERE change_before_run) AS change_before_run,
       count(*) FILTER (WHERE decided_before_link) AS decided_before_link,
       count(*) FILTER (WHERE objective_mismatch) AS objective_mismatch,
       count(*) FILTER (WHERE change_linked_twice) AS change_linked_twice,
       count(*) FILTER (WHERE change_other_business) AS change_other_business
FROM m2_link_check;

-- The rows behind a non-zero count, for the operator's decision.
WITH m2_link_check AS (
  SELECT d.task_id,
         d.business_id,
         r.campaign_id,
         d.run_id,
         d.wordpress_change_id,
         w.created_at < r.created_at AS change_before_run,
         w.decided_at IS NOT NULL AND w.decided_at <= d.created_at AS decided_before_link,
         -- Read through jsonb so the check runs before 0082 adds the column.
         (to_jsonb(w) ->> 'objective_goal_id') IS DISTINCT FROM (to_jsonb(c) ->> 'objective_goal_id') AS objective_mismatch,
         count(*) OVER (PARTITION BY d.wordpress_change_id) > 1 AS change_linked_twice,
         w.business_id IS DISTINCT FROM d.business_id AS change_other_business
  FROM marketing_campaign_deliveries d
  JOIN marketing_campaign_runs r ON r.id = d.run_id AND r.business_id = d.business_id
  JOIN marketing_campaigns c ON c.id = r.campaign_id AND c.business_id = r.business_id
  JOIN wordpress_changes w ON w.id = d.wordpress_change_id
)
SELECT business_id, campaign_id, run_id, task_id, wordpress_change_id, change_other_business,
       change_before_run, decided_before_link, objective_mismatch, change_linked_twice
FROM m2_link_check
WHERE change_before_run OR decided_before_link OR objective_mismatch OR change_linked_twice OR change_other_business
ORDER BY business_id, campaign_id, run_id, task_id;

ROLLBACK;
