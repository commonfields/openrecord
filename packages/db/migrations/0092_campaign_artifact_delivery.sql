-- Exact artifacts are campaign work; notes and task completion remain assertions.
CREATE TABLE IF NOT EXISTS campaign_artifact_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  campaign_id UUID NOT NULL,
  campaign_revision INTEGER NOT NULL,
  task_id UUID NOT NULL,
  artifact_id UUID NOT NULL,
  artifact_version INTEGER NOT NULL,
  content_digest TEXT NOT NULL CHECK(content_digest ~ '^[a-f0-9]{64}$'),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,campaign_id) REFERENCES marketing_campaigns(business_id,id),
  FOREIGN KEY (campaign_id,campaign_revision) REFERENCES marketing_campaign_revisions(campaign_id,revision),
  FOREIGN KEY (artifact_id,artifact_version) REFERENCES agent_artifact_versions(artifact_id,version),
  UNIQUE(campaign_id,campaign_revision,task_id,artifact_id,artifact_version)
);
CREATE TABLE IF NOT EXISTS campaign_publications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  binding_id UUID NOT NULL UNIQUE REFERENCES campaign_artifact_bindings(id),
  page_token TEXT NOT NULL UNIQUE CHECK(page_token ~ '^[A-Za-z0-9_-]{43}$'),
  status TEXT NOT NULL DEFAULT 'PREPARED' CHECK(status IN ('PREPARED','PUBLISHED','REJECTED','WITHDRAWN')),
  destination TEXT NOT NULL,
  cta_label TEXT NOT NULL CHECK(length(cta_label) BETWEEN 1 AND 120),
  privacy_notice TEXT NOT NULL CHECK(length(privacy_notice) BETWEEN 1 AND 1000),
  metric TEXT NOT NULL DEFAULT 'INQUIRY_SUBMITTED' CHECK(metric='INQUIRY_SUBMITTED'),
  prepared_by_user_id UUID NOT NULL REFERENCES users(id),
  prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by_user_id UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS campaign_form_tickets (
  token_digest TEXT PRIMARY KEY,
  publication_id UUID NOT NULL REFERENCES campaign_publications(id),
  purpose TEXT NOT NULL CHECK(purpose IN ('TEST','PRODUCTION')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '15 minutes',
  consumed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS campaign_tickets_publication ON campaign_form_tickets(publication_id,created_at);
CREATE TABLE IF NOT EXISTS campaign_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  publication_id UUID NOT NULL REFERENCES campaign_publications(id),
  ticket_digest TEXT NOT NULL UNIQUE REFERENCES campaign_form_tickets(token_digest),
  purpose TEXT NOT NULL CHECK(purpose IN ('TEST','PRODUCTION')),
  contact_ciphertext TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  CHECK ((purpose='TEST' AND contact_ciphertext IS NULL) OR (purpose='PRODUCTION' AND contact_ciphertext IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS campaign_inquiries_publication ON campaign_inquiries(publication_id,created_at);

CREATE OR REPLACE FUNCTION guard_campaign_artifact_binding() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM marketing_campaigns c JOIN businesses b ON b.id=c.business_id
    JOIN agent_artifacts a ON a.id=NEW.artifact_id AND a.business_id=b.id AND a.account_id=b.account_id
    JOIN agent_artifact_versions v ON v.artifact_id=a.id AND v.version=NEW.artifact_version
    JOIN account_users u ON u.account_id=b.account_id AND u.user_id=NEW.created_by_user_id
    WHERE c.id=NEW.campaign_id AND c.business_id=NEW.business_id AND c.revision=NEW.campaign_revision
      AND a.archived_at IS NULL AND a.version=NEW.artifact_version AND v.content_digest=NEW.content_digest
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.brief->'tasks') t WHERE t->>'id'=NEW.task_id::text))
    THEN RAISE EXCEPTION 'campaign artifact binding scope or revision mismatch'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS campaign_artifact_binding_guard ON campaign_artifact_bindings;
CREATE TRIGGER campaign_artifact_binding_guard BEFORE INSERT ON campaign_artifact_bindings FOR EACH ROW EXECUTE FUNCTION guard_campaign_artifact_binding();

CREATE OR REPLACE FUNCTION immutable_campaign_artifact_binding() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'campaign artifact bindings are append-only'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS campaign_artifact_binding_immutable ON campaign_artifact_bindings;
CREATE TRIGGER campaign_artifact_binding_immutable BEFORE UPDATE OR DELETE ON campaign_artifact_bindings FOR EACH ROW EXECUTE FUNCTION immutable_campaign_artifact_binding();
ALTER TABLE campaign_inquiries ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ;
ALTER TABLE campaign_inquiries DROP CONSTRAINT IF EXISTS campaign_inquiries_check;
ALTER TABLE campaign_inquiries ADD CONSTRAINT campaign_inquiries_check CHECK (
  (purpose='TEST' AND contact_ciphertext IS NULL) OR
  (purpose='PRODUCTION' AND (contact_ciphertext IS NOT NULL OR purged_at IS NOT NULL)));
CREATE OR REPLACE FUNCTION guard_campaign_publication() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PREPARED' OR NOT EXISTS(SELECT 1 FROM campaign_artifact_bindings b JOIN businesses biz ON biz.id=b.business_id
      JOIN account_users u ON u.account_id=biz.account_id AND u.user_id=NEW.prepared_by_user_id
      WHERE b.id=NEW.binding_id AND b.business_id=NEW.business_id) THEN RAISE EXCEPTION 'publication scope mismatch'; END IF;
  ELSE
    IF (NEW.business_id,NEW.binding_id,NEW.page_token,NEW.destination,NEW.cta_label,NEW.privacy_notice,NEW.metric,NEW.prepared_by_user_id,NEW.prepared_at)
      IS DISTINCT FROM (OLD.business_id,OLD.binding_id,OLD.page_token,OLD.destination,OLD.cta_label,OLD.privacy_notice,OLD.metric,OLD.prepared_by_user_id,OLD.prepared_at)
      THEN RAISE EXCEPTION 'publication preparation is immutable'; END IF;
    IF NOT ((OLD.status='PREPARED' AND NEW.status IN ('PUBLISHED','REJECTED')) OR (OLD.status='PUBLISHED' AND NEW.status='WITHDRAWN'))
      THEN RAISE EXCEPTION 'invalid publication transition'; END IF;
    IF NEW.status='PUBLISHED' THEN
      IF NEW.published_at IS NULL OR NEW.decided_at IS NULL OR NOT EXISTS(
        SELECT 1 FROM campaign_artifact_bindings b JOIN agent_artifacts a ON a.id=b.artifact_id
        JOIN marketing_campaigns c ON c.id=b.campaign_id JOIN businesses biz ON biz.id=b.business_id
        JOIN account_users u ON u.account_id=biz.account_id AND u.user_id=NEW.decided_by_user_id
        WHERE b.id=NEW.binding_id AND a.version=b.artifact_version AND a.archived_at IS NULL AND c.revision=b.campaign_revision
          AND EXISTS(SELECT 1 FROM campaign_inquiries i WHERE i.publication_id=NEW.id AND i.purpose='TEST'))
        THEN RAISE EXCEPTION 'publication needs fresh scope, approval and tracking evidence'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS campaign_publication_guard ON campaign_publications;
CREATE TRIGGER campaign_publication_guard BEFORE INSERT OR UPDATE ON campaign_publications FOR EACH ROW EXECUTE FUNCTION guard_campaign_publication();
DO $$ BEGIN
  -- The migration runner replays migrations. Keep any later constraint.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='decision_feedback'::regclass
    AND conname='decision_feedback_kind_check' AND pg_get_constraintdef(oid) LIKE '%CAMPAIGN_REVIEW%') THEN
    RETURN;
  END IF;
  ALTER TABLE decision_feedback DROP CONSTRAINT IF EXISTS decision_feedback_kind_check;
  ALTER TABLE decision_feedback ADD CONSTRAINT decision_feedback_kind_check CHECK(kind IN ('CAMPAIGN_PUBLICATION','AGENT_PROPOSAL','AGENT_DRAFT','GROWTH_OPPORTUNITY','WORDPRESS_CHANGE','WEBFLOW_CHANGE','ACCOUNT_ACTION'));
END $$;
