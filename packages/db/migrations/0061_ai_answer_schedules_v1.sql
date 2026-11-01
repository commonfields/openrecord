-- Scheduled AI answer tracking on the team's own AI subscriptions. A person
-- approves, for one business: how often, which connected models, and exactly
-- how many questions are asked per run. The server then asks the latest
-- question set's questions on those models each period and saves the answers
-- as research evidence. If the set or the models no longer match what was
-- approved, the schedule pauses until a person approves again.
CREATE TABLE IF NOT EXISTS ai_answer_schedules (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  approved_by_user_id UUID NOT NULL REFERENCES users(id),
  cadence TEXT NOT NULL CHECK (cadence IN ('DAILY', 'WEEKLY')),
  engines JSONB NOT NULL CHECK (jsonb_typeof(engines) = 'array' AND jsonb_array_length(engines) BETWEEN 1 AND 3),
  asks_per_run INT NOT NULL CHECK (asks_per_run BETWEEN 1 AND 8),
  alert_drop_points INT NOT NULL DEFAULT 20 CHECK (alert_drop_points BETWEEN 5 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT true,
  paused_reason TEXT CHECK (paused_reason IS NULL OR length(paused_reason) <= 80),
  next_run_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ,
  last_observation_id UUID,
  previous_observation_id UUID,
  last_alert JSONB,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_answer_schedules_due ON ai_answer_schedules(next_run_at) WHERE enabled;
