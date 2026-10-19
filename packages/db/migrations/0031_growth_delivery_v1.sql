-- P2: deliver one approved growth opportunity as a GitHub pull request that
-- changes one first-party Markdown/MDX content file.
--
-- A proposed change (DRAFTED), an approval to open a pull request, an opened
-- pull request, a merge and a deployment are different recorded states. Only
-- the delivery system records what GitHub confirmed; only a person approves,
-- rejects or attests a deployment. Repository credentials never live here:
-- the API reads them from server configuration.

-- Repositories an operator explicitly connected to a product. A website URL
-- never implies one. The API additionally requires the repository to be on the
-- server's allowlist for this account.
CREATE TABLE IF NOT EXISTS growth_delivery_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES growth_profiles(business_id),
  provider TEXT NOT NULL CHECK (provider = 'GITHUB'),
  owner TEXT NOT NULL CHECK (owner ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  repository TEXT NOT NULL CHECK (repository ~ '^[A-Za-z0-9._-]{1,100}$' AND repository NOT IN ('.', '..')),
  base_branch TEXT NOT NULL CHECK (base_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' AND base_branch !~ '\.\.|//|/$|\.lock$'),
  allowed_paths TEXT[] NOT NULL CHECK (cardinality(allowed_paths) BETWEEN 1 AND 20),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id), UNIQUE (business_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS growth_delivery_targets_repo
  ON growth_delivery_targets(business_id, lower(owner), lower(repository));

-- Content paths: Markdown/MDX, plain segments, no segment starting with "."
-- (so no traversal, dot-files or .github), no absolute paths.
CREATE OR REPLACE FUNCTION growth_deliverable_path(p TEXT) RETURNS BOOLEAN AS $$
  SELECT p IS NOT NULL AND length(p) BETWEEN 1 AND 300
    AND p ~ '^([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$'
    AND p ~* '\.mdx?$'
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION guard_growth_delivery_target() RETURNS trigger AS $$
DECLARE entry TEXT;
BEGIN
  IF NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'delivery target author must be account member'; END IF;
  FOREACH entry IN ARRAY NEW.allowed_paths LOOP
    IF NOT ((entry ~ '/$' AND entry ~ '^([A-Za-z0-9_-][A-Za-z0-9_.-]*/)+$') OR growth_deliverable_path(entry)) THEN
      RAISE EXCEPTION 'delivery target path outside the supported content scope';
    END IF;
  END LOOP;
  -- One account per repository: another account's connection is refused
  -- rather than shared.
  IF EXISTS (SELECT 1 FROM growth_delivery_targets t JOIN businesses tb ON tb.id = t.business_id JOIN businesses nb ON nb.id = NEW.business_id
             WHERE lower(t.owner) = lower(NEW.owner) AND lower(t.repository) = lower(NEW.repository) AND tb.account_id <> nb.account_id) THEN
    RAISE EXCEPTION 'repository is connected to another account';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_delivery_target_guard ON growth_delivery_targets;
CREATE TRIGGER growth_delivery_target_guard BEFORE INSERT ON growth_delivery_targets FOR EACH ROW EXECUTE FUNCTION guard_growth_delivery_target();

-- One exact proposed change. Immutable: a different change is a new delivery.
-- patch_sha256 binds repository, path, base blob and the before/after bytes;
-- approval binds to it, and the pull request commits exactly after_content.
CREATE TABLE IF NOT EXISTS growth_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  target_id UUID NOT NULL,
  file_path TEXT NOT NULL CHECK (growth_deliverable_path(file_path)),
  base_branch TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40}$'),
  base_blob_sha TEXT NOT NULL CHECK (base_blob_sha ~ '^[a-f0-9]{40}$'),
  after_blob_sha TEXT NOT NULL CHECK (after_blob_sha ~ '^[a-f0-9]{40}$'),
  before_sha256 TEXT NOT NULL CHECK (before_sha256 ~ '^[a-f0-9]{64}$'),
  after_sha256 TEXT NOT NULL CHECK (after_sha256 ~ '^[a-f0-9]{64}$'),
  patch_sha256 TEXT NOT NULL CHECK (patch_sha256 ~ '^[a-f0-9]{64}$'),
  edits JSONB NOT NULL CHECK (jsonb_typeof(edits) = 'array' AND jsonb_array_length(edits) BETWEEN 1 AND 20),
  after_content TEXT NOT NULL CHECK (octet_length(after_content) <= 256000),
  diff TEXT NOT NULL CHECK (octet_length(diff) <= 600000),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
  assumptions TEXT NOT NULL CHECK (length(trim(assumptions)) BETWEEN 1 AND 2000),
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('OPERATOR', 'ASSISTANT')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id), UNIQUE (business_id, request_key),
  FOREIGN KEY (opportunity_id, business_id) REFERENCES growth_opportunities(id, business_id),
  FOREIGN KEY (target_id, business_id) REFERENCES growth_delivery_targets(id, business_id)
);
CREATE INDEX IF NOT EXISTS growth_deliveries_opportunity ON growth_deliveries(opportunity_id, created_at DESC);

