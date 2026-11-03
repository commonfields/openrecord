-- Decision feedback: what a person decided on the agent's work and why, so
-- the agent learns from it. One row per decision on a proposal, draft,
-- growth initiative or website change: the verdict, an optional one-line
-- reason, a snapshot of what was decided, and later an outcome note the agent
-- records after measuring what happened (never a claim of cause).
CREATE TABLE IF NOT EXISTS decision_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('AGENT_PROPOSAL', 'AGENT_DRAFT', 'GROWTH_OPPORTUNITY', 'WORDPRESS_CHANGE')),
  item_id UUID NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('APPROVED', 'REJECTED')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  reason TEXT NULL CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  decided_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome_note TEXT NULL CHECK (outcome_note IS NULL OR length(outcome_note) <= 1000),
  outcome_at TIMESTAMPTZ NULL,
  UNIQUE (business_id, kind, item_id)
);
CREATE INDEX IF NOT EXISTS decision_feedback_business ON decision_feedback(business_id, decided_at DESC);
