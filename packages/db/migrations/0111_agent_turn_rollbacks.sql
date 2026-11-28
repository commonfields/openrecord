-- Undoing a chat from one of the person's messages: the turns from there on
-- leave the chat, and the pending work they saved is withdrawn. Each rollback
-- is kept with what it changed, and its request ID makes a retried click
-- return the same result instead of undoing a second time.
CREATE TABLE IF NOT EXISTS agent_conversation_rollbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  -- Index of the first message removed, and how many were removed.
  from_index integer NOT NULL CHECK (from_index >= 0),
  removed_messages integer NOT NULL CHECK (removed_messages >= 1),
  -- The runs whose turns were removed; their journals stay in agent_runs.
  run_ids uuid[] NOT NULL DEFAULT '{}',
  -- What changed: cards withdrawn or kept, artifacts restored, archived or kept, helpers stopped.
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 200000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, request_id)
);
CREATE INDEX IF NOT EXISTS agent_conversation_rollbacks_conversation
  ON agent_conversation_rollbacks (conversation_id, created_at DESC);
