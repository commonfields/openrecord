-- Market research evidence: what the agent observed through an external
-- research source, kept so a later chat can cite it without paying for it
-- again. One row is one provider read for one business: what was asked and
-- why, when it was observed, what came back (normalized and size-bounded),
-- how much of the subject it covers, what it cost and the provider's call id.
-- Rows are evidence about the outside world as a provider reported it, not
-- approved truth and not OpenRecord's own measurements.
--
-- request_key is server-derived from the business, source, operation,
-- normalized parameters and UTC day, so a retried or resumed run reuses the
-- row instead of calling (and paying) twice. A PENDING row reserves its cost
-- ceiling against the business's daily research budget until it settles.
CREATE TABLE IF NOT EXISTS research_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  source TEXT NOT NULL CHECK (source IN ('RESEARCH_GATEWAY', 'AI_VISIBILITY')),
  operation TEXT NOT NULL CHECK (operation ~ '^[a-z_]{2,40}$'),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 600),
  params JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'OBSERVED', 'NO_DATA', 'FAILED')),
  failure TEXT NULL CHECK (failure IS NULL OR failure ~ '^[A-Z_]{2,40}$'),
  findings JSONB NULL,
  coverage JSONB NULL,
  reserved_micro BIGINT NOT NULL DEFAULT 0 CHECK (reserved_micro >= 0),
  cost_micro BIGINT NOT NULL DEFAULT 0 CHECK (cost_micro >= 0),
  provider_call_id TEXT NULL CHECK (provider_call_id IS NULL OR length(provider_call_id) <= 120),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  observed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, request_key),
  CHECK ((status = 'PENDING') = (observed_at IS NULL)),
  CHECK (status = 'PENDING' OR reserved_micro = 0)
);
CREATE INDEX IF NOT EXISTS research_observations_recent ON research_observations(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_observations_subject ON research_observations(business_id, subject, created_at DESC);

-- A business's read-only connection to an external AI-visibility project.
-- Only a project-scoped, read-only key is accepted; it is stored encrypted,
-- bound to this business, and never returned, logged or shown to the model.
CREATE TABLE IF NOT EXISTS ai_visibility_connections (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 100),
  project_name TEXT NOT NULL CHECK (length(project_name) BETWEEN 1 AND 200),
  key_ciphertext TEXT NULL,
  key_hint TEXT NOT NULL CHECK (key_hint ~ '^[A-Za-z0-9_-]{0,4}$'),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  connected_by_user_id UUID NOT NULL REFERENCES users(id),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ NULL,
  CHECK ((status = 'ACTIVE') = (key_ciphertext IS NOT NULL AND revoked_at IS NULL))
);
