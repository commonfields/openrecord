-- Webflow: a business connects one site with a site API token (issued in the
-- site's settings, revocable there), stored as AES-256-GCM ciphertext bound to
-- the connection; only its last four characters stay in clear.
--
-- A Webflow change is prepared by the agent or a person, approved by a person,
-- then published by OpenRecord through Webflow's Data API. It keeps:
--   * the target as it was when the change was prepared (its last-updated
--     time), so a page or item edited in Webflow since then is refused, not
--     overwritten;
--   * the exact new values, which the person approves;
--   * the previous values, so the change can be undone in one click.
-- Publishing is attributed to the person who approved it. Nothing here
-- publishes without that approval.
CREATE TABLE IF NOT EXISTS webflow_connections (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL CHECK (site_id ~ '^[0-9a-f]{24}$'),
  site_name TEXT NOT NULL CHECK (length(site_name) <= 200),
  -- The public address pages are checked at: the first custom domain, else the webflow.io one.
  site_url TEXT NOT NULL CHECK (site_url ~ '^https://[^[:space:]/]+$' AND length(site_url) <= 300),
  -- Custom domain IDs a site publish goes to (with the webflow.io subdomain).
  domain_ids JSONB NOT NULL CHECK (jsonb_typeof(domain_ids) = 'array' AND jsonb_array_length(domain_ids) <= 20),
  token_ciphertext TEXT NULL,
  token_last4 TEXT NOT NULL CHECK (length(token_last4) = 4),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'DISCONNECTED')),
  connected_by_user_id UUID NOT NULL REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'DISCONNECTED') = (token_ciphertext IS NULL))
);

CREATE TABLE IF NOT EXISTS webflow_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('SET_PAGE_SEO', 'UPDATE_CMS_ITEM', 'CREATE_CMS_ITEM')),
  page_id TEXT NULL CHECK (page_id IS NULL OR page_id ~ '^[0-9a-f]{24}$'),
  collection_id TEXT NULL CHECK (collection_id IS NULL OR collection_id ~ '^[0-9a-f]{24}$'),
  item_id TEXT NULL CHECK (item_id IS NULL OR item_id ~ '^[0-9a-f]{24}$'),
  target_title TEXT NOT NULL CHECK (length(target_title) <= 300),
  target_link TEXT NULL CHECK (target_link IS NULL OR length(target_link) <= 2000),
  target_updated TEXT NULL CHECK (target_updated IS NULL OR length(target_updated) <= 40),
  before_values JSONB NOT NULL CHECK (jsonb_typeof(before_values) = 'object' AND octet_length(before_values::text) <= 400000),
  after_values JSONB NOT NULL CHECK (jsonb_typeof(after_values) = 'object' AND octet_length(after_values::text) <= 400000),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'FAILED', 'UNDONE')),
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('ASSISTANT', 'OPERATOR')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  decided_by_user_id UUID NULL REFERENCES users(id),
  decided_at TIMESTAMPTZ NULL,
  published_at TIMESTAMPTZ NULL,
  published_item_id TEXT NULL CHECK (published_item_id IS NULL OR published_item_id ~ '^[0-9a-f]{24}$'),
  published_link TEXT NULL CHECK (published_link IS NULL OR length(published_link) <= 2000),
  failure TEXT NULL CHECK (failure IS NULL OR length(failure) <= 120),
  live_check JSONB NULL,
  objective_goal_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, request_key),
  -- A composite key: a change can only name a goal of its own business.
  FOREIGN KEY (objective_goal_id, business_id) REFERENCES growth_goals(id, business_id),
  CHECK ((kind = 'SET_PAGE_SEO') = (page_id IS NOT NULL)),
  CHECK ((kind = 'SET_PAGE_SEO') = (collection_id IS NULL)),
  CHECK ((kind = 'UPDATE_CMS_ITEM') = (item_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS webflow_changes_recent ON webflow_changes(business_id, created_at DESC);