CREATE OR REPLACE FUNCTION growth_opportunity_status(o UUID) RETURNS TEXT AS $$
  SELECT status FROM growth_opportunity_events WHERE opportunity_id = o ORDER BY revision DESC LIMIT 1
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION guard_growth_delivery() RETURNS trigger AS $$
DECLARE target growth_delivery_targets;
BEGIN
  IF NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'delivery author must be account member'; END IF;
  -- Only an approved opportunity can be delivered.
  IF growth_opportunity_status(NEW.opportunity_id) IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'delivery requires an approved opportunity'; END IF;
  SELECT * INTO target FROM growth_delivery_targets WHERE id = NEW.target_id AND business_id = NEW.business_id;
  IF NOT FOUND OR NEW.base_branch IS DISTINCT FROM target.base_branch THEN RAISE EXCEPTION 'delivery target or base branch mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(target.allowed_paths) a WHERE (a ~ '/$' AND starts_with(NEW.file_path, a)) OR NEW.file_path = a) THEN
    RAISE EXCEPTION 'delivery path is not allowed on this repository';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_delivery_guard ON growth_deliveries;
CREATE TRIGGER growth_delivery_guard BEFORE INSERT ON growth_deliveries FOR EACH ROW EXECUTE FUNCTION guard_growth_delivery();

-- Append-only lifecycle. detail carries what the transition rests on: the
-- pull request GitHub returned, the merge commit GitHub reported, or the
-- operator's deployment attestation (labelled as such).
CREATE TABLE IF NOT EXISTS growth_delivery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL,
  business_id UUID NOT NULL,
  revision INT NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('DRAFTED','APPROVED_FOR_PR','REJECTED','STALE','PR_OPENED','PR_MERGED','CLOSED_WITHOUT_DELIVERY','DEPLOYMENT_VERIFIED')),
  actor TEXT NOT NULL CHECK (actor IN ('OPERATOR','ASSISTANT','DELIVERY_SYSTEM')),
  user_id UUID NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  request_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (delivery_id, business_id) REFERENCES growth_deliveries(id, business_id),
  UNIQUE (delivery_id, revision), UNIQUE (delivery_id, request_key)
);

CREATE OR REPLACE FUNCTION growth_delivery_state(d UUID) RETURNS TEXT AS $$
  SELECT state FROM growth_delivery_events WHERE delivery_id = d ORDER BY revision DESC LIMIT 1
$$ LANGUAGE sql STABLE;

