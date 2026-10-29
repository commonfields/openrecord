-- Read-only connections to the client's ad accounts on Meta and Google Ads.
--
-- ad_connections: one person's sign-in on one platform, owned by the
-- OpenRecord account. Tokens are AES-256-GCM ciphertext bound to the row and
-- purpose (see packages/ga4/src/cipher.ts); a disconnected connection keeps
-- no ciphertext. Meta issues no refresh token, so a Meta connection asks for
-- a new sign-in once its long-lived token expires.
-- ad_oauth_states: single-use, ten-minute sign-in state, bound to the user
-- and the business they started from.
-- ad_account_bindings: which ad account belongs to which business. Append-only
-- history: ending one sets ended_at, a new one is a new row. Performance is
-- read live from the platform and not stored.
--
-- Additive and replay-safe.

CREATE TABLE IF NOT EXISTS ad_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta','google_ads')),
  subject TEXT NOT NULL CHECK (subject ~ '^[0-9]{1,30}$'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REAUTHORIZATION_REQUIRED','DISCONNECTED')),
  granted_scopes TEXT[] NOT NULL DEFAULT '{}',
  access_ciphertext TEXT NULL,
  access_expires_at TIMESTAMPTZ NULL,
  refresh_ciphertext TEXT NULL,
  connected_by_user_id UUID NOT NULL REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ NULL,
  CHECK (status <> 'DISCONNECTED' OR (access_ciphertext IS NULL AND refresh_ciphertext IS NULL AND disconnected_at IS NOT NULL)),
  -- Read access only: Meta's ads_read; Google's one Ads scope, used here only to read.
  CHECK (provider <> 'meta' OR (granted_scopes <@ ARRAY['ads_read','public_profile','email'] AND 'ads_read' = ANY(granted_scopes))),
  CHECK (provider <> 'google_ads' OR (granted_scopes <@ ARRAY['openid','email','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/adwords']
    AND 'https://www.googleapis.com/auth/adwords' = ANY(granted_scopes)))
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_connections_identity ON ad_connections(account_id, provider, subject) WHERE status <> 'DISCONNECTED';

CREATE TABLE IF NOT EXISTS ad_oauth_states (
  state_sha256 TEXT PRIMARY KEY CHECK (state_sha256 ~ '^[0-9a-f]{64}$'),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta','google_ads')),
  verifier_ciphertext TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS ad_account_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES ad_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta','google_ads')),
  external_id TEXT NOT NULL CHECK (external_id ~ '^[0-9]{1,20}$'),
  login_customer_id TEXT NULL CHECK (login_customer_id IS NULL OR login_customer_id ~ '^[0-9]{1,20}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  currency TEXT NULL CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  bound_by_user_id UUID NOT NULL REFERENCES users(id),
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ NULL,
  ended_by_user_id UUID NULL REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ad_account_bindings_active ON ad_account_bindings(business_id, provider, external_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS ad_account_bindings_business ON ad_account_bindings(business_id) WHERE ended_at IS NULL;
