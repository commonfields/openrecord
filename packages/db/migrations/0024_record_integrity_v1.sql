-- 0024_record_integrity_v1.sql — OPENRECORD_RECORD_INTEGRITY_V1 persistence.
--
-- The client record answers: "what does this business say is true, and what
-- have we observed elsewhere?" This migration adds only what that loop lacks:
--
--   record_claims              zero or more claims per record observation, each
--                              bound to the reviewed slot and fact predicate.
--                              Extraction uncertainty stays uncertainty: a span
--                              is stored only when it occurs verbatim in the
--                              observed answer; ambiguous text is never coerced.
--   record_judgments.claim_id  optional link to the exact claim reviewed.
--   record_judgments.fact_id / fact_version
--                              the authoritative fact version the reviewer
--                              judged against. It must be the fact version the
--                              slot tracks AND valid when the observation was
--                              collected: judgment truth version = fact version
--                              valid_at observation.collected_at.
--   check_runs.record_sample  N samples per (run, slot) so a fact shows every
--                              reviewed sample (e.g. "4 of 5 contradicted").
--   record_runs.sample_count  the sampling policy; a follow-up must reuse its
--                              baseline policy so follow-ups compare like with
--                              like instead of pretending different methods
--                              are equivalent.
--
-- Outcomes stay derived at read time. No stored verdict is added. Fact
-- predicates remain free text: the ontology is ordinary business facts
-- (price, hours, availability, policy, ...), never SaaS-specific.

-- N samples per (run, slot). Existing rows are single-sample runs.
ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS record_sample INT NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'check_runs_record_sample_range') THEN
    ALTER TABLE check_runs ADD CONSTRAINT check_runs_record_sample_range CHECK (record_sample BETWEEN 1 AND 5);
  END IF;
END $$;
-- The sample-aware identity keeps the historic index name on purpose:
-- migration 0022 replays CREATE UNIQUE INDEX IF NOT EXISTS under that name
-- on every migrate(), so reusing it makes 0022 a no-op once converged
-- instead of resurrecting the single-sample definition.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_check_runs_record_item' AND indexdef NOT LIKE '%record_sample%') THEN
    DROP INDEX uq_check_runs_record_item;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_check_runs_record_item') THEN
    CREATE UNIQUE INDEX uq_check_runs_record_item ON check_runs(record_run_id, record_item_id, record_sample) WHERE record_run_id IS NOT NULL;
  END IF;
END $$;

ALTER TABLE record_runs ADD COLUMN IF NOT EXISTS sample_count INT NOT NULL DEFAULT 1;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'record_runs_sample_count_range') THEN
    ALTER TABLE record_runs ADD CONSTRAINT record_runs_sample_count_range CHECK (sample_count BETWEEN 1 AND 5);
  END IF;
END $$;

-- A follow-up must reuse its baseline sampling policy; a changed provider or
-- model is still allowed but reads as INDETERMINATE (SURFACE_CHANGED) rather
-- than a correction. Sample identity itself can never change afterwards.
CREATE OR REPLACE FUNCTION guard_record_check() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(NEW.record_run_id, NEW.record_item_id, NEW.record_sample) IS DISTINCT FROM ROW(OLD.record_run_id, OLD.record_item_id, OLD.record_sample) THEN
    RAISE EXCEPTION 'record check binding is immutable';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.record_run_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM record_runs r JOIN record_items i ON i.id = NEW.record_item_id AND i.business_id = r.business_id
      WHERE r.id = NEW.record_run_id AND r.business_id = NEW.business_id AND i.question_id = NEW.question_id
        AND r.provider = NEW.provider AND r.requested_model IS NOT DISTINCT FROM NEW.requested_model
    ) THEN RAISE EXCEPTION 'record check does not match its run and slot'; END IF;
    IF NEW.record_sample > (SELECT sample_count FROM record_runs WHERE id = NEW.record_run_id) THEN
      RAISE EXCEPTION 'record sample exceeds the run sampling policy';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_check_guard ON check_runs;
CREATE TRIGGER trg_record_check_guard BEFORE INSERT OR UPDATE ON check_runs FOR EACH ROW EXECUTE FUNCTION guard_record_check();

CREATE OR REPLACE FUNCTION guard_record_run() RETURNS trigger AS $$
DECLARE
  base_samples INT;
