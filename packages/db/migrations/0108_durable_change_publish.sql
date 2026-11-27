-- Approved WordPress and Webflow changes are published by a durable job that
-- reads the site before it writes, so a crash mid-publish is finished or
-- settled on recovery instead of being left half done.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_work_jobs'::regclass
    AND conname='agent_work_jobs_kind_check' AND pg_get_constraintdef(oid) LIKE '%CHANGE_PUBLISH_WRITE%') THEN
    RETURN;
  END IF;
  ALTER TABLE agent_work_jobs DROP CONSTRAINT IF EXISTS agent_work_jobs_kind_check;
  ALTER TABLE agent_work_jobs ADD CONSTRAINT agent_work_jobs_kind_check
    CHECK (kind IN (
      'GROWTH_BRIEF_WRITE',
      'SETUP_DRAFT_WRITE',
      'APPROVED_INITIATIVE_WRITE',
      'DECLINED_INITIATIVE_WRITE',
      'INVESTIGATION_FOLLOWUP_WRITE',
      'CAMPAIGN_FOLLOWUP_WRITE',
      'VISIBILITY_INVESTIGATION_WRITE',
      'HELPER_TASK_RUN',
      'SETUP_CAMPAIGN_WRITE',
      'DECISION_RESUME_WRITE',
      'CHANGE_PUBLISH_WRITE'
    ));
END $$;
-- When a publish first sent a new page or item. A retry after that never
-- creates a second one: it adopts the one it finds or reports the outcome unknown.
ALTER TABLE wordpress_changes ADD COLUMN IF NOT EXISTS write_attempted_at timestamptz;
ALTER TABLE webflow_changes ADD COLUMN IF NOT EXISTS write_attempted_at timestamptz;