-- Pull request creation attempts. GitHub is an external side effect: an
-- attempt is claimed before any write, and an outcome that cannot be confirmed
-- is UNKNOWN until the next request reconciles it against GitHub. At most one
-- attempt per delivery is active or succeeded, so one delivery opens at most
-- one pull request.
CREATE TABLE IF NOT EXISTS growth_delivery_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id UUID NOT NULL,
  business_id UUID NOT NULL,
  request_key UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CLAIMED','SUCCEEDED','FAILED','UNKNOWN')),
  head_branch TEXT NOT NULL CHECK (head_branch ~ '^openrecord/growth-[a-f0-9-]{36}$'),
  commit_sha TEXT CHECK (commit_sha IS NULL OR commit_sha ~ '^[a-f0-9]{40}$'),
  pr_number INT CHECK (pr_number IS NULL OR pr_number > 0),
  pr_url TEXT CHECK (pr_url IS NULL OR pr_url ~ '^https://github\.com/[^[:space:]]+/pull/[0-9]+$'),
  failure_code TEXT,
  failure_detail TEXT CHECK (failure_detail IS NULL OR length(failure_detail) <= 500),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (delivery_id, business_id) REFERENCES growth_deliveries(id, business_id),
  UNIQUE (delivery_id, request_key),
  CHECK ((state = 'SUCCEEDED') = (pr_number IS NOT NULL AND pr_url IS NOT NULL AND commit_sha IS NOT NULL)),
  CHECK ((state = 'FAILED') = (failure_code IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS growth_delivery_attempts_one_active
  ON growth_delivery_attempts(delivery_id) WHERE state IN ('CLAIMED','UNKNOWN','SUCCEEDED');

CREATE OR REPLACE FUNCTION guard_growth_delivery_attempt() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'CLAIMED' THEN RAISE EXCEPTION 'attempts start CLAIMED'; END IF;
    IF growth_delivery_state(NEW.delivery_id) IS DISTINCT FROM 'APPROVED_FOR_PR' THEN RAISE EXCEPTION 'pull request requires an approved delivery'; END IF;
    IF NOT record_member(NEW.business_id, NEW.requested_by_user_id) THEN RAISE EXCEPTION 'attempt requester must be account member'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'growth_delivery_attempts keep their history'; END IF;
  IF (NEW.id, NEW.delivery_id, NEW.business_id, NEW.request_key, NEW.head_branch, NEW.requested_by_user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.delivery_id, OLD.business_id, OLD.request_key, OLD.head_branch, OLD.requested_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'attempt identity is immutable';
  END IF;
  IF NOT ((OLD.state = 'CLAIMED' AND NEW.state IN ('SUCCEEDED','FAILED','UNKNOWN')) OR (OLD.state = 'UNKNOWN' AND NEW.state = 'CLAIMED')) THEN
    RAISE EXCEPTION 'attempt % cannot become %', OLD.state, NEW.state;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_delivery_attempt_guard ON growth_delivery_attempts;
CREATE TRIGGER growth_delivery_attempt_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_delivery_attempts FOR EACH ROW EXECUTE FUNCTION guard_growth_delivery_attempt();

-- Mirrors DELIVERY_TRANSITIONS in packages/contracts/src/growth-delivery.ts.
CREATE OR REPLACE FUNCTION guard_growth_delivery_event() RETURNS trigger AS $$
DECLARE prior growth_delivery_events; delivery growth_deliveries;
BEGIN
  SELECT * INTO delivery FROM growth_deliveries WHERE id = NEW.delivery_id AND business_id = NEW.business_id FOR UPDATE;
  IF NOT FOUND OR NOT record_member(NEW.business_id, NEW.user_id) THEN RAISE EXCEPTION 'delivery event outside scope'; END IF;
  SELECT * INTO prior FROM growth_delivery_events WHERE delivery_id = NEW.delivery_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision <> COALESCE(prior.revision, 0) + 1 THEN RAISE EXCEPTION 'stale delivery revision'; END IF;
  IF prior.id IS NULL THEN
    IF NEW.state <> 'DRAFTED' OR NEW.actor IS DISTINCT FROM delivery.proposed_by OR NEW.user_id IS DISTINCT FROM delivery.created_by_user_id THEN RAISE EXCEPTION 'invalid initial delivery event'; END IF;
  ELSIF NOT (
    (prior.state = 'DRAFTED' AND NEW.state IN ('APPROVED_FOR_PR','REJECTED') AND NEW.actor = 'OPERATOR') OR
    (prior.state = 'APPROVED_FOR_PR' AND NEW.state = 'REJECTED' AND NEW.actor = 'OPERATOR') OR
    (prior.state = 'APPROVED_FOR_PR' AND NEW.state IN ('STALE','PR_OPENED') AND NEW.actor = 'DELIVERY_SYSTEM') OR
    (prior.state = 'PR_OPENED' AND NEW.state IN ('PR_MERGED','CLOSED_WITHOUT_DELIVERY') AND NEW.actor = 'DELIVERY_SYSTEM') OR
    (prior.state = 'PR_MERGED' AND NEW.state = 'DEPLOYMENT_VERIFIED' AND NEW.actor = 'OPERATOR')
  ) THEN RAISE EXCEPTION 'delivery transition refused'; END IF;
  -- What each recorded state must rest on.
  IF NEW.state = 'APPROVED_FOR_PR' AND NEW.detail->>'approvedPatchSha256' IS DISTINCT FROM delivery.patch_sha256 THEN
    RAISE EXCEPTION 'approval must bind the prepared patch';
  END IF;
  IF NEW.state = 'PR_OPENED' AND NOT EXISTS (
    SELECT 1 FROM growth_delivery_attempts a WHERE a.delivery_id = NEW.delivery_id AND a.state = 'SUCCEEDED'
      AND a.pr_number = (NEW.detail->>'prNumber')::int AND a.pr_url = NEW.detail->>'prUrl' AND a.commit_sha = NEW.detail->>'commitSha') THEN
    RAISE EXCEPTION 'an opened pull request must match a confirmed attempt';
  END IF;
  IF NEW.state = 'PR_MERGED' AND COALESCE(NEW.detail->>'mergeCommitSha', '') !~ '^[a-f0-9]{40}$' THEN
    RAISE EXCEPTION 'a merge must carry the merge commit GitHub reported';
  END IF;
  IF NEW.state = 'DEPLOYMENT_VERIFIED' AND (NEW.detail->>'provenance' IS DISTINCT FROM 'OPERATOR_ATTESTED'
      OR COALESCE(NEW.detail->>'url', '') !~ '^https?://' OR NEW.detail->>'observedAt' IS NULL) THEN
    RAISE EXCEPTION 'a deployment needs labelled evidence';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_delivery_event_guard ON growth_delivery_events;
CREATE TRIGGER growth_delivery_event_guard BEFORE INSERT ON growth_delivery_events FOR EACH ROW EXECUTE FUNCTION guard_growth_delivery_event();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['growth_delivery_targets','growth_deliveries','growth_delivery_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS growth_append_only ON %I', t);
    EXECUTE format('CREATE TRIGGER growth_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()', t);
  END LOOP;
END $$;

-- A delivery must be created with its first event in the same transaction.
CREATE OR REPLACE FUNCTION guard_growth_delivery_complete() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM growth_delivery_events WHERE delivery_id = NEW.id AND revision = 1) THEN
    RAISE EXCEPTION 'growth delivery requires its initial event';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_delivery_complete ON growth_deliveries;
CREATE CONSTRAINT TRIGGER growth_delivery_complete AFTER INSERT ON growth_deliveries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_growth_delivery_complete();

-- ---- the opportunity side ----

-- Opportunity events that move delivery name the delivery that justifies them.
ALTER TABLE growth_opportunity_events ADD COLUMN IF NOT EXISTS delivery_id UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'growth_opportunity_events_delivery') THEN
    ALTER TABLE growth_opportunity_events ADD CONSTRAINT growth_opportunity_events_delivery
      FOREIGN KEY (delivery_id, business_id) REFERENCES growth_deliveries(id, business_id);
  END IF;
END $$;

-- Mirrors GROWTH_TRANSITIONS in packages/contracts/src/growth.ts (P1 + P2).
-- Comparisons are null-safe: a NULL condition must refuse, never pass.
CREATE OR REPLACE FUNCTION guard_growth_event() RETURNS trigger AS $$
DECLARE prior growth_opportunity_events; opportunity growth_opportunities; delivery_state TEXT;
BEGIN
  SELECT * INTO opportunity FROM growth_opportunities WHERE id=NEW.opportunity_id AND business_id=NEW.business_id FOR UPDATE;
  IF NOT FOUND OR NOT record_member(NEW.business_id,NEW.user_id) THEN RAISE EXCEPTION 'growth event outside scope'; END IF;
  SELECT * INTO prior FROM growth_opportunity_events WHERE opportunity_id=NEW.opportunity_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision <> COALESCE(prior.revision,0)+1 THEN RAISE EXCEPTION 'stale growth revision'; END IF;
  IF NEW.delivery_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM growth_deliveries WHERE id=NEW.delivery_id AND opportunity_id=NEW.opportunity_id) THEN RAISE EXCEPTION 'delivery belongs to another opportunity'; END IF;
    delivery_state := growth_delivery_state(NEW.delivery_id);
  END IF;
  IF prior.id IS NULL THEN
    IF NEW.status NOT IN ('DISCOVERED','PROPOSED') OR NEW.actor <> opportunity.created_by_actor OR NEW.user_id <> opportunity.created_by_user_id OR NEW.delivery_id IS NOT NULL THEN RAISE EXCEPTION 'invalid initial growth event'; END IF;
  ELSIF NOT (
    (prior.status='DISCOVERED' AND NEW.status='PROPOSED' AND NEW.actor IN ('OPERATOR','ASSISTANT') AND NEW.delivery_id IS NULL) OR
    (prior.status='PROPOSED' AND NEW.status='APPROVED' AND NEW.actor='OPERATOR' AND NEW.delivery_id IS NULL) OR
    (prior.status IN ('DISCOVERED','PROPOSED','APPROVED') AND NEW.status='CANCELLED' AND NEW.actor='OPERATOR' AND NEW.delivery_id IS NULL) OR
    (prior.status='APPROVED' AND NEW.status='IN_DELIVERY' AND NEW.actor='DELIVERY_SYSTEM' AND delivery_state IS NOT DISTINCT FROM 'PR_OPENED') OR
    (prior.status='IN_DELIVERY' AND NEW.status='APPROVED' AND NEW.actor='DELIVERY_SYSTEM' AND delivery_state IS NOT DISTINCT FROM 'CLOSED_WITHOUT_DELIVERY') OR
    (prior.status='IN_DELIVERY' AND NEW.status='DELIVERED' AND NEW.actor='OPERATOR' AND delivery_state IS NOT DISTINCT FROM 'DEPLOYMENT_VERIFIED')
  ) THEN RAISE EXCEPTION 'growth transition refused'; END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- VERIFIED_ACTION evidence now has one authoritative source: a delivery whose
