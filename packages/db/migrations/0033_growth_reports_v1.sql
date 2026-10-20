-- W5: immutable, versioned client reports of one W4 outcome evaluation, and
-- revocable view-only share links per report version. A report row stores the
-- canonical snapshot text verbatim; the database recomputes its SHA-256,
-- binds the JSON identity to the row's business, initiative, version, status
-- and publication time, and keeps a linear version chain. Rows are
-- append-only: a correction is a new version, never an edit. Replay-safe
-- (every statement is idempotent); never depends on the preserved old 0031.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='growth_measurement_plans') THEN
    RAISE EXCEPTION 'W5 requires the W3 measurement tables; run 0032 before 0033';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='growth_opportunity_events' AND column_name='delivery_id') THEN
    RAISE EXCEPTION 'old 0031 delivery artifacts detected; the preserved 0031 must never be replayed over new W0/W3/W5';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS growth_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES record_profiles(business_id),
  opportunity_id UUID NOT NULL,
  version INT NOT NULL CHECK (version >= 1),
  supersedes_id UUID,
  CHECK ((version = 1) = (supersedes_id IS NULL)),
  evaluation_status TEXT NOT NULL CHECK (evaluation_status IN ('COMPARABLE','INDETERMINATE')),
  snapshot_text TEXT NOT NULL CHECK (length(snapshot_text) <= 4000000),
  snapshot_digest TEXT NOT NULL CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  evidence_digest TEXT NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  published_by_user_id UUID NOT NULL REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL,
  request_key UUID NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  UNIQUE (id, business_id),
  UNIQUE (opportunity_id, version),
  UNIQUE (business_id, request_key),
  FOREIGN KEY (opportunity_id, business_id) REFERENCES growth_opportunities(id, business_id),
  FOREIGN KEY (supersedes_id, business_id) REFERENCES growth_reports(id, business_id)
);
CREATE INDEX IF NOT EXISTS growth_reports_business ON growth_reports(business_id, opportunity_id, version DESC);

CREATE TABLE IF NOT EXISTS growth_report_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id UUID NOT NULL,
  business_id UUID NOT NULL,
  -- 32 random bytes, base64url without padding (256 bits), as record_shares.
  public_id TEXT NOT NULL UNIQUE CHECK (public_id ~ '^[A-Za-z0-9_-]{43}$'),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REVOKED')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by_user_id UUID REFERENCES users(id),
  revoked_at TIMESTAMPTZ,
  CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL)),
  FOREIGN KEY (report_id, business_id) REFERENCES growth_reports(id, business_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS growth_report_shares_active ON growth_report_shares(report_id) WHERE status = 'ACTIVE';

-- The stored text is the evidence: its digest, identity, version chain and
-- publication time are checked here so a direct SQL write fails closed too.
CREATE OR REPLACE FUNCTION guard_growth_report() RETURNS trigger AS $$
DECLARE doc JSONB; latest growth_reports;
BEGIN
  IF NOT record_member(NEW.business_id, NEW.published_by_user_id) THEN RAISE EXCEPTION 'report outside scope'; END IF;
  IF NEW.snapshot_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.snapshot_text, 'UTF8')), 'hex') THEN RAISE EXCEPTION 'report digest mismatch'; END IF;
  doc := NEW.snapshot_text::jsonb;
  IF doc->>'schema' IS DISTINCT FROM 'openrecord.growth-report/v1'
    OR doc->'business'->>'id' IS DISTINCT FROM NEW.business_id::text
    OR doc->'initiative'->>'id' IS DISTINCT FROM NEW.opportunity_id::text
    OR doc->'evaluation'->>'opportunityId' IS DISTINCT FROM NEW.opportunity_id::text
    OR doc->'evaluation'->>'businessId' IS DISTINCT FROM NEW.business_id::text
    OR doc->'evaluation'->>'status' IS DISTINCT FROM NEW.evaluation_status
    OR (doc->'publication'->>'version')::int IS DISTINCT FROM NEW.version
    OR doc->'publication'->>'supersedesReportId' IS DISTINCT FROM NEW.supersedes_id::text
    OR (doc->'publication'->>'publishedAt')::timestamptz IS DISTINCT FROM NEW.published_at THEN
    RAISE EXCEPTION 'report identity mismatch';
  END IF;
  -- Publication time is the transaction's own clock (millisecond precision, as serialized).
  IF date_trunc('milliseconds', NEW.published_at) IS DISTINCT FROM date_trunc('milliseconds', now()) THEN RAISE EXCEPTION 'report publication time mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM growth_opportunity_events e WHERE e.opportunity_id=NEW.opportunity_id AND e.business_id=NEW.business_id AND e.status='APPROVED') THEN
    RAISE EXCEPTION 'report requires an approved initiative';
  END IF;
  -- Linear chain: each version supersedes exactly the previous one.
  PERFORM 1 FROM growth_opportunities WHERE id=NEW.opportunity_id AND business_id=NEW.business_id FOR UPDATE;
  SELECT * INTO latest FROM growth_reports WHERE opportunity_id=NEW.opportunity_id AND business_id=NEW.business_id ORDER BY version DESC LIMIT 1;
  IF NEW.version IS DISTINCT FROM COALESCE(latest.version, 0) + 1 OR NEW.supersedes_id IS DISTINCT FROM latest.id THEN
    RAISE EXCEPTION 'report version chain mismatch';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_report_guard ON growth_reports;
CREATE TRIGGER growth_report_guard BEFORE INSERT ON growth_reports FOR EACH ROW EXECUTE FUNCTION guard_growth_report();
DROP TRIGGER IF EXISTS growth_report_append_only ON growth_reports;
CREATE TRIGGER growth_report_append_only BEFORE UPDATE OR DELETE ON growth_reports FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS growth_report_no_truncate ON growth_reports;
CREATE TRIGGER growth_report_no_truncate BEFORE TRUNCATE ON growth_reports EXECUTE FUNCTION prevent_append_only_mutation();

-- Only ACTIVE -> REVOKED, once, by an account user, at server time (as record_shares).
CREATE OR REPLACE FUNCTION guard_growth_report_share() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'report shares are retained'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'ACTIVE' OR NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'report shares start ACTIVE and are created by an account user'; END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'ACTIVE' OR NEW.status <> 'REVOKED'
    OR ROW(NEW.id, NEW.report_id, NEW.business_id, NEW.public_id, NEW.created_by_user_id, NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id, OLD.report_id, OLD.business_id, OLD.public_id, OLD.created_by_user_id, OLD.created_at)
    OR NOT record_member(NEW.business_id, NEW.revoked_by_user_id) THEN
    RAISE EXCEPTION 'a report share can only be revoked once, by an account user';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_report_share_guard ON growth_report_shares;
CREATE TRIGGER growth_report_share_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_report_shares FOR EACH ROW EXECUTE FUNCTION guard_growth_report_share();
DROP TRIGGER IF EXISTS growth_report_share_no_truncate ON growth_report_shares;
CREATE TRIGGER growth_report_share_no_truncate BEFORE TRUNCATE ON growth_report_shares EXECUTE FUNCTION prevent_append_only_mutation();
