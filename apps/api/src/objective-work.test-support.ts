import type pg from "pg"

/**
 * Test fixture only: gives a business a new primary growth goal version, the way a
 * profile update does (new goal row, profile repointed). Returns the new goal id.
 */
export const seedObjective = async (pool: pg.Pool, businessId: string, userId: string, statement: string) => {
  await pool.query("INSERT INTO record_profiles(business_id,website_url) VALUES($1,'https://example.test') ON CONFLICT (business_id) DO NOTHING", [businessId])
  const metric = String((await pool.query(`INSERT INTO growth_metric_definitions(business_id,version,conversion_kind,label,source_kind,source_identity,event_name,
      counting_semantics,unit,currency,reporting_time_zone,property_ref,created_by_user_id)
    SELECT $1,COALESCE(MAX(version),0)+1,'SIGNUP','Signups','GA4_AGGREGATE_EXPORT','Test','signup','EVENT_COUNT','COUNT',NULL,'UTC','Test',$2
    FROM growth_metric_definitions WHERE business_id=$1 RETURNING id`, [businessId, userId])).rows[0].id)
  const goal = String((await pool.query(`INSERT INTO growth_goals(business_id,version,statement,metric_definition_id,created_by_user_id)
    SELECT $1,COALESCE(MAX(version),0)+1,$2,$3,$4 FROM growth_goals WHERE business_id=$1 RETURNING id`, [businessId, statement, metric, userId])).rows[0].id)
  await pool.query(`INSERT INTO growth_profiles(business_id,category,audience,value_proposition,primary_goal_id,updated_by_user_id)
    VALUES($1,'Software','Teams','Help teams',$2,$3)
    ON CONFLICT(business_id) DO UPDATE SET primary_goal_id=excluded.primary_goal_id,updated_at=now()`, [businessId, goal, userId])
  return goal
}
