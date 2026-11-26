-- Webflow changes and GitHub pull-request changes can name the wrong AI answer
-- (claim) they fix, as WordPress changes can (0104). Publishing a Webflow
-- change, or a merged pull request whose page is seen live, records the fix on
-- that issue and queues a re-check.
ALTER TABLE webflow_changes ADD COLUMN IF NOT EXISTS claim_id UUID NULL REFERENCES candidate_claims(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS webflow_changes_claim ON webflow_changes(claim_id) WHERE claim_id IS NOT NULL;
ALTER TABLE growth_execution_operations ADD COLUMN IF NOT EXISTS claim_id UUID NULL REFERENCES candidate_claims(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS growth_execution_operations_claim ON growth_execution_operations(claim_id) WHERE claim_id IS NOT NULL;
