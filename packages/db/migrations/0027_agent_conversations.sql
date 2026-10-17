-- Private bounded conversations. No raw provider evidence is copied here.
CREATE TABLE IF NOT EXISTS agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  messages JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(messages) = 'array' AND jsonb_array_length(messages) <= 24),
  revision INTEGER NOT NULL DEFAULT 0,
  lease_id UUID NULL,
  lease_until TIMESTAMPTZ NULL,
  last_request_id UUID NULL,
  last_reply JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  UNIQUE(account_id, business_id, user_id)
);
CREATE INDEX IF NOT EXISTS agent_conversations_expiry ON agent_conversations(expires_at);
