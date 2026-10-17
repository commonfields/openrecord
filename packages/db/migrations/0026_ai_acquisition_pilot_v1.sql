-- 0026_ai_acquisition_pilot_v1.sql — OPENRECORD_AI_ACQUISITION_PILOT_V1.
--
-- Record Integrity asks "does the AI answer agree with an approved fact?".
-- AI Acquisition asks "does the AI recommend this business when a buyer asks
-- for a product or service, what does it cite, and what referral evidence
-- exists?". The two loops share evidence (check_runs, observations,
-- raw_evidence, observation_citations) and nothing else: no MATCHES /
-- CONTRADICTS, no record slots, no change to the three-fact record limit.
--
--   acq_question_sets    a frozen, versioned buyer-question set plus the brand
--                        configuration it measures (target brand, aliases,
--                        owned domains, named competitors). Write-once.
--   acq_questions        one frozen buyer question per row (key, intent group,
--                        position) pointing at its buyer_questions prompt.
--                        Only insertable in the transaction that created the set.
--   acq_batches          one measurement batch: set, scope, sampling policy,
--                        provider/model, and the provider-call ceiling the
--                        operator acknowledged before any check was queued.
--   check_runs.acq_*     binds an ordinary worker check to (batch, question,
--                        sample). The existing worker executes it unchanged.
--   acq_judgments        human mention + recommendation review per observation;
--                        append-only correction chain.
--   acq_referral_imports a manually supplied GA4 export: stated property, range,
--   acq_referral_rows    time zone, attribution basis and conversion event, the
--                        original text and its digest, and validated rows.
--
-- Candidate mentions, metrics and the agency report are derived at read time
-- from these rows (packages/db/src/acquisition-view.ts); none is stored.
-- Replay-safe: every statement converges when migrate() re-runs this file.

CREATE TABLE IF NOT EXISTS acq_question_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  version INT NOT NULL CHECK (version >= 1),
  -- Why this business may be measured. Never inferred: the operator states it.
  basis TEXT NOT NULL CHECK (basis IN ('AUTHORIZED_CLIENT', 'PUBLIC_RESEARCH', 'FIXTURE')),
  category TEXT NOT NULL CHECK (char_length(category) BETWEEN 1 AND 200),
  brand_name TEXT NOT NULL CHECK (char_length(brand_name) BETWEEN 1 AND 120),
  brand_aliases JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(brand_aliases) = 'array' AND jsonb_array_length(brand_aliases) <= 20),
  brand_match_case BOOLEAN NOT NULL DEFAULT false,
  brand_ambiguity TEXT CHECK (brand_ambiguity IS NULL OR char_length(brand_ambiguity) BETWEEN 1 AND 300),
  owned_domains JSONB NOT NULL CHECK (jsonb_typeof(owned_domains) = 'array' AND jsonb_array_length(owned_domains) BETWEEN 1 AND 10),
  competitors JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(competitors) = 'array' AND jsonb_array_length(competitors) <= 15),
  -- sha256 of the canonical set specification (brand configuration + exact questions).
  spec_digest TEXT NOT NULL CHECK (spec_digest ~ '^[0-9a-f]{64}$'),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, version),
  UNIQUE (id, business_id)
);

CREATE TABLE IF NOT EXISTS acq_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  set_id UUID NOT NULL,
  question_key TEXT NOT NULL CHECK (question_key ~ '^[A-Z]{2}-[0-9]{2}$'),
  intent_group TEXT NOT NULL CHECK (intent_group IN ('CATEGORY_DISCOVERY', 'PROBLEM_SOLVING', 'ALTERNATIVES', 'INTEGRATION_NEEDS', 'PURCHASE_EVALUATION')),
  position INT NOT NULL CHECK (position >= 1),
  buyer_question_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (set_id, question_key),
  UNIQUE (set_id, position),
  UNIQUE (buyer_question_id),
  UNIQUE (id, business_id)
);

