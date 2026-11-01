-- Market research evidence: what OpenRecord's own research capabilities
-- observed for one business. One row is one observation: which capability ran
-- (operation), about what (subject), why (the question that justified it),
-- when, what came back (normalized and size-bounded), and how much of the
-- subject it covers. Sources are public websites and registries, OpenRecord's
-- own page snapshots, the business's own connected accounts and AI
-- subscriptions, or files the team uploads. Rows are evidence about the
-- outside world, not approved truth.
--
-- request_key is server-derived from the business, capability, normalized
-- input and UTC day, so a retried or resumed run reuses the row instead of
-- fetching again. A PENDING row marks a run in progress.
--
-- Migrations replay on every deploy: every statement below is safe to repeat,
-- and the guarded block converts databases created by the first version of
-- this file (which relied on outside services) to the native shape.
CREATE TABLE IF NOT EXISTS research_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  source TEXT NOT NULL,
  operation TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 300),
  question TEXT NOT NULL CHECK (length(question) BETWEEN 1 AND 600),
  params JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'OBSERVED', 'NO_DATA', 'FAILED')),
  failure TEXT NULL CHECK (failure IS NULL OR failure ~ '^[A-Z_]{2,40}$'),
  findings JSONB NULL,
  coverage JSONB NULL,
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  observed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, request_key),
  CHECK ((status = 'PENDING') = (observed_at IS NULL))
);

DO $$
BEGIN
  -- Rows from the first version came only from test fixtures of outside services.
  DELETE FROM research_observations WHERE source IN ('RESEARCH_GATEWAY', 'AI_VISIBILITY');
  ALTER TABLE research_observations DROP COLUMN IF EXISTS reserved_micro;
  ALTER TABLE research_observations DROP COLUMN IF EXISTS cost_micro;
  ALTER TABLE research_observations DROP COLUMN IF EXISTS provider_call_id;
  ALTER TABLE research_observations DROP CONSTRAINT IF EXISTS research_observations_source_check;
  ALTER TABLE research_observations ADD CONSTRAINT research_observations_source_check CHECK (source IN (
    'PUBLIC_WEB', 'PUBLIC_ARCHIVE', 'PUBLIC_REGISTRY', 'PUBLIC_FEED', 'OPENRECORD_SNAPSHOT',
    'CONNECTED_ACCOUNT', 'AI_SUBSCRIPTION', 'TEAM_UPLOAD', 'DERIVED'));
  ALTER TABLE research_observations DROP CONSTRAINT IF EXISTS research_observations_operation_check;
  ALTER TABLE research_observations ADD CONSTRAINT research_observations_operation_check CHECK (operation ~ '^[a-z][a-z0-9_.]{1,59}$');
END $$;

CREATE INDEX IF NOT EXISTS research_observations_recent ON research_observations(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS research_observations_subject ON research_observations(business_id, subject, created_at DESC);
CREATE INDEX IF NOT EXISTS research_observations_operation ON research_observations(business_id, operation, created_at DESC);

-- The first version stored keys for an outside service here; OpenRecord no longer uses one.
DROP TABLE IF EXISTS ai_visibility_connections;
