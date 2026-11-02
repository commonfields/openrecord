-- Shared chats: a revocable, read-only link to one agent conversation, for a
-- client or teammate without an account. The page shows the conversation as
-- it is when opened (later messages included) until the link expires or is
-- revoked. It shows who said what, the agent's replies and their citations;
-- never the model's reasoning, tool internals or attached file contents.
-- Only the token's SHA-256 is stored; the link is shown once.
CREATE TABLE IF NOT EXISTS agent_chat_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  token_hint TEXT NOT NULL CHECK (token_hint ~ '^[A-Za-z0-9_-]{4}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  last_viewed_at TIMESTAMPTZ NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS agent_chat_shares_conversation ON agent_chat_shares(conversation_id, created_at DESC);