CREATE TABLE IF NOT EXISTS acq_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  set_id UUID NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('SMOKE', 'FULL')),
  question_count INT NOT NULL CHECK (question_count >= 1),
  sample_count INT NOT NULL CHECK (sample_count BETWEEN 1 AND 5),
  provider TEXT NOT NULL CHECK (char_length(provider) BETWEEN 1 AND 40),
  requested_model TEXT,
  retrieval_requested BOOLEAN NOT NULL DEFAULT true,
  -- planned checks x worker attempt ceiling, acknowledged by the operator.
  max_provider_calls INT NOT NULL CHECK (max_provider_calls >= 1),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id)
);

ALTER TABLE check_runs
  ADD COLUMN IF NOT EXISTS acq_batch_id UUID,
  ADD COLUMN IF NOT EXISTS acq_question_id UUID,
  ADD COLUMN IF NOT EXISTS acq_sample INT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_check_runs_acq_sample ON check_runs(acq_batch_id, acq_question_id, acq_sample) WHERE acq_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_check_runs_acq_batch ON check_runs(acq_batch_id) WHERE acq_batch_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS acq_judgments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  mention TEXT NOT NULL CHECK (mention IN ('MENTIONED', 'NOT_MENTIONED', 'UNCLEAR')),
  recommendation TEXT CHECK (recommendation IS NULL OR recommendation IN ('RECOMMENDED', 'MENTIONED_NOT_RECOMMENDED', 'ADVISED_AGAINST', 'UNCLEAR')),
  -- What the reviewer was shown: detector version and target candidate count.
  detector_version TEXT NOT NULL CHECK (char_length(detector_version) BETWEEN 1 AND 60),
  candidate_count INT NOT NULL CHECK (candidate_count >= 0),
  note TEXT CHECK (note IS NULL OR char_length(note) <= 2000),
  supersedes_id UUID REFERENCES acq_judgments(id),
  reviewed_by_user_id UUID NOT NULL REFERENCES users(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((mention = 'MENTIONED') = (recommendation IS NOT NULL)),
  CHECK (supersedes_id IS NULL OR supersedes_id <> id),
  UNIQUE (id, business_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_acq_judgments_root ON acq_judgments(observation_id) WHERE supersedes_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_acq_judgments_supersedes ON acq_judgments(supersedes_id) WHERE supersedes_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS acq_referral_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('GA4_EXPORT', 'SYNTHETIC_FIXTURE')),
  property_ref TEXT NOT NULL CHECK (char_length(property_ref) BETWEEN 1 AND 120),
  date_start DATE NOT NULL,
  date_end DATE NOT NULL,
  time_zone TEXT NOT NULL CHECK (char_length(time_zone) BETWEEN 1 AND 64),
  attribution_basis TEXT NOT NULL CHECK (attribution_basis IN ('SESSION_SOURCE_MEDIUM')),
  -- NULL: no conversion event configured; the report says SIGNUPS_NOT_MEASURED.
  conversion_event TEXT CHECK (conversion_event IS NULL OR char_length(conversion_event) BETWEEN 1 AND 100),
  raw_text TEXT NOT NULL CHECK (octet_length(raw_text) BETWEEN 1 AND 1048576),
  raw_digest TEXT NOT NULL CHECK (raw_digest ~ '^[0-9a-f]{64}$'),
  row_count INT NOT NULL CHECK (row_count >= 0),
  imported_by_user_id UUID NOT NULL REFERENCES users(id),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (date_start <= date_end),
  UNIQUE (business_id, raw_digest),
  UNIQUE (id, business_id)
);

CREATE TABLE IF NOT EXISTS acq_referral_rows (
  import_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  row_number INT NOT NULL CHECK (row_number >= 1),
  day DATE NOT NULL,
  session_source TEXT NOT NULL CHECK (char_length(session_source) BETWEEN 1 AND 300),
  session_medium TEXT NOT NULL CHECK (char_length(session_medium) BETWEEN 1 AND 300),
  sessions INT NOT NULL CHECK (sessions >= 0),
  conversions INT CHECK (conversions IS NULL OR conversions >= 0),
  PRIMARY KEY (import_id, row_number)
);

