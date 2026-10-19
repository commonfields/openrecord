-- P1: Business/record_profiles remain the product and ownership boundary.
-- Goal statements and metric definitions are independently immutable versions.
-- Initiatives retain their original goal binding; progress is derived.
-- Amending an unmerged migration must never silently accept the old layout.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='growth_goals' AND column_name='kind') THEN
    RAISE EXCEPTION 'W0 requires a fresh or compatible schema; legacy 0030/0031 must be preserved and explicitly migrated, never replayed as an upgrade';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS growth_metric_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES record_profiles(business_id),
  version INT NOT NULL CHECK (version > 0),
  conversion_kind TEXT NOT NULL CHECK (conversion_kind IN ('LEAD','SIGNUP','PURCHASE','BOOKING')),
  label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 120),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('GA4_AGGREGATE_EXPORT','OPERATOR_AGGREGATE_EXPORT')),
  source_identity TEXT NOT NULL CHECK (length(trim(source_identity)) BETWEEN 1 AND 200),
  event_name TEXT,
  counting_semantics TEXT NOT NULL,
  unit TEXT NOT NULL,
  currency TEXT,
  reporting_time_zone TEXT NOT NULL,
  property_ref TEXT CHECK (property_ref IS NULL OR length(trim(property_ref)) BETWEEN 1 AND 200),
  created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id,business_id), UNIQUE (business_id,version),
  CHECK ((counting_semantics='EVENT_COUNT' AND unit='COUNT' AND currency IS NULL) OR
    (counting_semantics='SUM' AND unit='CURRENCY_MINOR' AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$' AND source_kind='OPERATOR_AGGREGATE_EXPORT')),
  CHECK ((source_kind='GA4_AGGREGATE_EXPORT' AND property_ref IS NOT NULL AND event_name IS NOT NULL AND event_name ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$') OR
    (source_kind='OPERATOR_AGGREGATE_EXPORT' AND event_name IS NULL))
);
CREATE TABLE IF NOT EXISTS growth_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), business_id UUID NOT NULL REFERENCES record_profiles(business_id),
  version INT NOT NULL CHECK (version>0), statement TEXT NOT NULL CHECK (length(trim(statement)) BETWEEN 1 AND 1000),
  metric_definition_id UUID NOT NULL, created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id,business_id), UNIQUE(business_id,version),
  FOREIGN KEY(metric_definition_id,business_id) REFERENCES growth_metric_definitions(id,business_id)
);
CREATE TABLE IF NOT EXISTS growth_profiles (
  business_id UUID PRIMARY KEY REFERENCES record_profiles(business_id),
  category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 1 AND 300),
  audience TEXT NOT NULL CHECK (length(trim(audience)) BETWEEN 1 AND 1000),
  value_proposition TEXT NOT NULL CHECK (length(trim(value_proposition)) BETWEEN 1 AND 2000),
  primary_goal_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (primary_goal_id, business_id) REFERENCES growth_goals(id, business_id)
);
-- Atomic registration reuses RecordRepository.createClient and records a
-- request identity without adding a parallel product persistence model.
CREATE TABLE IF NOT EXISTS growth_registrations (
  account_id UUID NOT NULL REFERENCES accounts(id), request_key UUID NOT NULL,
  business_id UUID NOT NULL UNIQUE REFERENCES growth_profiles(business_id),
  PRIMARY KEY (account_id, request_key)
);
CREATE TABLE IF NOT EXISTS growth_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES growth_profiles(business_id),
  goal_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  problem_statement TEXT NOT NULL CHECK (length(trim(problem_statement)) BETWEEN 1 AND 2000),
  audience TEXT NOT NULL CHECK (length(trim(audience)) BETWEEN 1 AND 1000),
  buyer_intent TEXT NOT NULL CHECK (length(trim(buyer_intent)) BETWEEN 1 AND 1000),
  target_url TEXT CHECK (target_url IS NULL OR target_url ~ '^https?://[^[:space:]]+$'),
  source TEXT NOT NULL CHECK (length(trim(source)) BETWEEN 1 AND 300),
  proposed_change TEXT NOT NULL CHECK (length(trim(proposed_change)) BETWEEN 1 AND 2000),
  expected_mechanism TEXT NOT NULL CHECK (length(trim(expected_mechanism)) BETWEEN 1 AND 2000),
  assumptions TEXT NOT NULL CHECK (length(trim(assumptions)) BETWEEN 1 AND 2000),
  uncertainty TEXT NOT NULL CHECK (length(trim(uncertainty)) BETWEEN 1 AND 2000),
  baseline_availability TEXT NOT NULL CHECK (baseline_availability IN ('UNKNOWN','UNAVAILABLE','AVAILABLE')),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_by_actor TEXT NOT NULL CHECK (created_by_actor IN ('OPERATOR','ASSISTANT')),
  request_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id), UNIQUE (business_id, request_key),
  FOREIGN KEY (goal_id, business_id) REFERENCES growth_goals(id, business_id)
);
CREATE INDEX IF NOT EXISTS growth_opportunities_business ON growth_opportunities(business_id, created_at DESC, id);
CREATE TABLE IF NOT EXISTS growth_opportunity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL, business_id UUID NOT NULL,
  revision INT NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('DISCOVERED','PROPOSED','APPROVED','REVIEWED','CANCELLED')),
  actor TEXT NOT NULL CHECK (actor IN ('OPERATOR','ASSISTANT')),
  conclusion TEXT CHECK (conclusion IN ('KEEP','REVERT','EXTEND','INCONCLUSIVE')),
  CHECK ((status='REVIEWED') = (conclusion IS NOT NULL)),
  user_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  request_key UUID NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (opportunity_id, business_id) REFERENCES growth_opportunities(id, business_id),
  UNIQUE (opportunity_id, revision), UNIQUE (opportunity_id, request_key)
);
CREATE TABLE IF NOT EXISTS growth_opportunity_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opportunity_id UUID NOT NULL, business_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('OBSERVED','OPERATOR_HYPOTHESIS','MODEL_SUGGESTION')),
  reference_kind TEXT, reference_id UUID,
  note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (opportunity_id, business_id) REFERENCES growth_opportunities(id, business_id),
  CHECK ((type = 'OBSERVED') = (reference_kind IS NOT NULL AND reference_id IS NOT NULL)),
  CHECK (type = 'OBSERVED' OR (reference_kind IS NULL AND reference_id IS NULL))
);

