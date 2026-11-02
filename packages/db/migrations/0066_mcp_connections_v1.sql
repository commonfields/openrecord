-- Outside MCP servers a business's team connects so OpenRecord's agent can
-- use their read-only tools. The server address must be public https. The
-- optional credential (a bearer token) is stored encrypted, bound to the
-- business and the connection, and never returned, logged or shown to the
-- model. Revoking clears it.
CREATE TABLE IF NOT EXISTS mcp_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  url TEXT NOT NULL CHECK (url ~ '^https://' AND length(url) <= 500),
  credential_ciphertext TEXT NULL,
  credential_hint TEXT NULL CHECK (credential_hint IS NULL OR credential_hint ~ '^[A-Za-z0-9_-]{0,4}$'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
  CHECK (status = 'ACTIVE' OR credential_ciphertext IS NULL)
);
CREATE INDEX IF NOT EXISTS mcp_connections_business ON mcp_connections(business_id, created_at DESC);
