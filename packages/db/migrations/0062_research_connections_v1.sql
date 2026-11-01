-- Research data connections: a business's own account with a data provider,
-- used only by OpenRecord's research endpoint catalog for read-only calls.
-- One row per business and provider. The credential (an API key, a token, or
-- a client id and secret) is stored encrypted, bound to the business and the
-- provider, and never returned, logged or shown to the model. Revoking clears
-- it. Nothing is connected unless a person on the business's team adds it.
CREATE TABLE IF NOT EXISTS research_connections (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  credential_ciphertext TEXT NULL,
  credential_hint TEXT NOT NULL CHECK (credential_hint ~ '^[A-Za-z0-9_-]{0,4}$'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  connected_by_user_id UUID NOT NULL REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  PRIMARY KEY (business_id, provider),
  CHECK ((status = 'ACTIVE') = (credential_ciphertext IS NOT NULL AND revoked_at IS NULL))
);
