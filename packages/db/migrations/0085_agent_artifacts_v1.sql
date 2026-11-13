-- Artifacts: finished pieces of marketing work the agent (or the team) writes
-- for one business, such as a landing page, an article, an email, ad copy or
-- a brief. An artifact is a document the team reads, edits and ships; it is
-- never evidence, an approval or proof that anything was published.
--
-- Every save is a new version and earlier versions are kept, so an edit can
-- be compared and undone. agent_artifacts carries the current version's
-- title and number; agent_artifact_versions holds each version's content.
CREATE TABLE IF NOT EXISTS agent_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('LANDING_PAGE', 'ARTICLE', 'EMAIL', 'AD_COPY', 'SOCIAL_POST', 'BRIEF', 'REPORT', 'OTHER')),
  format TEXT NOT NULL CHECK (format IN ('HTML', 'MARKDOWN')),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS agent_artifacts_recent ON agent_artifacts(business_id, updated_at DESC) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_artifact_versions (
  artifact_id UUID NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 200000),
  content_digest TEXT NOT NULL CHECK (content_digest ~ '^[a-f0-9]{64}$'),
  note TEXT NULL CHECK (note IS NULL OR length(note) <= 300),
  source TEXT NOT NULL CHECK (source IN ('ASSISTANT', 'OPERATOR')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (artifact_id, version)
);

-- A preview link for someone without an account. Only the token's digest is
-- stored; the link shows the artifact's current version until it expires.
CREATE TABLE IF NOT EXISTS agent_artifact_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id UUID NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
