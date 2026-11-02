-- Account actions: one exact change to a business's own Google Business
-- Profile or Google Ads account, prepared by the agent or a person, approved
-- by a person, then carried out once by OpenRecord and read back.
--
-- Each row keeps:
--   * the target as it was when the change was prepared (before), so a
--     review answered or a campaign changed since then is refused at
--     approval, not overwritten;
--   * the exact new values the person approves (after);
--   * what the platform returned and what OpenRecord read back (result),
--     so "done" means the platform holds the approved values;
--   * enough to undo it: the previous reply, status or budget, or the
--     resource name of a new ad to remove.
-- New ads are created paused. Nothing here runs without that approval, and
-- every change is attributed to the person who approved it.
CREATE TABLE IF NOT EXISTS account_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  binding_id UUID NOT NULL REFERENCES ad_account_bindings(id),
  provider TEXT NOT NULL CHECK (provider IN ('google_business', 'google_ads')),
  kind TEXT NOT NULL CHECK (kind IN ('REPLY_TO_REVIEW', 'PAUSE_CAMPAIGN', 'ENABLE_CAMPAIGN', 'SET_DAILY_BUDGET', 'CREATE_SEARCH_AD')),
  target JSONB NOT NULL CHECK (jsonb_typeof(target) = 'object' AND octet_length(target::text) <= 20000),
  before_values JSONB NOT NULL CHECK (jsonb_typeof(before_values) = 'object' AND octet_length(before_values::text) <= 20000),
  after_values JSONB NOT NULL CHECK (jsonb_typeof(after_values) = 'object' AND octet_length(after_values::text) <= 20000),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'EXECUTING', 'DONE', 'REJECTED', 'FAILED', 'UNDONE')),
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('ASSISTANT', 'OPERATOR')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  decided_by_user_id UUID NULL REFERENCES users(id),
  decided_at TIMESTAMPTZ NULL,
  result JSONB NULL CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 20000)),
  failure TEXT NULL CHECK (failure IS NULL OR length(failure) <= 120),
  undone_by_user_id UUID NULL REFERENCES users(id),
  undone_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, request_key),
  CHECK ((provider = 'google_business') = (kind = 'REPLY_TO_REVIEW'))
);
CREATE INDEX IF NOT EXISTS account_actions_recent ON account_actions(business_id, created_at DESC);