-- Composite (id, business_id) references: no acquisition row can point across tenants.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('acq_questions', 'set_id', 'acq_question_sets'),
    ('acq_questions', 'buyer_question_id', 'buyer_questions'),
    ('acq_batches', 'set_id', 'acq_question_sets'),
    ('check_runs', 'acq_batch_id', 'acq_batches'),
    ('check_runs', 'acq_question_id', 'acq_questions'),
    ('acq_judgments', 'observation_id', 'observations'),
    ('acq_judgments', 'batch_id', 'acq_batches'),
    ('acq_judgments', 'supersedes_id', 'acq_judgments'),
    ('acq_referral_rows', 'import_id', 'acq_referral_imports')
  ) AS refs(child, col, parent) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_' || r.child || '_' || r.col || '_tenant') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I, business_id) REFERENCES %I(id, business_id)',
        r.child, 'fk_' || r.child || '_' || r.col || '_tenant', r.col, r.parent);
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_runs_acq_binding') THEN
    ALTER TABLE check_runs ADD CONSTRAINT check_runs_acq_binding CHECK (
      (acq_batch_id IS NULL) = (acq_question_id IS NULL) AND (acq_batch_id IS NULL) = (acq_sample IS NULL)
      AND (acq_sample IS NULL OR acq_sample BETWEEN 1 AND 5)
      AND (acq_batch_id IS NULL OR record_run_id IS NULL));
  END IF;
END $$;

-- A set is frozen when its transaction commits: questions can be added only
-- inside the transaction that created the set (created_at = now() is the
-- transaction start time), never to an existing set.
CREATE OR REPLACE FUNCTION guard_acq_question_set() RETURNS trigger AS $$
BEGIN
  IF NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'question set author must be an account user'; END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_acq_question_set_guard ON acq_question_sets;
CREATE TRIGGER trg_acq_question_set_guard BEFORE INSERT ON acq_question_sets FOR EACH ROW EXECUTE FUNCTION guard_acq_question_set();

CREATE OR REPLACE FUNCTION guard_acq_question() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM acq_question_sets s WHERE s.id = NEW.set_id AND s.business_id = NEW.business_id AND s.created_at = now()) THEN
    RAISE EXCEPTION 'question sets are frozen; create a new version';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_acq_question_guard ON acq_questions;
CREATE TRIGGER trg_acq_question_guard BEFORE INSERT ON acq_questions FOR EACH ROW EXECUTE FUNCTION guard_acq_question();

-- The exact prompt of a frozen question never changes, not even its active flag.
CREATE OR REPLACE FUNCTION guard_acq_buyer_question() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM acq_questions WHERE buyer_question_id = OLD.id) AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'frozen acquisition question is immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_acq_buyer_question ON buyer_questions;
CREATE TRIGGER trg_acq_buyer_question BEFORE UPDATE ON buyer_questions FOR EACH ROW EXECUTE FUNCTION guard_acq_buyer_question();

CREATE OR REPLACE FUNCTION guard_acq_batch() RETURNS trigger AS $$
BEGIN
  IF NOT record_member(NEW.business_id, NEW.requested_by_user_id) THEN RAISE EXCEPTION 'batch requester must be an account user'; END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_acq_batch_guard ON acq_batches;
CREATE TRIGGER trg_acq_batch_guard BEFORE INSERT ON acq_batches FOR EACH ROW EXECUTE FUNCTION guard_acq_batch();

