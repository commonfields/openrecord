-- WordPress: a business connects its site with an application password (a
-- revocable per-app credential WordPress issues for its REST API), stored as
-- AES-256-GCM ciphertext bound to the connection; only its last four
-- characters stay in clear, to show which one is connected.
--
-- A WordPress change is prepared by the agent or a person, approved by a
-- person, then published through the REST API by OpenRecord. It keeps:
--   * the target as it was when the change was prepared (its modified time),
--     so a page edited in WordPress since then is refused, not overwritten;
--   * the exact new values, which the person approves;
--   * the previous values, so the change can be undone in one click.
-- Publishing is attributed to the person who approved it. Nothing here
-- publishes without that approval.
CREATE TABLE IF NOT EXISTS wordpress_connections (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  site_url TEXT NOT NULL CHECK (site_url ~ '^https://[^[:space:]/]+(/[^[:space:]]*)?$' AND length(site_url) <= 300),
  username TEXT NOT NULL CHECK (length(trim(username)) BETWEEN 1 AND 100),
  password_ciphertext TEXT NULL,
  password_last4 TEXT NOT NULL CHECK (length(password_last4) = 4),
  seo_plugin TEXT NOT NULL CHECK (seo_plugin IN ('YOAST', 'RANK_MATH', 'NONE')),
  can_publish BOOLEAN NOT NULL,
  can_add_scripts BOOLEAN NOT NULL,
  site_name TEXT NOT NULL CHECK (length(site_name) <= 200),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'DISCONNECTED')),
  connected_by_user_id UUID NOT NULL REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'DISCONNECTED') = (password_ciphertext IS NULL))
);

CREATE TABLE IF NOT EXISTS wordpress_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('UPDATE_COPY', 'SET_SEO', 'ADD_FAQ', 'CREATE_POST')),
  post_type TEXT NOT NULL CHECK (post_type IN ('posts', 'pages')),
  post_id BIGINT NULL CHECK (post_id IS NULL OR post_id > 0),
  target_title TEXT NOT NULL CHECK (length(target_title) <= 300),
  target_link TEXT NULL CHECK (target_link IS NULL OR length(target_link) <= 2000),
  target_modified TEXT NULL CHECK (target_modified IS NULL OR length(target_modified) <= 40),
  before_values JSONB NOT NULL CHECK (jsonb_typeof(before_values) = 'object' AND octet_length(before_values::text) <= 400000),
  after_values JSONB NOT NULL CHECK (jsonb_typeof(after_values) = 'object' AND octet_length(after_values::text) <= 400000),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
  status TEXT NOT NULL CHECK (status IN ('PROPOSED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'FAILED', 'UNDONE')),
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('ASSISTANT', 'OPERATOR')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  decided_by_user_id UUID NULL REFERENCES users(id),
  decided_at TIMESTAMPTZ NULL,
  published_post_id BIGINT NULL,
  published_link TEXT NULL CHECK (published_link IS NULL OR length(published_link) <= 2000),
  failure TEXT NULL CHECK (failure IS NULL OR length(failure) <= 120),
  live_check JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, request_key),
  CHECK ((kind = 'CREATE_POST') = (post_id IS NULL))
);
CREATE INDEX IF NOT EXISTS wordpress_changes_recent ON wordpress_changes(business_id, created_at DESC);
