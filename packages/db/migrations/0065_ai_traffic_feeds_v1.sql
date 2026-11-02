-- Live AI crawler and AI referral traffic: a business's host sends its
-- access logs continuously (a log drain) to a feed URL with a secret token.
-- Only daily aggregates are kept, per crawler or assistant and page: no IP
-- address, raw line, query string or user identifier. Only the token's
-- SHA-256 is stored; the token is shown once. Revoking stops ingestion.
CREATE TABLE IF NOT EXISTS ai_traffic_feeds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  token_hint TEXT NOT NULL CHECK (token_hint ~ '^[A-Za-z0-9_-]{4}$'),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  last_received_at TIMESTAMPTZ NULL,
  records_received BIGINT NOT NULL DEFAULT 0 CHECK (records_received >= 0),
  records_unrecognized BIGINT NOT NULL DEFAULT 0 CHECK (records_unrecognized >= 0)
);
CREATE INDEX IF NOT EXISTS ai_traffic_feeds_business ON ai_traffic_feeds(business_id, created_at DESC);

-- One row per business, day, event kind, agent and page. CRAWLER rows count
-- requests made by an AI crawler or assistant fetcher (name = the agent);
-- REFERRAL rows count visits that arrived from an AI assistant (name = the
-- assistant). The two are different events and are never added together.
CREATE TABLE IF NOT EXISTS ai_traffic_daily (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('CRAWLER', 'REFERRAL')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 300),
  requests BIGINT NOT NULL DEFAULT 0 CHECK (requests >= 0),
  ok BIGINT NOT NULL DEFAULT 0 CHECK (ok >= 0),
  blocked BIGINT NOT NULL DEFAULT 0 CHECK (blocked >= 0),
  PRIMARY KEY (business_id, day, event, name, path)
);