BEGIN
  IF NOT record_member(NEW.business_id, NEW.requested_by_user_id) THEN RAISE EXCEPTION 'run requester must be an account user'; END IF;
  IF NEW.baseline_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM record_runs b WHERE b.id = NEW.baseline_run_id AND b.business_id = NEW.business_id AND b.kind = 'INITIAL'
  ) THEN RAISE EXCEPTION 'follow-up baseline must be an initial run of the same client'; END IF;
  IF NEW.kind = 'FOLLOW_UP' THEN
    SELECT sample_count INTO base_samples FROM record_runs WHERE id = NEW.baseline_run_id;
    IF NEW.sample_count <> base_samples THEN RAISE EXCEPTION 'follow-up must reuse the baseline sampling policy'; END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_run_guard ON record_runs;
CREATE TRIGGER trg_record_run_guard BEFORE INSERT ON record_runs FOR EACH ROW EXECUTE FUNCTION guard_record_run();

-- Claims: the exact evidence a reviewer judged, or may judge. Raw evidence
-- stays sensor-specific and immutable; a claim only points at it.
CREATE TABLE IF NOT EXISTS record_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  observation_id UUID NOT NULL,
  item_id UUID NOT NULL,
  -- Predicate of the reviewed fact, denormalized so the claim keeps a stable
  -- subject identity even as fact versions supersede.
  fact_key TEXT NOT NULL CHECK (char_length(fact_key) BETWEEN 1 AND 200),
  claim_text TEXT NOT NULL CHECK (char_length(claim_text) BETWEEN 1 AND 2000),
  supporting_span TEXT CHECK (supporting_span IS NULL OR char_length(supporting_span) BETWEEN 1 AND 2000),
  normalized_value TEXT CHECK (normalized_value IS NULL OR char_length(normalized_value) BETWEEN 1 AND 500),
  extraction_method TEXT NOT NULL CHECK (extraction_method IN ('MANUAL_TRANSCRIPTION', 'MANUAL_EXACT_SPAN')),
  -- Present only when machine-derived. Manual claims carry NULL: no worker,
  -- seed or migration may impersonate a reviewer or an extractor.
  extractor_version TEXT CHECK (extractor_version IS NULL OR char_length(extractor_version) BETWEEN 1 AND 120),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (extraction_method <> 'MANUAL_EXACT_SPAN' OR supporting_span IS NOT NULL),
  UNIQUE (id, business_id)
);
CREATE INDEX IF NOT EXISTS idx_record_claims_observation ON record_claims(observation_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_record_claims_observation') THEN
    ALTER TABLE record_claims ADD CONSTRAINT fk_record_claims_observation
      FOREIGN KEY (observation_id, business_id) REFERENCES observations(id, business_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_record_claims_item') THEN
    ALTER TABLE record_claims ADD CONSTRAINT fk_record_claims_item
      FOREIGN KEY (item_id, business_id) REFERENCES record_items(id, business_id);
  END IF;
END $$;

-- A claim belongs to its own slot's record observation, and an exact span
-- must occur verbatim in the observed answer. Ambiguous text stays a whole-
-- answer transcription; it is never coerced into a deterministic value.
CREATE OR REPLACE FUNCTION guard_record_claim() RETURNS trigger AS $$
DECLARE
  answer TEXT;
BEGIN
  IF NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'claim author must be an account user'; END IF;
  SELECT o.answer_text INTO answer FROM observations o JOIN check_runs c ON c.id = o.check_run_id
    WHERE o.id = NEW.observation_id AND o.business_id = NEW.business_id
      AND c.record_item_id = NEW.item_id AND c.record_item_id IS NOT NULL;
  IF answer IS NULL THEN RAISE EXCEPTION 'claim must belong to its own slot''s record observation'; END IF;
  IF NEW.supporting_span IS NOT NULL AND position(NEW.supporting_span in answer) = 0 THEN
    RAISE EXCEPTION 'supporting span must occur in the observed answer';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_claim_guard ON record_claims;
CREATE TRIGGER trg_record_claim_guard BEFORE INSERT ON record_claims FOR EACH ROW EXECUTE FUNCTION guard_record_claim();

-- Judgments pin the authoritative fact version they were judged against.
ALTER TABLE record_judgments ADD COLUMN IF NOT EXISTS claim_id UUID;
ALTER TABLE record_judgments ADD COLUMN IF NOT EXISTS fact_id UUID;
ALTER TABLE record_judgments ADD COLUMN IF NOT EXISTS fact_version INT;

-- Backfill pins every existing judgment to the fact version its slot tracks.
-- (Temporarily drops the append-only trigger; history rows are updated in
-- place once, never rewritten afterwards.)
DROP TRIGGER IF EXISTS trg_record_append ON record_judgments;
UPDATE record_judgments j SET fact_id = i.fact_id FROM record_items i
  WHERE i.id = j.item_id AND i.business_id = j.business_id AND j.fact_id IS NULL;
UPDATE record_judgments j SET fact_version = f.version FROM authoritative_facts f
  WHERE f.id = j.fact_id AND j.fact_version IS NULL;
ALTER TABLE record_judgments ALTER COLUMN fact_id SET NOT NULL;
ALTER TABLE record_judgments ALTER COLUMN fact_version SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'record_judgments_fact_version_range') THEN
    ALTER TABLE record_judgments ADD CONSTRAINT record_judgments_fact_version_range CHECK (fact_version >= 1);
  END IF;
END $$;
CREATE TRIGGER trg_record_append BEFORE UPDATE OR DELETE ON record_judgments FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

CREATE UNIQUE INDEX IF NOT EXISTS uq_authoritative_facts_tenant ON authoritative_facts(id, business_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_record_tenant_claims ON record_claims(id, business_id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_record_judgments_claim') THEN
    ALTER TABLE record_judgments ADD CONSTRAINT fk_record_judgments_claim
      FOREIGN KEY (claim_id, business_id) REFERENCES record_claims(id, business_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_record_judgments_fact') THEN
    ALTER TABLE record_judgments ADD CONSTRAINT fk_record_judgments_fact
      FOREIGN KEY (fact_id, business_id) REFERENCES authoritative_facts(id, business_id);
  END IF;
END $$;

-- A final record judgment pins the slot's fact version AND the observation
-- must have been collected while that version was valid. A May observation
-- saying "$49" is judged against the $49 version valid in May, never against
-- today's $79 version.
CREATE OR REPLACE FUNCTION guard_record_judgment() RETURNS trigger AS $$
DECLARE
  slot_item UUID;
  observed_at TIMESTAMPTZ;
  item_fact UUID;
  fact_ver INT;
  fact_from TIMESTAMPTZ;
  fact_until TIMESTAMPTZ;
BEGIN
  IF NOT record_member(NEW.business_id, NEW.reviewed_by_user_id) THEN RAISE EXCEPTION 'reviewer must be an account user'; END IF;
  SELECT c.record_item_id, o.collected_at INTO slot_item, observed_at
    FROM observations o JOIN check_runs c ON c.id = o.check_run_id
    WHERE o.id = NEW.observation_id AND o.business_id = NEW.business_id AND c.record_item_id IS NOT NULL;
  IF slot_item IS NULL OR NEW.item_id <> slot_item THEN
    RAISE EXCEPTION 'judgment must review its own slot''s record observation';
  END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM record_judgments p WHERE p.id = NEW.supersedes_id AND p.observation_id = NEW.observation_id
  ) THEN RAISE EXCEPTION 'judgment correction must supersede a judgment of the same observation'; END IF;
  IF NEW.claim_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM record_claims k WHERE k.id = NEW.claim_id AND k.business_id = NEW.business_id AND k.observation_id = NEW.observation_id
  ) THEN RAISE EXCEPTION 'judgment claim must belong to the reviewed observation'; END IF;
  SELECT i.fact_id INTO item_fact FROM record_items i WHERE i.id = NEW.item_id AND i.business_id = NEW.business_id;
  SELECT f.version, f.valid_from, f.valid_until INTO fact_ver, fact_from, fact_until
    FROM authoritative_facts f WHERE f.id = item_fact AND f.business_id = NEW.business_id;
  IF NEW.fact_id IS DISTINCT FROM item_fact OR NEW.fact_version IS DISTINCT FROM fact_ver THEN
    RAISE EXCEPTION 'judgment must pin the reviewed slot fact version';
  END IF;
  IF observed_at < fact_from OR (fact_until IS NOT NULL AND observed_at >= fact_until) THEN
    RAISE EXCEPTION 'judgment truth was not valid when the observation was collected';
  END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_record_judgment_guard ON record_judgments;
CREATE TRIGGER trg_record_judgment_guard BEFORE INSERT ON record_judgments FOR EACH ROW EXECUTE FUNCTION guard_record_judgment();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['record_claims'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_record_append ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_record_append BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['record_claims'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_record_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER trg_record_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION prevent_append_only_mutation()', t);
  END LOOP;
END $$;
