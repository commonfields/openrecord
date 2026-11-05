ALTER TABLE agent_request_jobs ADD COLUMN IF NOT EXISTS execution_started_at timestamptz;

CREATE TABLE IF NOT EXISTS agent_worker_instances (
  id uuid PRIMARY KEY,
  mode text NOT NULL CHECK (mode IN ('api','standalone')),
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  source_fingerprint text
);