-- One implementation shared by the repository and DB evidence guard.
-- A check/batch must contain actual non-synthetic observations; an empty or
-- queued run is not observed evidence. Referral imports retain their origin.
CREATE OR REPLACE FUNCTION growth_observed_exists(b UUID, k TEXT, i UUID) RETURNS BOOLEAN AS $$
  SELECT CASE k
    WHEN 'OBSERVATION' THEN EXISTS (SELECT 1 FROM observations WHERE id=i AND business_id=b AND NOT synthetic)
    WHEN 'RECORD_CHECK' THEN EXISTS (SELECT 1 FROM check_runs c JOIN observations o ON o.check_run_id=c.id AND o.business_id=c.business_id WHERE c.id=i AND c.business_id=b AND c.record_run_id IS NOT NULL AND NOT o.synthetic)
    WHEN 'RECORD_JUDGMENT' THEN EXISTS (SELECT 1 FROM record_judgments j JOIN observations o ON o.id=j.observation_id AND o.business_id=j.business_id WHERE j.id=i AND j.business_id=b AND NOT o.synthetic)
    WHEN 'ACQUISITION_BATCH' THEN EXISTS (SELECT 1 FROM check_runs c JOIN observations o ON o.check_run_id=c.id AND o.business_id=c.business_id WHERE c.acq_batch_id=i AND c.business_id=b AND NOT o.synthetic)
    WHEN 'ACQUISITION_RESULT' THEN EXISTS (SELECT 1 FROM acq_judgments j JOIN observations o ON o.id=j.observation_id AND o.business_id=j.business_id WHERE j.id=i AND j.business_id=b AND NOT o.synthetic)
    WHEN 'REFERRAL_IMPORT' THEN EXISTS (SELECT 1 FROM acq_referral_imports WHERE id=i AND business_id=b AND data_origin='GA4_EXPORT')
    WHEN 'RECORD_ACTION' THEN EXISTS (SELECT 1 FROM record_actions WHERE intervention_id=i AND business_id=b)
    ELSE false END
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION guard_growth_authorship() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME IN ('growth_goals','growth_metric_definitions') THEN
    IF NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'growth author must be account member'; END IF;
    IF TG_TABLE_NAME='growth_metric_definitions' THEN
      IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=NEW.reporting_time_zone) THEN RAISE EXCEPTION 'invalid reporting timezone'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='growth_profiles' THEN
    IF NOT record_member(NEW.business_id, NEW.updated_by_user_id) THEN RAISE EXCEPTION 'growth editor must be account member'; END IF;
    NEW.updated_at := now();
  ELSE
    IF NOT record_member(NEW.business_id, NEW.created_by_user_id) OR NOT record_member(NEW.business_id, NEW.owner_user_id) THEN RAISE EXCEPTION 'growth author and owner must be account members'; END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guard_growth_event() RETURNS trigger AS $$
