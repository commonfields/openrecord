-- A prepared code-repository change is decided in the Inbox like a WordPress or
-- Webflow change, so the person's verdict and reason are kept for it too.
ALTER TABLE decision_feedback DROP CONSTRAINT IF EXISTS decision_feedback_kind_check;
ALTER TABLE decision_feedback ADD CONSTRAINT decision_feedback_kind_check CHECK (kind IN
  ('CAMPAIGN_PUBLICATION', 'CAMPAIGN_REVIEW', 'MARKETING_STRATEGY', 'AGENT_PROPOSAL', 'AGENT_DRAFT', 'GROWTH_OPPORTUNITY', 'WORDPRESS_CHANGE', 'WEBFLOW_CHANGE', 'GITHUB_CHANGE', 'ACCOUNT_ACTION'));
