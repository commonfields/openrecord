-- A chat picks its work back up after the owner decides on a card it saved,
-- and the agent's signals about OpenRecord's own capabilities are kept: what it
-- needed and could not find, and tool results it found wrong or useless.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_work_jobs'::regclass
    AND conname='agent_work_jobs_kind_check' AND pg_get_constraintdef(oid) LIKE '%DECISION_RESUME_WRITE%') THEN
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
      'DECISION_RESUME_WRITE'
    ));
END $$;

CREATE TABLE IF NOT EXISTS agent_capability_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('MISSING', 'POOR_RESULT')),
  -- The tool or research capability a POOR_RESULT is about; NULL for MISSING.
  tool text CHECK (tool IS NULL OR tool ~ '^[a-z][a-z0-9_.-]{1,119}$'),
  problem text CHECK (problem IS NULL OR problem IN ('WRONG', 'EMPTY', 'STALE', 'OFF_TOPIC')),
  need text NOT NULL CHECK (length(need) BETWEEN 2 AND 300),
  note text CHECK (note IS NULL OR length(note) <= 500),
  -- Who raised it: the agent by itself (a search that found nothing) or by calling a tool.
  source text NOT NULL CHECK (source IN ('SEARCH_MISS', 'AGENT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'MISSING') = (tool IS NULL)),
  CHECK ((kind = 'POOR_RESULT') = (problem IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS agent_capability_signals_recent ON agent_capability_signals (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_capability_signals_tool ON agent_capability_signals (account_id, tool, created_at DESC) WHERE tool IS NOT NULL;