DECLARE prior growth_opportunity_events; opportunity growth_opportunities;
BEGIN
  SELECT * INTO opportunity FROM growth_opportunities WHERE id=NEW.opportunity_id AND business_id=NEW.business_id FOR UPDATE;
  IF NOT FOUND OR NOT record_member(NEW.business_id,NEW.user_id) THEN RAISE EXCEPTION 'growth event outside scope'; END IF;
  SELECT * INTO prior FROM growth_opportunity_events WHERE opportunity_id=NEW.opportunity_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision <> COALESCE(prior.revision,0)+1 THEN RAISE EXCEPTION 'stale growth revision'; END IF;
  -- Backstop for the pure GROWTH_TRANSITIONS policy. P1 deliberately has no
  -- system transition path. P2/P3 must attach authoritative records here.
  IF prior.id IS NULL THEN
    IF NEW.status NOT IN ('DISCOVERED','PROPOSED') OR NEW.actor <> opportunity.created_by_actor OR NEW.user_id <> opportunity.created_by_user_id THEN RAISE EXCEPTION 'invalid initial growth event'; END IF;
  ELSIF NOT (
    (prior.status='DISCOVERED' AND NEW.status='PROPOSED' AND NEW.actor IN ('OPERATOR','ASSISTANT')) OR
    (prior.status='PROPOSED' AND NEW.status='APPROVED' AND NEW.actor='OPERATOR') OR
    (prior.status='APPROVED' AND NEW.status='REVIEWED' AND NEW.actor='OPERATOR') OR
    (prior.status IN ('DISCOVERED','PROPOSED','APPROVED') AND NEW.status='CANCELLED' AND NEW.actor='OPERATOR')
  ) THEN RAISE EXCEPTION 'growth transition refused'; END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION guard_growth_evidence() RETURNS trigger AS $$
