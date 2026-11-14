-- One-use, short-lived bridge from a signed-in desktop to system OAuth.
-- The browser gets only a callback capability, never an application session.
CREATE TABLE IF NOT EXISTS desktop_oauth_handoffs (
  token_sha256 TEXT PRIMARY KEY CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state_sha256 TEXT NOT NULL UNIQUE CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
  callback_path TEXT NOT NULL CHECK (callback_path IN ('/api/growth/ga4/oauth/callback', '/api/ads/oauth/callback')),
  authorization_ciphertext TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
  started_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);
