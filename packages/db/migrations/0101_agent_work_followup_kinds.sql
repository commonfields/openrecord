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
      'VISIBILITY_INVESTIGATION_WRITE'
    ));
END $$;
