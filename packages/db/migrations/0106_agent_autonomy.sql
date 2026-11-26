-- The agent works without being switched on: a finished setup queues the
-- first campaign, and active businesses get follow-ups that run on whichever
-- model works at the time. Turning follow-ups off stays respected.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_work_jobs'::regclass
    AND conname='agent_work_jobs_kind_check' AND pg_get_constraintdef(oid) LIKE '%SETUP_CAMPAIGN_WRITE%') THEN
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
      'SETUP_CAMPAIGN_WRITE'
    ));
END $$;
-- The first campaign is started once per setup, whatever happens to that job.
CREATE UNIQUE INDEX IF NOT EXISTS agent_work_setup_campaign_once ON agent_work_jobs (ref_id) WHERE kind='SETUP_CAMPAIGN_WRITE';

-- An automatic policy was created by OpenRecord, not granted for one model: its
-- wakes use the working model at the time. A person's own choice clears it.
ALTER TABLE growth_investigation_wake_policies ADD COLUMN IF NOT EXISTS automatic boolean NOT NULL DEFAULT false;

-- Turning follow-ups off for a business. Kept apart from the policy, which is
-- deleted with its chat, so a pause outlives the chat it was set in.
CREATE TABLE IF NOT EXISTS agent_followup_pauses (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  paused_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  paused_at timestamptz NOT NULL DEFAULT now()
);
