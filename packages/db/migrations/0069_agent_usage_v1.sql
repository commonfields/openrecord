-- Agent usage: one row per completed agent turn, committed with its reply,
-- kept when the conversation is deleted so an account's usage stays complete.
-- Token counts are as the provider reported them (null when it reported
-- none); they are not a bill. No message text is stored here.
CREATE TABLE IF NOT EXISTS agent_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NULL REFERENCES businesses(id) ON DELETE SET NULL,
  user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  run_id UUID NULL,
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 60),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  model_steps INTEGER NOT NULL DEFAULT 0 CHECK (model_steps >= 0),
  tool_calls INTEGER NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  prompt_tokens BIGINT NULL CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
  output_tokens BIGINT NULL CHECK (output_tokens IS NULL OR output_tokens >= 0),
  thought_tokens BIGINT NULL CHECK (thought_tokens IS NULL OR thought_tokens >= 0),
  total_tokens BIGINT NULL CHECK (total_tokens IS NULL OR total_tokens >= 0),
  duration_ms INTEGER NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id)
);
CREATE INDEX IF NOT EXISTS agent_usage_account_created ON agent_usage(account_id, created_at DESC);
