-- Revenue: a business's Stripe account, read with a restricted key the
-- business creates with read-only permissions. Full secret keys (sk_) are
-- refused before anything is stored, so OpenRecord can never move money,
-- refund or change a customer. The key is AES-256-GCM ciphertext bound to the
-- row (see packages/ga4/src/cipher.ts); only its last four characters are
-- kept in clear, to show which key is connected. One active Stripe account
-- per business. Revenue is read live and not stored.
--
-- Additive and replay-safe.
CREATE TABLE IF NOT EXISTS revenue_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('stripe')),
  external_account TEXT NULL CHECK (external_account IS NULL OR external_account ~ '^acct_[A-Za-z0-9]{1,40}$'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  livemode BOOLEAN NOT NULL,
  key_ciphertext TEXT NULL,
  key_last4 TEXT NOT NULL CHECK (key_last4 ~ '^[A-Za-z0-9]{4}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED','DISCONNECTED')),
  connected_by_user_id UUID NOT NULL REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ NULL,
  CHECK ((status = 'DISCONNECTED') = (key_ciphertext IS NULL)),
  CHECK ((status = 'DISCONNECTED') = (disconnected_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS revenue_connections_active ON revenue_connections(business_id, provider) WHERE status <> 'DISCONNECTED';
