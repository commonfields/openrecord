-- Campaign results and the next experiment.
--
-- campaign_page_days counts public views of a live campaign page per day, so
-- recorded inquiries can be read as a rate. Prelaunch test views are never
-- counted. Views are page loads, not people: automated visits are included.
CREATE TABLE IF NOT EXISTS campaign_page_days (
  publication_id UUID NOT NULL REFERENCES campaign_publications(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  views INT NOT NULL DEFAULT 0 CHECK (views >= 0),
  PRIMARY KEY (publication_id, day)
);

-- A review the agent proposes for a person to decide: keep, change, stop or
-- inconclusive, with the next experiment. The evidence is the server's own
-- reading at proposal time, never the model's account of it. A verdict other
-- than INCONCLUSIVE is refused when the evidence is not enough to judge.
-- Reviews are kept apart from the campaign brief so recording one never makes
-- a live page's linked revision stale.
CREATE TABLE IF NOT EXISTS campaign_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('KEEP', 'CHANGE', 'STOP', 'INCONCLUSIVE')),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 2000),
  next_hypothesis TEXT NOT NULL CHECK (length(next_hypothesis) <= 1000),
  next_change TEXT NOT NULL CHECK (length(next_change) <= 1000),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  evidence_sufficient BOOLEAN NOT NULL,
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'APPROVED', 'REJECTED')),
  proposed_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by_user_id UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  request_key TEXT NOT NULL UNIQUE CHECK (request_key ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (business_id, campaign_id) REFERENCES marketing_campaigns(business_id, id) ON DELETE CASCADE,
  CHECK (evidence_sufficient OR verdict = 'INCONCLUSIVE'),
  CHECK ((status = 'PROPOSED') = (decided_at IS NULL))
);
-- At most one review waits for a decision per campaign.
CREATE UNIQUE INDEX IF NOT EXISTS campaign_reviews_one_open ON campaign_reviews(campaign_id) WHERE status = 'PROPOSED';

DO $$ BEGIN
  -- The migration runner replays migrations. Keep any later constraint.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='decision_feedback'::regclass
    AND conname='decision_feedback_kind_check' AND pg_get_constraintdef(oid) LIKE '%MARKETING_STRATEGY%') THEN
    RETURN;
  END IF;
  ALTER TABLE decision_feedback DROP CONSTRAINT IF EXISTS decision_feedback_kind_check;
  ALTER TABLE decision_feedback ADD CONSTRAINT decision_feedback_kind_check CHECK (kind IN
    ('CAMPAIGN_PUBLICATION', 'CAMPAIGN_REVIEW', 'AGENT_PROPOSAL', 'AGENT_DRAFT', 'GROWTH_OPPORTUNITY', 'WORDPRESS_CHANGE', 'WEBFLOW_CHANGE', 'ACCOUNT_ACTION'));
END $$;
