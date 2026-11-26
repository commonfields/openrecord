-- Durable background agent work (brief writing, setup drafts). Processed by the
-- same worker pool as chat request jobs; not replayed after execution starts.
CREATE TABLE IF NOT EXISTS agent_work_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('GROWTH_BRIEF_WRITE','SETUP_DRAFT_WRITE')),
  ref_id uuid NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 100000),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  claim_id uuid,
  lease_until timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  execution_started_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_work_active ON agent_work_jobs (kind, ref_id) WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX IF NOT EXISTS agent_work_queue ON agent_work_jobs (created_at) WHERE status='QUEUED';