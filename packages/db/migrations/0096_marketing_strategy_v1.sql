-- A business's marketing strategy, versioned: the audience, positioning,
-- offer, voice, phrases to avoid, priority bets and budget limit every
-- campaign should follow. The agent proposes a version; a person approves it.
-- Approving one supersedes the previous approved version, which is kept.
-- A budget limit here is planning context: it never authorizes spending.
CREATE TABLE IF NOT EXISTS marketing_strategy_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version INT NOT NULL CHECK (version >= 1),
  -- The approved version this one was written against, or null for the first.
  based_on_version INT NULL,
  audience TEXT NOT NULL CHECK (length(audience) <= 1500),
  positioning TEXT NOT NULL CHECK (length(positioning) <= 1500),
  offer TEXT NOT NULL CHECK (length(offer) <= 1500),
  voice TEXT NOT NULL CHECK (length(voice) <= 1000),
  avoid_phrases TEXT[] NOT NULL CHECK (cardinality(avoid_phrases) <= 30),
  priority_bets TEXT[] NOT NULL CHECK (cardinality(priority_bets) <= 10),
  budget_limit TEXT NOT NULL CHECK (length(budget_limit) <= 300),
  rationale TEXT NOT NULL CHECK (length(rationale) BETWEEN 1 AND 2000),
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'SUPERSEDED')),
  proposed_by_actor TEXT NOT NULL CHECK (proposed_by_actor IN ('ASSISTANT', 'OPERATOR')),
  proposed_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by_user_id UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  request_key TEXT NOT NULL UNIQUE CHECK (request_key ~ '^[a-f0-9]{64}$'),
  UNIQUE (business_id, version)
);
-- One approved and at most one waiting version per business.
CREATE UNIQUE INDEX IF NOT EXISTS marketing_strategy_one_approved ON marketing_strategy_versions(business_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX IF NOT EXISTS marketing_strategy_one_open ON marketing_strategy_versions(business_id) WHERE status = 'PROPOSED';

DO $$ BEGIN
  -- The migration runner replays migrations. Keep any later constraint.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='decision_feedback'::regclass
    AND conname='decision_feedback_kind_check' AND pg_get_constraintdef(oid) LIKE '%GITHUB_CHANGE%') THEN
    RETURN;
  END IF;
  ALTER TABLE decision_feedback DROP CONSTRAINT IF EXISTS decision_feedback_kind_check;
  ALTER TABLE decision_feedback ADD CONSTRAINT decision_feedback_kind_check CHECK (kind IN
    ('CAMPAIGN_PUBLICATION', 'CAMPAIGN_REVIEW', 'MARKETING_STRATEGY', 'AGENT_PROPOSAL', 'AGENT_DRAFT', 'GROWTH_OPPORTUNITY', 'WORDPRESS_CHANGE', 'WEBFLOW_CHANGE', 'ACCOUNT_ACTION'));
END $$;
