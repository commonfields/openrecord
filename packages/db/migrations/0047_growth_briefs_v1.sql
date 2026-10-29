-- The weekly growth brief: once a week, per business, the agent reads what
-- changed (search, ads, AI answers, referrals), what was done and what it
-- changed (the results ledger), and writes a short brief with the one thing
-- to do next, saved as an idea waiting for approval.
--
-- growth_brief_schedules: one row per business; whose models and sign-ins
-- write it, whether it is on, and when it runs next. A lease keeps two
-- server processes from writing the same brief.
-- growth_briefs: each brief, written in its own chat so the person can ask
-- follow-up questions there. One brief runs at a time per business.
--
-- Additive and replay-safe.

CREATE TABLE IF NOT EXISTS growth_brief_schedules (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  next_run_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS growth_brief_schedules_due ON growth_brief_schedules(next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS growth_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','READY','FAILED')),
  trigger TEXT NOT NULL CHECK (trigger IN ('SCHEDULE','MANUAL')),
  conversation_id UUID NULL REFERENCES agent_conversations(id) ON DELETE SET NULL,
  text TEXT NULL CHECK (text IS NULL OR length(text) <= 16000),
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  provider TEXT NULL,
  model TEXT NULL,
  failure TEXT NULL CHECK (failure IS NULL OR failure ~ '^[A-Z_]{1,40}$'),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL,
  CHECK ((status = 'READY') = (text IS NOT NULL)),
  CHECK ((status = 'RUNNING') = (finished_at IS NULL))
);
CREATE INDEX IF NOT EXISTS growth_briefs_business ON growth_briefs(business_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS growth_briefs_one_running ON growth_briefs(business_id) WHERE status = 'RUNNING';
