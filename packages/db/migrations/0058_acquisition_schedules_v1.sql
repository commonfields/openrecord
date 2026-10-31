-- Scheduled AI-answer tracking. A person approves a schedule once: which
-- frozen question set, how often, how many samples, and the exact provider-call
-- ceiling of each run (questions x samples x attempts). The server then starts
-- one ordinary measurement batch per period through the same path as a manual
-- batch. If the set's size no longer matches the approved ceiling, the schedule
-- pauses instead of spending more.
--
-- When a run finishes it is compared with the run before it; a drop in how
-- often answers name the business, or cite its own site, opens an alert (and,
-- when the business has a growth goal, an investigation for the agent).
-- Alerts use the automatic exact-name match and citation owner, which are not
-- human-reviewed findings, and say so.
CREATE TABLE IF NOT EXISTS acq_schedules (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  approved_by_user_id UUID NOT NULL REFERENCES users(id),
  set_id UUID NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('DAILY', 'WEEKLY')),
  samples INT NOT NULL CHECK (samples BETWEEN 1 AND 5),
  max_provider_calls INT NOT NULL CHECK (max_provider_calls >= 1),
  alert_drop_points INT NOT NULL DEFAULT 15 CHECK (alert_drop_points BETWEEN 5 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT true,
  paused_reason TEXT CHECK (paused_reason IS NULL OR length(paused_reason) <= 80),
  next_run_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ,
  last_batch_id UUID,
  previous_batch_id UUID,
  compared_batch_id UUID,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS acq_schedules_due ON acq_schedules(next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS acq_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('BRAND_MENTIONS_DROPPED', 'OWN_CITATIONS_DROPPED')),
  before_batch_id UUID NOT NULL,
  after_batch_id UUID NOT NULL,
  before_n INT NOT NULL, before_d INT NOT NULL CHECK (before_d > 0),
  after_n INT NOT NULL, after_d INT NOT NULL CHECK (after_d > 0),
  investigation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (after_batch_id, kind)
);
CREATE INDEX IF NOT EXISTS acq_alerts_recent ON acq_alerts(business_id, created_at DESC);