-- merge GitHub confirmed. MEASURED_OUTCOME stays refused until P3.
ALTER TABLE growth_opportunity_evidence DROP CONSTRAINT IF EXISTS growth_opportunity_evidence_check;
ALTER TABLE growth_opportunity_evidence DROP CONSTRAINT IF EXISTS growth_opportunity_evidence_check1;
ALTER TABLE growth_opportunity_evidence DROP CONSTRAINT IF EXISTS growth_evidence_reference_shape;
ALTER TABLE growth_opportunity_evidence ADD CONSTRAINT growth_evidence_reference_shape CHECK (
  (type IN ('OBSERVED','VERIFIED_ACTION','MEASURED_OUTCOME')) = (reference_kind IS NOT NULL AND reference_id IS NOT NULL)
  AND (type <> 'VERIFIED_ACTION' OR reference_kind = 'GROWTH_DELIVERY')
);
CREATE OR REPLACE FUNCTION guard_growth_evidence() RETURNS trigger AS $$
DECLARE author TEXT;
BEGIN
  SELECT created_by_actor INTO author FROM growth_opportunities WHERE id=NEW.opportunity_id AND business_id=NEW.business_id;
  IF NEW.type = 'MEASURED_OUTCOME' THEN RAISE EXCEPTION 'authoritative attachment required; unavailable in P2'; END IF;
  IF NEW.type = 'VERIFIED_ACTION' AND NOT EXISTS (
    SELECT 1 FROM growth_deliveries d JOIN growth_delivery_events e ON e.delivery_id = d.id AND e.state = 'PR_MERGED'
    WHERE d.id = NEW.reference_id AND d.opportunity_id = NEW.opportunity_id AND d.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'verified action requires a merge GitHub confirmed for this opportunity';
  END IF;
  IF (NEW.type='MODEL_SUGGESTION' AND author <> 'ASSISTANT') OR (NEW.type='OPERATOR_HYPOTHESIS' AND author <> 'OPERATOR') THEN RAISE EXCEPTION 'evidence authorship mismatch'; END IF;
  IF NEW.type='OBSERVED' AND NOT growth_observed_exists(NEW.business_id,NEW.reference_kind,NEW.reference_id) THEN RAISE EXCEPTION 'observed evidence outside scope or unavailable'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE UNIQUE INDEX IF NOT EXISTS growth_evidence_one_verified_action
  ON growth_opportunity_evidence(opportunity_id, reference_id) WHERE type = 'VERIFIED_ACTION';

CREATE OR REPLACE VIEW growth_opportunity_documents AS SELECT o.id, o.business_id, o.created_at,
  jsonb_build_object('id',o.id,'businessId',o.business_id,'goalId',o.goal_id,'title',o.title,'problemStatement',o.problem_statement,
    'audience',o.audience,'buyerIntent',o.buyer_intent,'targetUrl',o.target_url,'source',o.source,'proposedChange',o.proposed_change,
    'expectedMechanism',o.expected_mechanism,'assumptions',o.assumptions,'uncertainty',o.uncertainty,'baselineAvailability',o.baseline_availability,
    'ownerUserId',o.owner_user_id,'createdByUserId',o.created_by_user_id,'createdByActor',o.created_by_actor,'createdAt',o.created_at,
    'status',last_event.status,'revision',last_event.revision,'updatedAt',last_event.created_at,'updatedByUserId',last_event.user_id,
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'status',e.status,'revision',e.revision,'actor',e.actor,'userId',e.user_id,'reason',e.reason,'createdAt',e.created_at,'deliveryId',e.delivery_id) ORDER BY e.revision) FROM growth_opportunity_events e WHERE e.opportunity_id=o.id),'[]'::jsonb),
    'evidence',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'type',e.type,'note',e.note,'createdAt',e.created_at) ||
      CASE WHEN e.reference_kind IS NOT NULL THEN jsonb_build_object('reference',jsonb_build_object('kind',e.reference_kind,'id',e.reference_id)) ELSE '{}'::jsonb END ORDER BY e.created_at,e.id) FROM growth_opportunity_evidence e WHERE e.opportunity_id=o.id),'[]'::jsonb)) AS document
  FROM growth_opportunities o JOIN LATERAL (SELECT * FROM growth_opportunity_events e WHERE e.opportunity_id=o.id ORDER BY revision DESC LIMIT 1) last_event ON true;