DECLARE author TEXT;
BEGIN
  SELECT created_by_actor INTO author FROM growth_opportunities WHERE id=NEW.opportunity_id AND business_id=NEW.business_id;
  IF (NEW.type='MODEL_SUGGESTION' AND author <> 'ASSISTANT') OR (NEW.type='OPERATOR_HYPOTHESIS' AND author <> 'OPERATOR') THEN RAISE EXCEPTION 'evidence authorship mismatch'; END IF;
  IF NEW.type='OBSERVED' AND NOT growth_observed_exists(NEW.business_id,NEW.reference_kind,NEW.reference_id) THEN RAISE EXCEPTION 'observed evidence outside scope or unavailable'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['growth_metric_definitions','growth_goals','growth_profiles','growth_opportunities'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS growth_authorship ON %I',t);
    EXECUTE format('CREATE TRIGGER growth_authorship BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION guard_growth_authorship()',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['growth_metric_definitions','growth_goals','growth_opportunities','growth_opportunity_events','growth_opportunity_evidence','growth_registrations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS growth_append_only ON %I',t);
    EXECUTE format('CREATE TRIGGER growth_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()',t);
    EXECUTE format('DROP TRIGGER IF EXISTS growth_no_truncate ON %I',t);
    EXECUTE format('CREATE TRIGGER growth_no_truncate BEFORE TRUNCATE ON %I EXECUTE FUNCTION prevent_append_only_mutation()',t);
  END LOOP;
END $$;
DROP TRIGGER IF EXISTS growth_event_guard ON growth_opportunity_events;
CREATE TRIGGER growth_event_guard BEFORE INSERT ON growth_opportunity_events FOR EACH ROW EXECUTE FUNCTION guard_growth_event();
DROP TRIGGER IF EXISTS growth_evidence_guard ON growth_opportunity_evidence;
CREATE TRIGGER growth_evidence_guard BEFORE INSERT ON growth_opportunity_evidence FOR EACH ROW EXECUTE FUNCTION guard_growth_evidence();

-- Additive, nullable columns keep legacy interventions and protocol v1 intact.
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS assurance TEXT;
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS verification_kind TEXT;
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS verification_id UUID;
ALTER TABLE interventions ADD COLUMN IF NOT EXISTS verification_claim TEXT;
ALTER TABLE interventions DROP CONSTRAINT IF EXISTS interventions_type_check;
ALTER TABLE interventions ADD CONSTRAINT interventions_type_check CHECK (type IN
  ('SOURCE_UPDATED','SOURCE_PUBLISHED','THIRD_PARTY_CORRECTION_REQUESTED','KNOWLEDGE_BASE_UPDATED','STRUCTURED_DATA_UPDATED','OTHER','CAMPAIGN_SENT','LISTING_UPDATED'));
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='interventions'::regclass AND conname='growth_intervention_business_key') THEN
    ALTER TABLE interventions ADD CONSTRAINT growth_intervention_business_key UNIQUE(id,business_id);
  END IF;
END $$;
-- W2 replaces this with an adapter resolver validating the ENTIRE claim,
-- including event, business, content digests and performed time, not just an ID.
CREATE OR REPLACE FUNCTION growth_execution_verified(execution interventions) RETURNS BOOLEAN AS $$ SELECT false $$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION guard_growth_execution() RETURNS trigger AS $$
BEGIN
  IF NEW.channel IS NULL AND NEW.assurance IS NULL AND NEW.verification_kind IS NULL AND NEW.verification_id IS NULL AND NEW.verification_claim IS NULL THEN
    IF NEW.type IN ('CAMPAIGN_SENT','LISTING_UPDATED') THEN RAISE EXCEPTION 'execution assurance required'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.channel IS NULL OR NEW.channel NOT IN ('WEBSITE','THIRD_PARTY_PROFILE','EMAIL','PAID','SOCIAL','OTHER') THEN RAISE EXCEPTION 'invalid execution channel'; END IF;
  IF NEW.assurance='OPERATOR_ATTESTED' THEN
    IF NEW.actor <> 'HUMAN' OR NEW.actor_id IS NULL OR NEW.actor_id !~ '^[a-fA-F0-9-]{36}$' THEN RAISE EXCEPTION 'execution attestation requires a human'; END IF;
    IF NOT record_member(NEW.business_id,NEW.actor_id::uuid) THEN RAISE EXCEPTION 'execution author outside scope'; END IF;
    IF NEW.verification_kind IS NOT NULL OR NEW.verification_id IS NOT NULL OR NEW.verification_claim IS NOT NULL THEN RAISE EXCEPTION 'attestation is not system verification'; END IF;
  ELSIF NEW.assurance='SYSTEM_VERIFIED' THEN
    IF NEW.actor <> 'SYSTEM' OR NEW.actor_id IS NOT NULL OR NEW.type <> 'SOURCE_UPDATED' OR NEW.channel <> 'WEBSITE'
      OR NEW.verification_kind IS DISTINCT FROM 'GROWTH_DELIVERY' OR NEW.verification_id IS NULL OR NEW.verification_claim IS DISTINCT FROM 'PR_MERGED'
      OR NOT growth_execution_verified(NEW) THEN RAISE EXCEPTION 'execution system claim unverified'; END IF;
  ELSE RAISE EXCEPTION 'execution assurance required'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_execution_guard ON interventions;
CREATE TRIGGER growth_execution_guard BEFORE INSERT ON interventions FOR EACH ROW EXECUTE FUNCTION guard_growth_execution();
CREATE TABLE IF NOT EXISTS growth_initiative_actions (
  intervention_id UUID PRIMARY KEY, opportunity_id UUID NOT NULL, business_id UUID NOT NULL,
  request_key UUID NOT NULL, created_by_user_id UUID NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(intervention_id,business_id) REFERENCES interventions(id,business_id),
  FOREIGN KEY(opportunity_id,business_id) REFERENCES growth_opportunities(id,business_id), UNIQUE(opportunity_id,request_key)
);
CREATE OR REPLACE FUNCTION guard_growth_execution_link() RETURNS trigger AS $$
DECLARE execution interventions; status TEXT;
BEGIN
  PERFORM 1 FROM growth_opportunities WHERE id=NEW.opportunity_id AND business_id=NEW.business_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'execution link outside scope'; END IF;
  SELECT e.status INTO status FROM growth_opportunity_events e WHERE e.opportunity_id=NEW.opportunity_id AND e.business_id=NEW.business_id ORDER BY revision DESC LIMIT 1;
  SELECT * INTO execution FROM interventions WHERE id=NEW.intervention_id AND business_id=NEW.business_id;
  IF status IS DISTINCT FROM 'APPROVED' OR execution.id IS NULL OR execution.channel IS NULL OR execution.assurance IS NULL OR NOT record_member(NEW.business_id,NEW.created_by_user_id) THEN RAISE EXCEPTION 'execution link outside scope or initiative not approved'; END IF;
  IF execution.supersedes_id IS NOT NULL AND EXISTS (SELECT 1 FROM growth_initiative_actions a WHERE a.intervention_id=execution.supersedes_id AND a.opportunity_id<>NEW.opportunity_id) THEN RAISE EXCEPTION 'execution correction cannot change initiative'; END IF;
  IF execution.assurance='OPERATOR_ATTESTED' AND execution.actor_id IS DISTINCT FROM NEW.created_by_user_id::text THEN RAISE EXCEPTION 'execution attestation author mismatch'; END IF;
  IF execution.assurance='SYSTEM_VERIFIED' AND NOT growth_execution_verified(execution) THEN RAISE EXCEPTION 'execution claim unavailable'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_execution_link_guard ON growth_initiative_actions;
CREATE TRIGGER growth_execution_link_guard BEFORE INSERT ON growth_initiative_actions FOR EACH ROW EXECUTE FUNCTION guard_growth_execution_link();
DROP TRIGGER IF EXISTS growth_execution_link_append ON growth_initiative_actions;
CREATE TRIGGER growth_execution_link_append BEFORE UPDATE OR DELETE ON growth_initiative_actions FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS growth_execution_link_no_truncate ON growth_initiative_actions;
CREATE TRIGGER growth_execution_link_no_truncate BEFORE TRUNCATE ON growth_initiative_actions EXECUTE FUNCTION prevent_append_only_mutation();

CREATE OR REPLACE VIEW growth_metric_documents AS SELECT m.id,m.business_id,
  jsonb_build_object('id',m.id,'businessId',m.business_id,'version',m.version,'conversionKind',m.conversion_kind,'label',m.label,
    'sourceKind',m.source_kind,'sourceIdentity',m.source_identity,'eventName',m.event_name,'countingSemantics',m.counting_semantics,
    'unit',m.unit,'currency',m.currency,'reportingTimeZone',m.reporting_time_zone,'propertyRef',m.property_ref,
    'createdByUserId',m.created_by_user_id,'createdAt',m.created_at) AS document FROM growth_metric_definitions m;
CREATE OR REPLACE VIEW growth_goal_documents AS SELECT g.id,g.business_id,
  jsonb_build_object('id',g.id,'businessId',g.business_id,'version',g.version,'statement',g.statement,'metricDefinition',m.document,
    'createdByUserId',g.created_by_user_id,'createdAt',g.created_at) AS document
  FROM growth_goals g JOIN growth_metric_documents m ON m.id=g.metric_definition_id AND m.business_id=g.business_id;
CREATE OR REPLACE VIEW growth_opportunity_documents AS SELECT o.id, o.business_id, o.created_at,
  jsonb_build_object('id',o.id,'businessId',o.business_id,'goalId',o.goal_id,'title',o.title,'problemStatement',o.problem_statement,
    'audience',o.audience,'buyerIntent',o.buyer_intent,'targetUrl',o.target_url,'source',o.source,'proposedChange',o.proposed_change,
    'expectedMechanism',o.expected_mechanism,'assumptions',o.assumptions,'uncertainty',o.uncertainty,'baselineAvailability',o.baseline_availability,
    'ownerUserId',o.owner_user_id,'createdByUserId',o.created_by_user_id,'createdByActor',o.created_by_actor,'createdAt',o.created_at,
    'status',last_event.status,'revision',last_event.revision,'updatedAt',last_event.created_at,'updatedByUserId',last_event.user_id,
    'progress',CASE WHEN execution_count.n>0 THEN 'EXECUTED' ELSE 'NOT_STARTED' END,'executionCount',execution_count.n,
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'status',e.status,'revision',e.revision,'actor',e.actor,'userId',e.user_id,'reason',e.reason,'conclusion',e.conclusion,'createdAt',e.created_at) ORDER BY e.revision) FROM growth_opportunity_events e WHERE e.opportunity_id=o.id),'[]'::jsonb),
    'evidence',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'type',e.type,'note',e.note,'createdAt',e.created_at) ||
      CASE WHEN e.type='OBSERVED' THEN jsonb_build_object('reference',jsonb_build_object('kind',e.reference_kind,'id',e.reference_id)) ELSE '{}'::jsonb END ORDER BY e.created_at,e.id) FROM growth_opportunity_evidence e WHERE e.opportunity_id=o.id),'[]'::jsonb)) AS document
  FROM growth_opportunities o JOIN LATERAL (SELECT * FROM growth_opportunity_events e WHERE e.opportunity_id=o.id ORDER BY revision DESC LIMIT 1) last_event ON true
  CROSS JOIN LATERAL (SELECT count(*)::int n FROM growth_initiative_actions a JOIN interventions i ON i.id=a.intervention_id AND i.business_id=a.business_id
    WHERE a.opportunity_id=o.id AND NOT EXISTS(SELECT 1 FROM interventions correction WHERE correction.supersedes_id=i.id)) execution_count;

-- Even direct SQL cannot commit an opportunity without its first event and
-- explicit authorship evidence. Deferred because the repository inserts all
-- three immutable parts in one transaction.
CREATE OR REPLACE FUNCTION guard_growth_opportunity_complete() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM growth_opportunity_events WHERE opportunity_id=NEW.id AND revision=1)
    OR NOT EXISTS (SELECT 1 FROM growth_opportunity_evidence WHERE opportunity_id=NEW.id
      AND type=CASE NEW.created_by_actor WHEN 'ASSISTANT' THEN 'MODEL_SUGGESTION' ELSE 'OPERATOR_HYPOTHESIS' END)
  THEN RAISE EXCEPTION 'growth opportunity requires initial event and authorship evidence'; END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_opportunity_complete ON growth_opportunities;
CREATE CONSTRAINT TRIGGER growth_opportunity_complete AFTER INSERT ON growth_opportunities DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_growth_opportunity_complete();

CREATE OR REPLACE FUNCTION guard_growth_registration() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id=NEW.business_id AND account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'growth registration outside account';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_registration_guard ON growth_registrations;
CREATE TRIGGER growth_registration_guard BEFORE INSERT ON growth_registrations FOR EACH ROW EXECUTE FUNCTION guard_growth_registration();
