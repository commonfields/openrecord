ALTER TABLE marketing_campaign_revisions ADD COLUMN IF NOT EXISTS agent_request_key text;
ALTER TABLE marketing_campaign_revisions ADD COLUMN IF NOT EXISTS revision_reason text;
CREATE UNIQUE INDEX IF NOT EXISTS marketing_campaign_revision_request ON marketing_campaign_revisions(campaign_id,agent_request_key) WHERE agent_request_key IS NOT NULL;
