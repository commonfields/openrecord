-- A person can archive a chat they are done with: it leaves the sidebar's
-- history and shows under Archived until they restore it or write in it again.
-- Archiving never deletes messages and does not change when the chat last
-- moved. This is separate from archived_at (0038), which marks every chat
-- other than a business's current default one.
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS user_archived_at TIMESTAMPTZ;
DROP INDEX IF EXISTS agent_conversations_history;
CREATE INDEX IF NOT EXISTS agent_conversations_user_archive
  ON agent_conversations(account_id, user_id, (user_archived_at IS NOT NULL), updated_at DESC);
