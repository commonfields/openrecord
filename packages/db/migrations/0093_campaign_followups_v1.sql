-- Campaign follow-ups: the agent picks a campaign back up at its milestones,
-- under the follow-up permission the person already granted for the business
-- (growth_investigation_wake_policies). Nothing here grants new authority: a
-- campaign wake is read-only, shares the same one-per-24-hours budget as an
-- investigation wake, and is cancelled when the person turns follow-ups off.
--
-- A milestone fires once per campaign: the page went live, the first real
-- inquiry arrived, or the campaign's review date was reached.
CREATE TABLE IF NOT EXISTS campaign_wakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES growth_investigation_wake_policies(id) ON DELETE CASCADE,
  grant_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL,
  milestone TEXT NOT NULL CHECK (milestone IN ('PAGE_LIVE', 'FIRST_INQUIRY', 'REVIEW_DUE')),
  -- What the milestone is about: the publication for PAGE_LIVE and FIRST_INQUIRY, the review date for REVIEW_DUE.
  milestone_key TEXT NOT NULL CHECK (milestone_key ~ '^([0-9a-f-]{36}|[0-9]{4}-[0-9]{2}-[0-9]{2})$'),
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline TIMESTAMPTZ NOT NULL DEFAULT now() + interval '3 minutes',
  finished_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, campaign_id) REFERENCES marketing_campaigns(business_id, id) ON DELETE CASCADE,
  UNIQUE (policy_id, campaign_id, milestone, milestone_key)
);
CREATE INDEX IF NOT EXISTS campaign_wakes_policy ON campaign_wakes(policy_id, started_at);
