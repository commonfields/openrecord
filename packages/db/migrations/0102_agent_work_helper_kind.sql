DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_work_jobs'::regclass
    AND conname='agent_work_jobs_kind_check' AND pg_get_constraintdef(oid) LIKE '%HELPER_TASK_RUN%') THEN
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
      'HELPER_TASK_RUN'
    ));
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS agent_work_helper_receipts ON agent_work_jobs (ref_id) WHERE kind='HELPER_TASK_RUN';
CREATE INDEX IF NOT EXISTS agent_tasks_async_unwoken ON agent_tasks (created_at, id)
  WHERE mode='async' AND woke_parent_at IS NULL AND status<>'CANCELLED';
