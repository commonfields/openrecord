import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/** At most this many rows of each kind; newest first, current objective first. */
export const OBJECTIVE_WORK_LIMIT = 10

export const OBJECTIVE_WORK_NOTE = "Work the server linked to the objective when it was created, read now from the records themselves, not from notes. currentObjective false means it was created under an earlier version of the goal. A link is not approval, delivery or success; read each record's current state before acting. objectiveMismatch means a website change and the campaign it was delivered for were created under different goal versions."

/**
 * Work linked to the business's objective by creation-time lineage (migration 0082).
 * Recovery is a structured query by business and goal; it never parses notes or relies on model recall.
 * Callers must have checked that the account may read the business.
 */
export const readObjectiveWork = (businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const goal = (yield* sql<{ id: string; version: number }>`SELECT g.id, g.version FROM growth_profiles p
    JOIN growth_goals g ON g.id = p.primary_goal_id AND g.business_id = p.business_id WHERE p.business_id = ${businessId}`)[0] ?? null
  const current = goal?.id ?? null
  const campaigns = yield* sql`SELECT c.id, left(c.brief->>'title', 120) AS title, c.brief->>'status' AS status, c.revision,
      COALESCE(jsonb_array_length(c.brief->'tasks'), 0) AS deliverables, c.objective_goal_id AS "goalId", g.version AS "goalVersion",
      (c.objective_goal_id IS NOT DISTINCT FROM ${current}::uuid) AS "currentObjective", c.updated_at AS "updatedAt"
    FROM marketing_campaigns c JOIN growth_goals g ON g.id = c.objective_goal_id AND g.business_id = c.business_id
    WHERE c.business_id = ${businessId} AND c.objective_goal_id IS NOT NULL
    ORDER BY (c.objective_goal_id IS NOT DISTINCT FROM ${current}::uuid) DESC, g.version DESC, c.updated_at DESC, c.id LIMIT ${OBJECTIVE_WORK_LIMIT}`
  const wordpressChanges = yield* sql`SELECT w.id, w.kind, w.status, left(w.target_title, 120) AS title, w.objective_goal_id AS "goalId", g.version AS "goalVersion",
      (w.objective_goal_id IS NOT DISTINCT FROM ${current}::uuid) AS "currentObjective", w.created_at AS "createdAt",
      d.campaign_id AS "campaignId", (d.campaign_id IS NOT NULL AND d.campaign_goal IS DISTINCT FROM w.objective_goal_id) AS "objectiveMismatch"
    FROM wordpress_changes w JOIN growth_goals g ON g.id = w.objective_goal_id AND g.business_id = w.business_id
    LEFT JOIN LATERAL (SELECT r.campaign_id, mc.objective_goal_id AS campaign_goal FROM marketing_campaign_deliveries md
      JOIN marketing_campaign_runs r ON r.id = md.run_id AND r.business_id = md.business_id
      JOIN marketing_campaigns mc ON mc.id = r.campaign_id AND mc.business_id = r.business_id
      WHERE md.wordpress_change_id = w.id AND md.business_id = w.business_id ORDER BY md.created_at LIMIT 1) d ON true
    WHERE w.business_id = ${businessId} AND w.objective_goal_id IS NOT NULL
    ORDER BY (w.objective_goal_id IS NOT DISTINCT FROM ${current}::uuid) DESC, g.version DESC, w.created_at DESC, w.id LIMIT ${OBJECTIVE_WORK_LIMIT}`
  const accountActions = yield* sql`SELECT a.id, a.provider, a.kind, a.status, a.objective_goal_id AS "goalId", g.version AS "goalVersion",
      (a.objective_goal_id IS NOT DISTINCT FROM ${current}::uuid) AS "currentObjective", a.created_at AS "createdAt"
    FROM account_actions a JOIN growth_goals g ON g.id = a.objective_goal_id AND g.business_id = a.business_id
    WHERE a.business_id = ${businessId} AND a.objective_goal_id IS NOT NULL
    ORDER BY (a.objective_goal_id IS NOT DISTINCT FROM ${current}::uuid) DESC, g.version DESC, a.created_at DESC, a.id LIMIT ${OBJECTIVE_WORK_LIMIT}`
  return { goalId: current, goalVersion: goal ? Number(goal.version) : null, campaigns, wordpressChanges, accountActions, limitPerKind: OBJECTIVE_WORK_LIMIT, note: OBJECTIVE_WORK_NOTE }
})

export type ObjectiveWork = Effect.Effect.Success<ReturnType<typeof readObjectiveWork>>