-- A batch check asks exactly its frozen question through its batch's
-- provider/model, within the batch sampling policy, and that identity never
-- changes afterwards.
CREATE OR REPLACE FUNCTION guard_acq_check() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.acq_batch_id, NEW.acq_question_id, NEW.acq_sample) IS DISTINCT FROM ROW(OLD.acq_batch_id, OLD.acq_question_id, OLD.acq_sample)
      OR (OLD.acq_batch_id IS NOT NULL AND ROW(NEW.business_id, NEW.question_id, NEW.provider, NEW.requested_model)
        IS DISTINCT FROM ROW(OLD.business_id, OLD.question_id, OLD.provider, OLD.requested_model)) THEN
      RAISE EXCEPTION 'acquisition check identity is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.acq_batch_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM acq_batches b JOIN acq_questions q ON q.set_id = b.set_id AND q.business_id = b.business_id
    WHERE b.id = NEW.acq_batch_id AND b.business_id = NEW.business_id AND q.id = NEW.acq_question_id
      AND q.buyer_question_id = NEW.question_id AND b.provider = NEW.provider
      AND b.requested_model IS NOT DISTINCT FROM NEW.requested_model AND NEW.acq_sample <= b.sample_count
  ) THEN RAISE EXCEPTION 'acquisition check does not match its batch and question'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_acq_check_guard ON check_runs;
CREATE TRIGGER trg_acq_check_guard BEFORE INSERT OR UPDATE ON check_runs FOR EACH ROW EXECUTE FUNCTION guard_acq_check();

CREATE OR REPLACE FUNCTION guard_acq_judgment() RETURNS trigger AS $$
BEGIN
  IF NOT record_member(NEW.business_id, NEW.reviewed_by_user_id) THEN RAISE EXCEPTION 'reviewer must be an account user'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM observations o JOIN check_runs c ON c.id = o.check_run_id
    WHERE o.id = NEW.observation_id AND o.business_id = NEW.business_id AND c.acq_batch_id = NEW.batch_id
  ) THEN RAISE EXCEPTION 'judgment must review an observation of its own acquisition batch'; END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM acq_judgments p WHERE p.id = NEW.supersedes_id AND p.observation_id = NEW.observation_id
  ) THEN RAISE EXCEPTION 'judgment correction must supersede a judgment of the same observation'; END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_acq_judgment_guard ON acq_judgments;
CREATE TRIGGER trg_acq_judgment_guard BEFORE INSERT ON acq_judgments FOR EACH ROW EXECUTE FUNCTION guard_acq_judgment();

CREATE OR REPLACE FUNCTION guard_acq_referral_import() RETURNS trigger AS $$
BEGIN
  IF NOT record_member(NEW.business_id, NEW.imported_by_user_id) THEN RAISE EXCEPTION 'importer must be an account user'; END IF;
  NEW.imported_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_acq_referral_import_guard ON acq_referral_imports;
CREATE TRIGGER trg_acq_referral_import_guard BEFORE INSERT ON acq_referral_imports FOR EACH ROW EXECUTE FUNCTION guard_acq_referral_import();

-- Rows stay inside the stated range, and conversions exist exactly when the
-- import names a conversion event; they are added only with their import.
CREATE OR REPLACE FUNCTION guard_acq_referral_row() RETURNS trigger AS $$
DECLARE imp RECORD;
BEGIN
  SELECT date_start, date_end, conversion_event, imported_at INTO imp FROM acq_referral_imports WHERE id = NEW.import_id AND business_id = NEW.business_id;
  IF NOT FOUND OR imp.imported_at <> now() THEN RAISE EXCEPTION 'referral rows are written only with their import'; END IF;
  IF NEW.day < imp.date_start OR NEW.day > imp.date_end THEN RAISE EXCEPTION 'referral row is outside the stated date range'; END IF;
  IF (imp.conversion_event IS NULL) <> (NEW.conversions IS NULL) THEN RAISE EXCEPTION 'conversions require a stated conversion event'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_acq_referral_row_guard ON acq_referral_rows;
CREATE TRIGGER trg_acq_referral_row_guard BEFORE INSERT ON acq_referral_rows FOR EACH ROW EXECUTE FUNCTION guard_acq_referral_row();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['acq_question_sets', 'acq_questions', 'acq_batches', 'acq_judgments', 'acq_referral_imports', 'acq_referral_rows'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_acq_append ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_acq_append BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_acq_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_acq_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation()', t);
  END LOOP;
END $$;
