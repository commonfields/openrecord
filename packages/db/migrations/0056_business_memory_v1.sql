-- Business memory: short notes the agent (or the team) keeps about one
-- business across chats, such as a preference, a decision, a lesson from
-- earlier work, or something to avoid. They are working context, not
-- evidence: the agent reads them at the start of every turn for this business
-- and must not present them as verified facts. A note is forgotten, never
-- edited or deleted, so what the agent was told stays auditable.
CREATE TABLE IF NOT EXISTS business_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('PREFERENCE', 'DECISION', 'LESSON', 'AVOID', 'CONTEXT')),
  text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 400),
  text_digest TEXT NOT NULL CHECK (text_digest ~ '^[a-f0-9]{64}$'),
  source TEXT NOT NULL CHECK (source IN ('ASSISTANT', 'OPERATOR')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  conversation_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  forgotten_at TIMESTAMPTZ NULL,
  forgotten_by_user_id UUID NULL REFERENCES users(id),
  CHECK ((forgotten_at IS NULL) = (forgotten_by_user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS business_memories_active_text ON business_memories(business_id, text_digest) WHERE forgotten_at IS NULL;
CREATE INDEX IF NOT EXISTS business_memories_recent ON business_memories(business_id, created_at DESC) WHERE forgotten_at IS NULL;
