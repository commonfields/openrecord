-- No provider tokens are persisted. One installation belongs to one tenant.
CREATE TABLE IF NOT EXISTS github_installations (
  installation_id TEXT PRIMARY KEY CHECK (installation_id ~ '^[1-9][0-9]{0,15}$'),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  login TEXT NOT NULL,
  connected_by_user_id UUID NOT NULL REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  UNIQUE (installation_id, account_id)
);
CREATE TABLE IF NOT EXISTS github_installation_repositories (
  installation_id TEXT NOT NULL,
  account_id UUID NOT NULL,
  repository_id TEXT NOT NULL CHECK (repository_id ~ '^[1-9][0-9]{0,15}$'),
  full_name TEXT NOT NULL,
  PRIMARY KEY (installation_id, repository_id),
  FOREIGN KEY (installation_id, account_id) REFERENCES github_installations(installation_id, account_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS github_repositories_account ON github_installation_repositories(account_id, lower(full_name));
CREATE TABLE IF NOT EXISTS github_install_states (
  state_sha256 TEXT PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
  consumed_at TIMESTAMPTZ
);
ALTER TABLE desktop_oauth_handoffs DROP CONSTRAINT IF EXISTS desktop_oauth_handoffs_callback_path_check;
ALTER TABLE desktop_oauth_handoffs ADD CONSTRAINT desktop_oauth_handoffs_callback_path_check
  CHECK (callback_path IN ('/api/growth/ga4/oauth/callback', '/api/ads/oauth/callback', '/api/github/callback'));
