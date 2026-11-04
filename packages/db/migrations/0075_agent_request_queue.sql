CREATE TABLE IF NOT EXISTS agent_request_jobs (
  request_id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 500000),
  digest text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  claim_id uuid,
  lease_until timestamptz,
  result jsonb,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_request_conversation_active ON agent_request_jobs(conversation_id) WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX IF NOT EXISTS agent_request_queue ON agent_request_jobs(created_at) WHERE status='QUEUED';
