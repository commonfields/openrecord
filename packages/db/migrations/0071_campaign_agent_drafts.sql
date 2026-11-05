ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS created_by_actor text NOT NULL DEFAULT 'OPERATOR' CHECK (created_by_actor IN ('OPERATOR','ASSISTANT'));
ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS draft_key text;
CREATE UNIQUE INDEX IF NOT EXISTS marketing_campaign_draft_key ON marketing_campaigns(business_id, draft_key) WHERE draft_key IS NOT NULL;
ALTER TABLE marketing_campaign_revisions ADD COLUMN IF NOT EXISTS actor text NOT NULL DEFAULT 'OPERATOR' CHECK (actor IN ('OPERATOR','ASSISTANT'));
