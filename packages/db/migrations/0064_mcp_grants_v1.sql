-- MCP grants: a revocable bearer token that lets an outside agent (a coding
-- agent, a desktop assistant, a hosted agent) call OpenRecord's tools for
-- exactly one business, as the person who created it, with the permissions
-- named here. Only the token's SHA-256 is stored; the token is shown once.
-- The business comes from the grant, never from tool input.
CREATE TABLE IF NOT EXISTS mcp_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  permissions TEXT[] NOT NULL CHECK (cardinality(permissions) BETWEEN 1 AND 10
    AND permissions <@ ARRAY['business:read', 'evidence:read', 'work:read', 'work:propose', 'results:read', 'research:run']::text[]),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  token_hint TEXT NOT NULL CHECK (token_hint ~ '^[A-Za-z0-9_-]{4}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  last_used_at TIMESTAMPTZ NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS mcp_grants_business ON mcp_grants(business_id, created_at DESC);
