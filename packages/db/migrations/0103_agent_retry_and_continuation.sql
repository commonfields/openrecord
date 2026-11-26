-- Background agent work retries a failure only when its handler says no work
-- was saved, after a growing delay. Chat requests cut off by a restart get a
-- bounded chain of continuation requests.
ALTER TABLE agent_work_jobs ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE agent_work_jobs ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS agent_work_queue_available ON agent_work_jobs (available_at, created_at) WHERE status='QUEUED';

ALTER TABLE agent_request_jobs ADD COLUMN IF NOT EXISTS continues_request_id uuid;
ALTER TABLE agent_request_jobs ADD COLUMN IF NOT EXISTS continuation_depth integer NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='agent_request_jobs'::regclass AND conname='agent_request_jobs_continuation_depth_check') THEN
    ALTER TABLE agent_request_jobs ADD CONSTRAINT agent_request_jobs_continuation_depth_check CHECK (continuation_depth BETWEEN 0 AND 3);
  END IF;
END $$;
-- One continuation per interrupted request, so reconciling twice cannot fork the chain.
CREATE UNIQUE INDEX IF NOT EXISTS agent_request_jobs_one_continuation ON agent_request_jobs (continues_request_id) WHERE continues_request_id IS NOT NULL;
