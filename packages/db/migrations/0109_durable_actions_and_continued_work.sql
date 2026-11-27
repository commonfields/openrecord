-- Approved account actions run through the durable publish job and read the
-- account before they write; a new ad is never sent twice. Background agent
-- turns cut short by a restart run again as a continuation, a few times at most.
ALTER TABLE account_actions ADD COLUMN IF NOT EXISTS write_attempted_at timestamptz;
ALTER TABLE agent_work_jobs ADD COLUMN IF NOT EXISTS continuations integer NOT NULL DEFAULT 0;
