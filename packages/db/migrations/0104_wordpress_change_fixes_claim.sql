-- A website change can name the wrong AI answer (claim) it is meant to fix.
-- When such a change is published, the fix is recorded on that issue and a
-- re-check is queued, so the before/after comparison follows on its own.
-- Optional: changes made for other reasons carry no claim.
ALTER TABLE wordpress_changes ADD COLUMN IF NOT EXISTS claim_id UUID NULL REFERENCES candidate_claims(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS wordpress_changes_claim ON wordpress_changes(claim_id) WHERE claim_id IS NOT NULL;
