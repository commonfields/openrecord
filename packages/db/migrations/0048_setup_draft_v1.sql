-- The agent drafts the setup brief from the website, so the person checks and
-- confirms instead of typing it. The draft is a model suggestion: untrusted,
-- never a fact or a goal until the person confirms the brief through the
-- existing session-authenticated confirm step. It also names likely
-- competitors for later AI-answer measurement.
--
-- Additive and replay-safe.
ALTER TABLE business_setups ADD COLUMN IF NOT EXISTS draft JSONB NULL;
ALTER TABLE business_setups ADD COLUMN IF NOT EXISTS draft_status TEXT NULL;
ALTER TABLE business_setups ADD COLUMN IF NOT EXISTS draft_started_at TIMESTAMPTZ NULL;
ALTER TABLE business_setups ADD COLUMN IF NOT EXISTS draft_conversation_id UUID NULL REFERENCES agent_conversations(id) ON DELETE SET NULL;
ALTER TABLE business_setups DROP CONSTRAINT IF EXISTS business_setups_draft_check;
ALTER TABLE business_setups ADD CONSTRAINT business_setups_draft_check CHECK (
  (draft_status IS NULL OR draft_status IN ('RUNNING','READY','FAILED'))
  AND ((draft_status = 'READY') = (draft IS NOT NULL))
  AND (draft IS NULL OR (jsonb_typeof(draft) = 'object' AND pg_column_size(draft) <= 20000)));
