-- Keep earlier chats when starting a new default conversation. Existing rows
-- remain the default, with their IDs, messages, leases and replay data intact.
-- Deploy with the updated API; older writers assume a full-scope unique key.
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE agent_conversations DROP CONSTRAINT IF EXISTS agent_conversations_account_id_business_id_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS agent_conversations_current
  ON agent_conversations(account_id, business_id, user_id) WHERE archived_at IS NULL;
