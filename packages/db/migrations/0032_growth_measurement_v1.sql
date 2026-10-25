-- W3: trustworthy, version-bound daily aggregate measurements.
-- Imports bind to exactly one immutable W0 metric definition; the binding,
-- timezone and counting semantics are enforced in the database. Import rows
-- are append-only; a corrected export is a new import, and the read model
-- resolves per-day values so conflicts stay visible instead of silent.
-- Currency aggregation (SUM/CURRENCY_MINOR) is fail-closed until its queue
-- semantics are implemented and tested. This file never touches 0030
-- semantics and never depends on 0031 objects.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='growth_goals' AND column_name='kind') THEN
    RAISE EXCEPTION 'W3 requires the landed W0 layout; legacy 0030/0031 must be preserved and explicitly migrated, never replayed as an upgrade';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='growth_metric_definitions') THEN
    RAISE EXCEPTION 'W3 requires the W0 growth_metric_definitions table; run the landed 0030 before 0032';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='growth_opportunity_events' AND column_name='delivery_id') THEN
    RAISE EXCEPTION 'old 0031 delivery artifacts detected; the preserved 0031 must never be replayed over new W0/W3';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS growth_metric_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES record_profiles(business_id),
  metric_definition_id UUID NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('GA4_AGGREGATE_EXPORT','OPERATOR_AGGREGATE_EXPORT')),
  -- OPERATOR_SUPPLIED_EXPORT covers both GA4 downloads and typed-up CSVs:
  -- the operator asserts the bytes, nothing authenticates the platform.
  provenance TEXT NOT NULL CHECK (provenance IN ('OPERATOR_SUPPLIED_EXPORT','SYNTHETIC_FIXTURE')),
  property_ref TEXT CHECK (property_ref IS NULL OR length(trim(property_ref)) BETWEEN 1 AND 200),
  date_start DATE NOT NULL,
  date_end DATE NOT NULL,
  CHECK (date_end >= date_start AND (date_end - date_start) <= 365),
  time_zone TEXT NOT NULL,
  -- Raw bytes preserved verbatim; the digest is the same-bytes replay key.
  raw_text TEXT NOT NULL,
  raw_digest TEXT NOT NULL CHECK (raw_digest ~ '^[a-f0-9]{64}$'),
  row_count INT NOT NULL CHECK (row_count >= 0),
  imported_by_user_id UUID NOT NULL REFERENCES users(id),
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  -- Same bytes for one business are one import. Conflicting pasted payloads
  -- under identical bytes are refused by the repository, not silently stored.
  UNIQUE (business_id, raw_digest),
  FOREIGN KEY (metric_definition_id, business_id) REFERENCES growth_metric_definitions(id, business_id)
);
CREATE TABLE IF NOT EXISTS growth_metric_rows (
  import_id UUID NOT NULL, business_id UUID NOT NULL,
  day DATE NOT NULL,
  value INT NOT NULL CHECK (value >= 0),
  PRIMARY KEY (import_id, day),
  FOREIGN KEY (import_id, business_id) REFERENCES growth_metric_imports(id, business_id)
);
CREATE TABLE IF NOT EXISTS growth_measurement_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL, business_id UUID NOT NULL,
  metric_definition_id UUID NOT NULL,
  baseline_start DATE NOT NULL,
  baseline_end DATE NOT NULL,
  observation_start DATE NOT NULL,
  observation_end DATE NOT NULL,
  -- Baseline and observation must not overlap or touch; one year bounds each window.
  CHECK (baseline_end >= baseline_start AND (baseline_end - baseline_start) <= 365),
  CHECK (observation_start > baseline_end AND observation_end >= observation_start AND (observation_end - observation_start) <= 365),
  declared_by_user_id UUID NOT NULL REFERENCES users(id),
  declared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  request_key UUID NOT NULL,
  UNIQUE (id, business_id), UNIQUE (opportunity_id, request_key),
  FOREIGN KEY (opportunity_id, business_id) REFERENCES growth_opportunities(id, business_id),
  FOREIGN KEY (metric_definition_id, business_id) REFERENCES growth_metric_definitions(id, business_id)
);
CREATE INDEX IF NOT EXISTS growth_metric_imports_binding
  ON growth_metric_imports(business_id, metric_definition_id, imported_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS growth_metric_imports_range ON growth_metric_imports(business_id, date_start, date_end);
CREATE INDEX IF NOT EXISTS growth_measurement_plans_business ON growth_measurement_plans(business_id, declared_at DESC, id DESC);

-- An import is only acceptable inside its definition's exact identity: same
-- source kind, the definition's timezone, the definition's property reference
-- where the definition states one, and only count semantics.
CREATE OR REPLACE FUNCTION guard_growth_metric_import() RETURNS trigger AS $$
DECLARE definition growth_metric_definitions;
BEGIN
  SELECT * INTO definition FROM growth_metric_definitions WHERE id=NEW.metric_definition_id AND business_id=NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'import outside scope or definition missing'; END IF;
  IF NEW.source_kind IS DISTINCT FROM definition.source_kind THEN RAISE EXCEPTION 'import source kind mismatch'; END IF;
  IF NEW.time_zone IS DISTINCT FROM definition.reporting_time_zone THEN RAISE EXCEPTION 'import timezone mismatch'; END IF;
  IF (definition.property_ref IS NULL) <> (NEW.property_ref IS NULL) OR
     (definition.property_ref IS NOT NULL AND NEW.property_ref IS DISTINCT FROM definition.property_ref) THEN
    RAISE EXCEPTION 'import property reference mismatch';
  END IF;
  IF definition.counting_semantics IS DISTINCT FROM 'EVENT_COUNT' OR definition.unit IS DISTINCT FROM 'COUNT' OR definition.currency IS NOT NULL THEN
    RAISE EXCEPTION 'measurement imports require EVENT_COUNT and COUNT; SUM/CURRENCY_MINOR aggregation is not implemented';
  END IF;
  IF NOT record_member(NEW.business_id, NEW.imported_by_user_id) THEN RAISE EXCEPTION 'import outside scope'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_metric_import_guard ON growth_metric_imports;
CREATE TRIGGER growth_metric_import_guard BEFORE INSERT ON growth_metric_imports FOR EACH ROW EXECUTE FUNCTION guard_growth_metric_import();

-- Rows are written only with their import, inside the import's declared
-- range, against a definition that still holds count semantics.
CREATE OR REPLACE FUNCTION guard_growth_metric_row() RETURNS trigger AS $$
DECLARE import growth_metric_imports; definition growth_metric_definitions;
BEGIN
  SELECT * INTO import FROM growth_metric_imports WHERE id=NEW.import_id AND business_id=NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'import row outside scope'; END IF;
  SELECT * INTO definition FROM growth_metric_definitions WHERE id=import.metric_definition_id AND business_id=import.business_id;
  IF definition.counting_semantics IS DISTINCT FROM 'EVENT_COUNT' OR definition.unit IS DISTINCT FROM 'COUNT' THEN
    RAISE EXCEPTION 'measurement rows require EVENT_COUNT and COUNT';
  END IF;
  IF NEW.day < import.date_start OR NEW.day > import.date_end THEN RAISE EXCEPTION 'import row outside declared range'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_metric_row_guard ON growth_metric_rows;
CREATE TRIGGER growth_metric_row_guard BEFORE INSERT ON growth_metric_rows FOR EACH ROW EXECUTE FUNCTION guard_growth_metric_row();

-- A plan binds an approved initiative to the metric its goal already
-- declares. The definition id is not caller-chosen: the guard refuses any
-- plan whose definition differs from the opportunity's goal binding.
CREATE OR REPLACE FUNCTION guard_growth_plan() RETURNS trigger AS $$
DECLARE status TEXT; bound UUID; definition growth_metric_definitions;
BEGIN
  SELECT e.status INTO status FROM growth_opportunity_events e
    WHERE e.opportunity_id=NEW.opportunity_id AND e.business_id=NEW.business_id ORDER BY revision DESC LIMIT 1;
  IF status IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'plan requires an approved initiative'; END IF;
  SELECT o.goal_id INTO bound FROM growth_opportunities o WHERE o.id=NEW.opportunity_id AND o.business_id=NEW.business_id;
  IF bound IS NULL THEN RAISE EXCEPTION 'plan outside scope'; END IF;
  SELECT g.metric_definition_id INTO bound FROM growth_goals g WHERE g.id=bound AND g.business_id=NEW.business_id;
  IF bound IS DISTINCT FROM NEW.metric_definition_id THEN RAISE EXCEPTION 'plan metric mismatch'; END IF;
  SELECT * INTO definition FROM growth_metric_definitions WHERE id=NEW.metric_definition_id AND business_id=NEW.business_id;
  IF definition.counting_semantics IS DISTINCT FROM 'EVENT_COUNT' OR definition.unit IS DISTINCT FROM 'COUNT' THEN
    RAISE EXCEPTION 'measurement plans require EVENT_COUNT and COUNT; SUM/CURRENCY_MINOR aggregation is not implemented';
  END IF;
  IF NOT record_member(NEW.business_id, NEW.declared_by_user_id) THEN RAISE EXCEPTION 'plan outside scope'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_plan_guard ON growth_measurement_plans;
CREATE TRIGGER growth_plan_guard BEFORE INSERT ON growth_measurement_plans FOR EACH ROW EXECUTE FUNCTION guard_growth_plan();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['growth_metric_imports','growth_metric_rows','growth_measurement_plans'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS growth_measurement_append_only ON %I',t);
    EXECUTE format('CREATE TRIGGER growth_measurement_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()',t);
    EXECUTE format('DROP TRIGGER IF EXISTS growth_measurement_no_truncate ON %I',t);
    EXECUTE format('CREATE TRIGGER growth_measurement_no_truncate BEFORE TRUNCATE ON %I EXECUTE FUNCTION prevent_append_only_mutation()',t);
  END LOOP;
END $$;

-- Views expose the columns the read layer filters on (id, business_id,
-- metric_definition_id/opportunity_id, ordering timestamps) plus the document.
CREATE OR REPLACE VIEW growth_metric_import_documents AS SELECT i.id, i.business_id, i.metric_definition_id, i.imported_at,
  jsonb_build_object('id',i.id,'businessId',i.business_id,'metricDefinitionId',i.metric_definition_id,'sourceKind',i.source_kind,
    'provenance',i.provenance,'propertyRef',i.property_ref,'dateStart',i.date_start,'dateEnd',i.date_end,'timeZone',i.time_zone,
    'rawDigest',i.raw_digest,'rowCount',i.row_count,'importedByUserId',i.imported_by_user_id,'importedAt',i.imported_at) AS document
  FROM growth_metric_imports i;
CREATE OR REPLACE VIEW growth_measurement_plan_documents AS SELECT p.id, p.business_id, p.opportunity_id, p.declared_at,
  jsonb_build_object('id',p.id,'businessId',p.business_id,'opportunityId',p.opportunity_id,'goalId',o.goal_id,
    'metricDefinition',jsonb_build_object('id',d.id,'version',d.version,'label',d.label,'countingSemantics',d.counting_semantics,
      'unit',d.unit,'timeZone',d.reporting_time_zone),
    'baselineStart',p.baseline_start,'baselineEnd',p.baseline_end,'observationStart',p.observation_start,'observationEnd',p.observation_end,
    'declaredByUserId',p.declared_by_user_id,'declaredAt',p.declared_at,'requestKey',p.request_key) AS document
  FROM growth_measurement_plans p
  JOIN growth_opportunities o ON o.id=p.opportunity_id AND o.business_id=p.business_id
  JOIN growth_metric_definitions d ON d.id=p.metric_definition_id AND d.business_id=p.business_id;
