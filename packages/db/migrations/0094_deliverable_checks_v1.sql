-- Checks on the exact artifact revision a campaign page would publish, run
-- when the page is prepared (apps/api/src/deliverable-checks.ts). A BLOCKING
-- finding refuses approval until a new revision fixes it; warnings are shown
-- on the approval card for the person to judge. One row per linked revision:
-- an edit makes a new link and so a new check.
CREATE TABLE IF NOT EXISTS campaign_deliverable_checks (
  binding_id UUID PRIMARY KEY REFERENCES campaign_artifact_bindings(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  findings JSONB NOT NULL CHECK (jsonb_typeof(findings) = 'array' AND jsonb_array_length(findings) <= 60),
  blocking INT NOT NULL CHECK (blocking >= 0),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
