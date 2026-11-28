-- Spend limits on the hosted agent model, per account.
--
-- The server sets defaults (AGENT_DAILY_LIMIT_USD, AGENT_MONTHLY_LIMIT_USD,
-- AGENT_DAILY_LIMIT_TOKENS); a row here overrides them for one account. A
-- NULL column keeps the server default; 0 switches that limit off. Spend is
-- read from agent_usage, so a limit applies from the next model step.
CREATE TABLE IF NOT EXISTS account_agent_limits (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  daily_usd NUMERIC(12, 2) CHECK (daily_usd IS NULL OR daily_usd >= 0),
  monthly_usd NUMERIC(12, 2) CHECK (monthly_usd IS NULL OR monthly_usd >= 0),
  daily_tokens BIGINT CHECK (daily_tokens IS NULL OR daily_tokens >= 0),
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