CREATE OR REPLACE VIEW growth_delivery_documents AS SELECT d.id, d.business_id, d.opportunity_id, d.created_at,
  jsonb_build_object('id',d.id,'businessId',d.business_id,'opportunityId',d.opportunity_id,'targetId',d.target_id,
    'owner',t.owner,'repository',t.repository,'filePath',d.file_path,'baseBranch',d.base_branch,'baseCommitSha',d.base_commit_sha,
    'baseBlobSha',d.base_blob_sha,'beforeSha256',d.before_sha256,'afterSha256',d.after_sha256,'afterBlobSha',d.after_blob_sha,
    'patchSha256',d.patch_sha256,'edits',d.edits,'diff',d.diff,'rationale',d.rationale,'assumptions',d.assumptions,
    'proposedBy',d.proposed_by,'createdByUserId',d.created_by_user_id,'createdAt',d.created_at,
    'state',last_event.state,'revision',last_event.revision,
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'state',e.state,'revision',e.revision,'actor',e.actor,'userId',e.user_id,
      'reason',e.reason,'detail',e.detail,'createdAt',e.created_at) ORDER BY e.revision) FROM growth_delivery_events e WHERE e.delivery_id=d.id),'[]'::jsonb),
    'attempts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'state',a.state,'headBranch',a.head_branch,'commitSha',a.commit_sha,
      'prNumber',a.pr_number,'prUrl',a.pr_url,'failureCode',a.failure_code,'failureDetail',a.failure_detail,'createdAt',a.created_at,'updatedAt',a.updated_at)
      ORDER BY a.created_at) FROM growth_delivery_attempts a WHERE a.delivery_id=d.id),'[]'::jsonb)) AS document
  FROM growth_deliveries d JOIN growth_delivery_targets t ON t.id=d.target_id AND t.business_id=d.business_id
  JOIN LATERAL (SELECT * FROM growth_delivery_events e WHERE e.delivery_id=d.id ORDER BY revision DESC LIMIT 1) last_event ON true;
