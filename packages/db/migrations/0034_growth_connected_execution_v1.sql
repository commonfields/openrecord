-- W7: connected execution. One exact, human-authorized website change is carried
-- out through a provider (GitHub first) and reconciled. This is NOT the
-- preserved W2 delivery schema (the old 0031 must never be replayed): the
-- initiative's human lifecycle (growth_opportunity_events) gains no provider
-- states; execution has its own append-only lifecycle.
--
-- Three facts stay separate and are stored separately:
--   request accepted        growth_execution_events / evidence (PR_OPENED)
--   provider action verified evidence PR_MERGE_CONFIRMED + one SYSTEM_VERIFIED
--                            intervention linked to the initiative
--   live change observed     growth_execution_live_checks
-- Business impact is never stored here.
--
-- Replay-safe: every statement is idempotent. The migration runner executes the
-- whole file as one implicit transaction, so an incompatible database is
-- refused before anything is installed. Credentials never live here.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='growth_reports') THEN
    RAISE EXCEPTION 'W7 requires the W5 report tables; run 0033 before 0034';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='growth_opportunity_events' AND column_name='delivery_id')
     OR EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('growth_deliveries','growth_delivery_events','growth_delivery_targets')) THEN
    RAISE EXCEPTION 'old 0031 delivery artifacts detected; the preserved 0031 must never be replayed over W7';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION growth_execution_html_path(p TEXT) RETURNS BOOLEAN AS $$
  SELECT p IS NOT NULL AND length(p) BETWEEN 1 AND 300
    AND p ~ '^([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$'
    AND p ~* '\.html?$'
$$ LANGUAGE sql IMMUTABLE;

-- Repositories an operator explicitly connected to a business. A website URL
-- never implies one. The API and the worker additionally require the
-- repository on the server's allowlist for this account.
CREATE TABLE IF NOT EXISTS growth_execution_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'GITHUB'),
  owner TEXT NOT NULL CHECK (owner ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  repository TEXT NOT NULL CHECK (repository ~ '^[A-Za-z0-9._-]{1,100}$' AND repository NOT IN ('.', '..')),
  base_branch TEXT NOT NULL CHECK (base_branch ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$' AND base_branch !~ '\.\.|//|/$|\.lock$'),
  site_target_id UUID NOT NULL REFERENCES site_targets(id),
  allowed_paths TEXT[] NOT NULL CHECK (cardinality(allowed_paths) BETWEEN 1 AND 20),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id), UNIQUE (business_id, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS growth_execution_targets_repo ON growth_execution_targets(business_id, lower(owner), lower(repository));

CREATE OR REPLACE FUNCTION guard_growth_execution_target() RETURNS trigger AS $$
DECLARE entry TEXT;
BEGIN
  IF NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'execution target author must be account member'; END IF;
  IF lower(NEW.owner || '/' || NEW.repository) = 'commonfields/openrecord' THEN RAISE EXCEPTION 'OpenRecord''s own repository is never an execution target'; END IF;
  IF NOT EXISTS (SELECT 1 FROM site_targets s WHERE s.id = NEW.site_target_id AND s.business_id = NEW.business_id) THEN RAISE EXCEPTION 'execution target site must belong to the business'; END IF;
  FOREACH entry IN ARRAY NEW.allowed_paths LOOP
    IF NOT ((entry ~ '/$' AND entry ~ '^([A-Za-z0-9_-][A-Za-z0-9_.-]*/)+$') OR growth_execution_html_path(entry)) THEN
      RAISE EXCEPTION 'execution target path outside the supported page scope';
    END IF;
  END LOOP;
  -- One account per repository: another account's connection is refused, not shared.
  IF EXISTS (SELECT 1 FROM growth_execution_targets t JOIN businesses tb ON tb.id = t.business_id JOIN businesses nb ON nb.id = NEW.business_id
             WHERE lower(t.owner) = lower(NEW.owner) AND lower(t.repository) = lower(NEW.repository) AND tb.account_id <> nb.account_id) THEN
    RAISE EXCEPTION 'repository is connected to another account';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_execution_target_guard ON growth_execution_targets;
CREATE TRIGGER growth_execution_target_guard BEFORE INSERT ON growth_execution_targets FOR EACH ROW EXECUTE FUNCTION guard_growth_execution_target();

CREATE OR REPLACE FUNCTION growth_opportunity_status(o UUID) RETURNS TEXT AS $$
  SELECT status FROM growth_opportunity_events WHERE opportunity_id = o ORDER BY revision DESC LIMIT 1
$$ LANGUAGE sql STABLE;

-- One exact proposed change. Immutable: a different change is a new operation.
-- patch_sha256 binds repository, branch, base commit, page, live page and the
-- before/after bytes; authorization binds to it and the pull request commits
-- exactly after_content.
CREATE TABLE IF NOT EXISTS growth_execution_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  target_id UUID NOT NULL,
  action_kind TEXT NOT NULL CHECK (action_kind = 'REMOVE_NOINDEX_META'),
  file_path TEXT NOT NULL CHECK (growth_execution_html_path(file_path)),
  live_url TEXT NOT NULL CHECK (live_url ~ '^https?://[^[:space:]]+$' AND length(live_url) <= 2000),
  site_finding_id UUID REFERENCES site_findings(id),
  base_branch TEXT NOT NULL,
  base_commit_sha TEXT NOT NULL CHECK (base_commit_sha ~ '^[a-f0-9]{40}$'),
  base_blob_sha TEXT NOT NULL CHECK (base_blob_sha ~ '^[a-f0-9]{40}$'),
  after_blob_sha TEXT NOT NULL CHECK (after_blob_sha ~ '^[a-f0-9]{40}$'),
  before_sha256 TEXT NOT NULL CHECK (before_sha256 ~ '^[a-f0-9]{64}$'),
  after_sha256 TEXT NOT NULL CHECK (after_sha256 ~ '^[a-f0-9]{64}$' AND after_sha256 <> before_sha256),
  patch_sha256 TEXT NOT NULL CHECK (patch_sha256 ~ '^[a-f0-9]{64}$'),
  after_content TEXT NOT NULL CHECK (octet_length(after_content) <= 256000),
  diff TEXT NOT NULL CHECK (octet_length(diff) <= 600000),
  rationale TEXT NOT NULL CHECK (length(trim(rationale)) BETWEEN 1 AND 2000),
  proposed_by TEXT NOT NULL CHECK (proposed_by IN ('OPERATOR', 'ASSISTANT')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id), UNIQUE (business_id, request_key),
  FOREIGN KEY (opportunity_id, business_id) REFERENCES growth_opportunities(id, business_id),
  FOREIGN KEY (target_id, business_id) REFERENCES growth_execution_targets(id, business_id)
);
CREATE INDEX IF NOT EXISTS growth_execution_operations_opportunity ON growth_execution_operations(opportunity_id, created_at DESC);

-- Append-only lifecycle of one operation. detail carries what the transition
-- rests on.
CREATE TABLE IF NOT EXISTS growth_execution_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL,
  business_id UUID NOT NULL,
  revision INT NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('PREPARED','AUTHORIZED','DISPATCHING','AWAITING_MERGE','RECONCILING','VERIFIED','FAILED','BLOCKED','UNKNOWN','CANCELLED')),
  actor TEXT NOT NULL CHECK (actor IN ('OPERATOR','ASSISTANT','EXECUTION_SYSTEM')),
  user_id UUID REFERENCES users(id),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  request_key UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((actor = 'EXECUTION_SYSTEM') = (user_id IS NULL)),
  UNIQUE (operation_id, revision), UNIQUE (operation_id, request_key),
  FOREIGN KEY (operation_id, business_id) REFERENCES growth_execution_operations(id, business_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE OR REPLACE FUNCTION growth_execution_state(o UUID) RETURNS TEXT AS $$
  SELECT state FROM growth_execution_events WHERE operation_id = o ORDER BY revision DESC LIMIT 1
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION guard_growth_execution_operation() RETURNS trigger AS $$
DECLARE target growth_execution_targets; site site_targets; finding site_findings; path_after_origin TEXT;
BEGIN
  IF NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'execution author must be account member'; END IF;
  IF growth_opportunity_status(NEW.opportunity_id) IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'execution requires an approved initiative'; END IF;
  SELECT * INTO target FROM growth_execution_targets WHERE id = NEW.target_id AND business_id = NEW.business_id;
  IF NOT FOUND OR NEW.base_branch IS DISTINCT FROM target.base_branch THEN RAISE EXCEPTION 'execution target or base branch mismatch'; END IF;
  IF NOT EXISTS (SELECT 1 FROM unnest(target.allowed_paths) a WHERE (a ~ '/$' AND starts_with(NEW.file_path, a)) OR NEW.file_path = a) THEN
    RAISE EXCEPTION 'execution page is not allowed on this repository';
  END IF;
  -- The live page must sit inside the registered website of this target.
  SELECT * INTO site FROM site_targets WHERE id = target.site_target_id AND business_id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'execution site missing'; END IF;
  IF NOT (NEW.live_url = site.canonical_origin OR starts_with(NEW.live_url, site.canonical_origin || '/')) THEN RAISE EXCEPTION 'live page outside the registered website'; END IF;
  path_after_origin := substr(NEW.live_url, length(site.canonical_origin) + 1);
  IF NOT starts_with(CASE WHEN path_after_origin = '' THEN '/' ELSE path_after_origin END, site.path_prefix) THEN RAISE EXCEPTION 'live page outside the registered website scope'; END IF;
  IF NEW.site_finding_id IS NOT NULL THEN
    SELECT * INTO finding FROM site_findings WHERE id = NEW.site_finding_id AND business_id = NEW.business_id AND site_target_id = site.id;
    IF NOT FOUND OR finding.finding_kind <> 'BLOCKED_BY_META' OR (finding.url <> NEW.live_url AND finding.canonical_url <> NEW.live_url) THEN
      RAISE EXCEPTION 'finding does not describe this page';
    END IF;
  END IF;
  -- One unsettled operation per page.
  IF EXISTS (SELECT 1 FROM growth_execution_operations o WHERE o.business_id = NEW.business_id AND o.target_id = NEW.target_id AND o.file_path = NEW.file_path
      AND growth_execution_state(o.id) IN ('PREPARED','AUTHORIZED','DISPATCHING','AWAITING_MERGE','RECONCILING','UNKNOWN')) THEN
    RAISE EXCEPTION 'another unsettled execution already covers this page';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_execution_operation_guard ON growth_execution_operations;
CREATE TRIGGER growth_execution_operation_guard BEFORE INSERT ON growth_execution_operations FOR EACH ROW EXECUTE FUNCTION guard_growth_execution_operation();

-- Provider facts, append-only. The execution system records what the provider
-- reported; the shape checks below make a claim that contradicts the
-- authorization or the stored operation fail even through direct SQL.
CREATE TABLE IF NOT EXISTS growth_execution_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL,
  business_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BRANCH_READY','COMMIT_CREATED','PR_OPENED','PR_OBSERVED_OPEN','PR_CLOSED_UNMERGED','PR_CONTENT_CHANGED','PR_MERGE_CONFIRMED','DISPATCH_UNCERTAIN')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id, business_id) REFERENCES growth_execution_operations(id, business_id)
);
CREATE INDEX IF NOT EXISTS growth_execution_evidence_operation ON growth_execution_evidence(operation_id, observed_at);
-- A pull request opened for one operation is one fact.
CREATE UNIQUE INDEX IF NOT EXISTS growth_execution_evidence_one_pr ON growth_execution_evidence(operation_id) WHERE kind = 'PR_OPENED';
CREATE UNIQUE INDEX IF NOT EXISTS growth_execution_evidence_one_merge ON growth_execution_evidence(operation_id) WHERE kind = 'PR_MERGE_CONFIRMED';

CREATE OR REPLACE FUNCTION guard_growth_execution_evidence() RETURNS trigger AS $$
DECLARE op growth_execution_operations; target growth_execution_targets; st TEXT; opened growth_execution_evidence; branch TEXT;
BEGIN
  SELECT * INTO op FROM growth_execution_operations WHERE id = NEW.operation_id AND business_id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'execution evidence outside scope'; END IF;
  SELECT * INTO target FROM growth_execution_targets WHERE id = op.target_id AND business_id = op.business_id;
  st := growth_execution_state(NEW.operation_id);
  branch := 'openrecord/exec-' || op.id::text;
  IF NEW.kind IN ('BRANCH_READY','COMMIT_CREATED','PR_OPENED','DISPATCH_UNCERTAIN') AND st NOT IN ('DISPATCHING','UNKNOWN') THEN RAISE EXCEPTION 'dispatch evidence requires a dispatching operation'; END IF;
  IF NEW.kind IN ('PR_OBSERVED_OPEN','PR_CLOSED_UNMERGED','PR_CONTENT_CHANGED') AND st NOT IN ('AWAITING_MERGE','RECONCILING') THEN RAISE EXCEPTION 'review evidence requires a pull request awaiting merge'; END IF;
  IF NEW.kind = 'PR_MERGE_CONFIRMED' AND st <> 'RECONCILING' THEN RAISE EXCEPTION 'a merge is confirmed only while reconciling'; END IF;
  IF NEW.kind = 'PR_OPENED' THEN
    IF NEW.detail->>'headRef' IS DISTINCT FROM branch OR COALESCE(NEW.detail->>'prUrl','') !~ '^https://[^[:space:]]+/pull/[0-9]+$'
       OR COALESCE(NEW.detail->>'prNumber','') !~ '^[0-9]+$' OR COALESCE(NEW.detail->>'headSha','') !~ '^[a-f0-9]{40}$'
       OR lower(COALESCE(NEW.detail->>'baseRepository','')) <> lower(target.owner || '/' || target.repository) OR NEW.detail->>'baseRef' IS DISTINCT FROM op.base_branch THEN
      RAISE EXCEPTION 'an opened pull request must name this operation''s branch, repository and base';
    END IF;
  END IF;
  IF NEW.kind = 'PR_MERGE_CONFIRMED' THEN
    SELECT * INTO opened FROM growth_execution_evidence WHERE operation_id = NEW.operation_id AND kind = 'PR_OPENED';
    IF opened.id IS NULL THEN RAISE EXCEPTION 'a merge needs the pull request that was opened'; END IF;
    IF NEW.detail->>'prNumber' IS DISTINCT FROM opened.detail->>'prNumber' OR NEW.detail->>'prUrl' IS DISTINCT FROM opened.detail->>'prUrl'
       OR NEW.detail->>'headRef' IS DISTINCT FROM branch OR NEW.detail->>'baseRef' IS DISTINCT FROM op.base_branch
       OR lower(COALESCE(NEW.detail->>'baseRepository','')) <> lower(target.owner || '/' || target.repository)
       OR COALESCE(NEW.detail->>'mergeCommitSha','') !~ '^[a-f0-9]{40}$' OR COALESCE(NEW.detail->>'mergedAt','') = ''
       OR NEW.detail->>'mergedBlobSha' IS DISTINCT FROM op.after_blob_sha
       OR NEW.detail->'changedPaths' IS DISTINCT FROM to_jsonb(ARRAY[op.file_path])
       OR NEW.detail->>'headSha' IS DISTINCT FROM opened.detail->>'headSha' THEN
      RAISE EXCEPTION 'merge evidence contradicts the authorized change';
    END IF;
    PERFORM (NEW.detail->>'mergedAt')::timestamptz;
  END IF;
  NEW.observed_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_execution_evidence_guard ON growth_execution_evidence;
CREATE TRIGGER growth_execution_evidence_guard BEFORE INSERT ON growth_execution_evidence FOR EACH ROW EXECUTE FUNCTION guard_growth_execution_evidence();

-- Live re-observation of the configured page: a different fact from the merge.
CREATE TABLE IF NOT EXISTS growth_execution_live_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL,
  business_id UUID NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('CHANGE_OBSERVED','CHANGE_NOT_OBSERVED','INCONCLUSIVE')),
  url TEXT NOT NULL,
  http_status INT,
  detail TEXT NOT NULL CHECK (length(detail) BETWEEN 1 AND 500),
  body_digest TEXT CHECK (body_digest IS NULL OR body_digest ~ '^[a-f0-9]{64}$'),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id, business_id) REFERENCES growth_execution_operations(id, business_id)
);
CREATE INDEX IF NOT EXISTS growth_execution_live_checks_operation ON growth_execution_live_checks(operation_id, checked_at DESC);
CREATE OR REPLACE FUNCTION guard_growth_execution_live_check() RETURNS trigger AS $$
DECLARE op growth_execution_operations;
BEGIN
  SELECT * INTO op FROM growth_execution_operations WHERE id = NEW.operation_id AND business_id = NEW.business_id;
  IF NOT FOUND OR NEW.url IS DISTINCT FROM op.live_url THEN RAISE EXCEPTION 'live check must observe the authorized page'; END IF;
  IF growth_execution_state(NEW.operation_id) IS DISTINCT FROM 'VERIFIED' THEN RAISE EXCEPTION 'live observation follows a verified merge'; END IF;
  NEW.checked_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_execution_live_check_guard ON growth_execution_live_checks;
CREATE TRIGGER growth_execution_live_check_guard BEFORE INSERT ON growth_execution_live_checks FOR EACH ROW EXECUTE FUNCTION guard_growth_execution_live_check();

-- Durable work: dispatch, reconcile and live-check jobs. Mutable scheduling
-- state only; no provider fact lives here. At most one open job per operation
-- and kind, so one operation is carried out by one worker at a time.
CREATE TABLE IF NOT EXISTS growth_execution_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id UUID NOT NULL,
  business_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('DISPATCH','RECONCILE','LIVE_CHECK')),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','CLAIMED','DONE')),
  request_key UUID,
  not_before TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 200),
  requested_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (operation_id, business_id) REFERENCES growth_execution_operations(id, business_id),
  CHECK ((status = 'CLAIMED') = (claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS growth_execution_jobs_one_open ON growth_execution_jobs(operation_id, kind) WHERE status IN ('QUEUED','CLAIMED');
CREATE UNIQUE INDEX IF NOT EXISTS growth_execution_jobs_request ON growth_execution_jobs(operation_id, kind, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS growth_execution_jobs_ready ON growth_execution_jobs(not_before) WHERE status IN ('QUEUED','CLAIMED');

CREATE OR REPLACE FUNCTION guard_growth_execution_job() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'growth_execution_jobs keep their history'; END IF;
  IF TG_OP = 'INSERT' THEN
    st := growth_execution_state(NEW.operation_id);
    IF NEW.status <> 'QUEUED' THEN RAISE EXCEPTION 'jobs start QUEUED'; END IF;
    IF (NEW.kind = 'DISPATCH' AND st IS DISTINCT FROM 'DISPATCHING') OR (NEW.kind = 'RECONCILE' AND st NOT IN ('AWAITING_MERGE','RECONCILING','UNKNOWN'))
       OR (NEW.kind = 'LIVE_CHECK' AND st IS DISTINCT FROM 'VERIFIED') THEN RAISE EXCEPTION 'job does not fit the operation state'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.operation_id, NEW.business_id, NEW.kind, NEW.request_key, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.operation_id, OLD.business_id, OLD.kind, OLD.request_key, OLD.created_at) THEN
    RAISE EXCEPTION 'job identity is immutable';
  END IF;
  IF OLD.status = 'DONE' THEN RAISE EXCEPTION 'a finished job cannot change'; END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_execution_job_guard ON growth_execution_jobs;
CREATE TRIGGER growth_execution_job_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_execution_jobs FOR EACH ROW EXECUTE FUNCTION guard_growth_execution_job();

-- Mirrors EXECUTION_TRANSITIONS in packages/contracts/src/growth-execution.ts.
CREATE OR REPLACE FUNCTION guard_growth_execution_event() RETURNS trigger AS $$
DECLARE prior growth_execution_events; op growth_execution_operations; auth growth_execution_events; receipts INT; linked INT;
BEGIN
  SELECT * INTO op FROM growth_execution_operations WHERE id = NEW.operation_id AND business_id = NEW.business_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'execution event outside scope'; END IF;
  IF NEW.user_id IS NOT NULL AND NOT record_member(NEW.business_id, NEW.user_id) THEN RAISE EXCEPTION 'execution actor must be an account member'; END IF;
  SELECT * INTO prior FROM growth_execution_events WHERE operation_id = NEW.operation_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision <> COALESCE(prior.revision, 0) + 1 THEN RAISE EXCEPTION 'stale execution revision'; END IF;
  IF prior.id IS NULL THEN
    IF NEW.state <> 'PREPARED' OR NEW.actor IS DISTINCT FROM op.proposed_by OR NEW.user_id IS DISTINCT FROM op.created_by_user_id THEN RAISE EXCEPTION 'invalid initial execution event'; END IF;
  ELSIF NOT (
    (prior.state = 'PREPARED' AND NEW.state IN ('AUTHORIZED','CANCELLED') AND NEW.actor = 'OPERATOR') OR
    (prior.state = 'AUTHORIZED' AND NEW.state IN ('CANCELLED','DISPATCHING') AND NEW.actor = 'OPERATOR') OR
    (prior.state = 'AUTHORIZED' AND NEW.state = 'BLOCKED' AND NEW.actor = 'EXECUTION_SYSTEM') OR
    (prior.state = 'DISPATCHING' AND NEW.state IN ('AWAITING_MERGE','UNKNOWN','FAILED','BLOCKED') AND NEW.actor = 'EXECUTION_SYSTEM') OR
    (prior.state = 'UNKNOWN' AND NEW.state IN ('DISPATCHING','AWAITING_MERGE','FAILED','BLOCKED') AND NEW.actor = 'EXECUTION_SYSTEM') OR
    (prior.state = 'AWAITING_MERGE' AND NEW.state IN ('RECONCILING','FAILED','BLOCKED') AND NEW.actor = 'EXECUTION_SYSTEM') OR
    (prior.state = 'RECONCILING' AND NEW.state IN ('AWAITING_MERGE','VERIFIED','BLOCKED','FAILED') AND NEW.actor = 'EXECUTION_SYSTEM')
  ) THEN RAISE EXCEPTION 'execution transition refused'; END IF;
  -- The initiative row is locked before its status is read, so a final review
  -- or cancellation that is committing serializes with an authorization or a
  -- dispatch: whichever comes second sees the other.
  IF NEW.state IN ('AUTHORIZED','DISPATCHING') AND (prior.state IS DISTINCT FROM 'UNKNOWN') THEN
    PERFORM 1 FROM growth_opportunities WHERE id = op.opportunity_id AND business_id = op.business_id FOR UPDATE;
  END IF;
  -- What each recorded state must rest on.
  IF NEW.state = 'AUTHORIZED' THEN
    IF NEW.detail->>'approvedPatchSha256' IS DISTINCT FROM op.patch_sha256 THEN RAISE EXCEPTION 'authorization must bind the prepared patch'; END IF;
    IF growth_opportunity_status(op.opportunity_id) IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'authorization requires an approved initiative'; END IF;
    IF NEW.detail->>'expiresAt' IS NULL OR (NEW.detail->>'expiresAt')::timestamptz <= clock_timestamp() THEN RAISE EXCEPTION 'authorization needs a future expiry'; END IF;
  END IF;
  IF NEW.state = 'DISPATCHING' AND prior.state = 'AUTHORIZED' THEN
    IF growth_opportunity_status(op.opportunity_id) IS DISTINCT FROM 'APPROVED' THEN RAISE EXCEPTION 'dispatch requires an approved initiative'; END IF;
    IF (prior.detail->>'expiresAt')::timestamptz <= clock_timestamp() THEN RAISE EXCEPTION 'authorization expired'; END IF;
  END IF;
  IF NEW.state = 'DISPATCHING' AND prior.state = 'UNKNOWN' AND COALESCE(NEW.detail->>'providerChecked','') <> 'true' THEN
    RAISE EXCEPTION 'a retry follows a provider reconciliation that found no pull request';
  END IF;
  IF NEW.state = 'AWAITING_MERGE' AND prior.state IN ('DISPATCHING','UNKNOWN') AND NOT EXISTS (
      SELECT 1 FROM growth_execution_evidence e WHERE e.operation_id = NEW.operation_id AND e.kind = 'PR_OPENED') THEN
    RAISE EXCEPTION 'awaiting merge needs the opened pull request';
  END IF;
  IF NEW.state = 'RECONCILING' AND COALESCE(NEW.detail->>'mergeObserved','') <> 'true' THEN RAISE EXCEPTION 'reconciling follows an observed merge'; END IF;
  IF NEW.state IN ('FAILED','BLOCKED') AND prior.state IS NOT NULL AND COALESCE(NEW.detail->>'code','') = '' THEN RAISE EXCEPTION 'a stop needs its code'; END IF;
  IF NEW.state = 'FAILED' AND NEW.detail->>'code' = 'PR_CLOSED_WITHOUT_MERGE' AND NOT EXISTS (
      SELECT 1 FROM growth_execution_evidence e WHERE e.operation_id = NEW.operation_id AND e.kind = 'PR_CLOSED_UNMERGED') THEN
    RAISE EXCEPTION 'a closed pull request needs its evidence';
  END IF;
  IF NEW.state = 'VERIFIED' THEN
    IF NOT EXISTS (SELECT 1 FROM growth_execution_evidence e WHERE e.operation_id = NEW.operation_id AND e.kind = 'PR_MERGE_CONFIRMED') THEN RAISE EXCEPTION 'verification needs the confirmed merge'; END IF;
    SELECT count(*) INTO receipts FROM interventions i WHERE i.business_id = NEW.business_id AND i.verification_kind = 'GROWTH_DELIVERY' AND i.verification_id = NEW.operation_id;
    SELECT count(*) INTO linked FROM growth_initiative_actions a JOIN interventions i ON i.id = a.intervention_id AND i.business_id = a.business_id
      WHERE a.opportunity_id = op.opportunity_id AND a.business_id = NEW.business_id AND i.verification_kind = 'GROWTH_DELIVERY' AND i.verification_id = NEW.operation_id;
    IF receipts <> 1 OR linked <> 1 THEN RAISE EXCEPTION 'verification needs exactly one receipt linked to the initiative'; END IF;
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_execution_event_guard ON growth_execution_events;
CREATE TRIGGER growth_execution_event_guard BEFORE INSERT ON growth_execution_events FOR EACH ROW EXECUTE FUNCTION guard_growth_execution_event();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['growth_execution_targets','growth_execution_operations','growth_execution_events','growth_execution_evidence','growth_execution_live_checks'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS growth_execution_append_only ON %I', t);
    EXECUTE format('CREATE TRIGGER growth_execution_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS growth_execution_no_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER growth_execution_no_truncate BEFORE TRUNCATE ON %I EXECUTE FUNCTION prevent_append_only_mutation()', t);
  END LOOP;
END $$;

-- An operation is created with its first event in the same transaction.
CREATE OR REPLACE FUNCTION guard_growth_execution_complete() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM growth_execution_events WHERE operation_id = NEW.id AND revision = 1) THEN
    RAISE EXCEPTION 'growth execution requires its initial event';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_execution_complete ON growth_execution_operations;
CREATE CONSTRAINT TRIGGER growth_execution_complete AFTER INSERT ON growth_execution_operations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_growth_execution_complete();

-- ---- the verification contract (replaces the W0 placeholder) ----
-- A SYSTEM_VERIFIED / GROWTH_DELIVERY / PR_MERGED intervention is valid only
-- when it describes exactly the authorized operation: the operation's patch
-- was authorized by a person, the provider confirmed a merge of that change in
-- the connected repository, and the intervention's time, target and digests
-- are the merged pull request's. The function signature is unchanged and no
-- caller-supplied flag exists. A merge says nothing about deployment.
CREATE OR REPLACE FUNCTION growth_execution_verified(execution interventions) RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM growth_execution_operations o
    JOIN growth_execution_evidence m ON m.operation_id = o.id AND m.kind = 'PR_MERGE_CONFIRMED'
    JOIN growth_execution_evidence p ON p.operation_id = o.id AND p.kind = 'PR_OPENED'
    WHERE o.id = execution.verification_id AND o.business_id = execution.business_id
      AND growth_execution_state(o.id) IN ('RECONCILING','VERIFIED')
      AND EXISTS (SELECT 1 FROM growth_execution_events a WHERE a.operation_id = o.id AND a.state = 'AUTHORIZED' AND a.actor = 'OPERATOR'
                    AND a.detail->>'approvedPatchSha256' = o.patch_sha256)
      AND execution.type = 'SOURCE_UPDATED' AND execution.channel = 'WEBSITE' AND execution.actor = 'SYSTEM' AND execution.actor_id IS NULL
      AND execution.supersedes_id IS NULL
      AND execution.verification_kind = 'GROWTH_DELIVERY' AND execution.verification_claim = 'PR_MERGED'
      AND execution.target = p.detail->>'prUrl' AND execution.target = m.detail->>'prUrl'
      AND execution.performed_at = (m.detail->>'mergedAt')::timestamptz
      AND execution.evidence_before_digest = o.before_sha256 AND execution.evidence_after_digest = o.after_sha256
  )
$$ LANGUAGE sql STABLE;
-- One operation yields at most one system receipt.
CREATE UNIQUE INDEX IF NOT EXISTS interventions_one_growth_delivery_receipt ON interventions(verification_id) WHERE verification_kind = 'GROWTH_DELIVERY';

-- ---- the initiative side: unresolved execution holds the final decision ----
-- Identical to the W0 guard except for one added refusal: an initiative cannot
-- be reviewed or cancelled while an external action may be in progress, so a
-- decision can never pretend that it prevented the action.
CREATE OR REPLACE FUNCTION guard_growth_event() RETURNS trigger AS $$
DECLARE prior growth_opportunity_events; opportunity growth_opportunities;
BEGIN
  SELECT * INTO opportunity FROM growth_opportunities WHERE id=NEW.opportunity_id AND business_id=NEW.business_id FOR UPDATE;
  IF NOT FOUND OR NOT record_member(NEW.business_id,NEW.user_id) THEN RAISE EXCEPTION 'growth event outside scope'; END IF;
  SELECT * INTO prior FROM growth_opportunity_events WHERE opportunity_id=NEW.opportunity_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision <> COALESCE(prior.revision,0)+1 THEN RAISE EXCEPTION 'stale growth revision'; END IF;
  IF prior.id IS NULL THEN
    IF NEW.status NOT IN ('DISCOVERED','PROPOSED') OR NEW.actor <> opportunity.created_by_actor OR NEW.user_id <> opportunity.created_by_user_id THEN RAISE EXCEPTION 'invalid initial growth event'; END IF;
  ELSIF NOT (
    (prior.status='DISCOVERED' AND NEW.status='PROPOSED' AND NEW.actor IN ('OPERATOR','ASSISTANT')) OR
    (prior.status='PROPOSED' AND NEW.status='APPROVED' AND NEW.actor='OPERATOR') OR
    (prior.status='APPROVED' AND NEW.status='REVIEWED' AND NEW.actor='OPERATOR') OR
    (prior.status IN ('DISCOVERED','PROPOSED','APPROVED') AND NEW.status='CANCELLED' AND NEW.actor='OPERATOR')
  ) THEN RAISE EXCEPTION 'growth transition refused'; END IF;
  IF NEW.status IN ('REVIEWED','CANCELLED') AND EXISTS (
      SELECT 1 FROM growth_execution_operations o WHERE o.opportunity_id = NEW.opportunity_id AND o.business_id = NEW.business_id
        AND growth_execution_state(o.id) IN ('DISPATCHING','AWAITING_MERGE','RECONCILING','UNKNOWN')) THEN
    RAISE EXCEPTION 'execution unresolved';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

-- ---- read models ----
CREATE OR REPLACE VIEW growth_execution_target_documents AS SELECT t.id, t.business_id, t.created_at,
  jsonb_build_object('id',t.id,'businessId',t.business_id,'provider',t.provider,'owner',t.owner,'repository',t.repository,'baseBranch',t.base_branch,
    'siteTargetId',t.site_target_id,'allowedPaths',to_jsonb(t.allowed_paths),'createdByUserId',t.created_by_user_id,'createdAt',t.created_at) AS document
  FROM growth_execution_targets t;

CREATE OR REPLACE VIEW growth_execution_documents AS SELECT o.id, o.business_id, o.opportunity_id, o.created_at,
  jsonb_build_object('id',o.id,'businessId',o.business_id,'opportunityId',o.opportunity_id,'targetId',o.target_id,'owner',t.owner,'repository',t.repository,
    'baseBranch',o.base_branch,'actionKind',o.action_kind,'filePath',o.file_path,'liveUrl',o.live_url,'siteFindingId',o.site_finding_id,
    'baseCommitSha',o.base_commit_sha,'baseBlobSha',o.base_blob_sha,'beforeSha256',o.before_sha256,'afterSha256',o.after_sha256,'patchSha256',o.patch_sha256,
    'diff',o.diff,'rationale',o.rationale,'proposedBy',o.proposed_by,'createdByUserId',o.created_by_user_id,'createdAt',o.created_at,
    'state',last_event.state,'revision',last_event.revision,
    'events',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'state',e.state,'revision',e.revision,'actor',e.actor,'userId',e.user_id,
      'reason',e.reason,'detail',e.detail,'createdAt',e.created_at) ORDER BY e.revision) FROM growth_execution_events e WHERE e.operation_id=o.id),'[]'::jsonb),
    'evidence',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',v.id,'kind',v.kind,'detail',v.detail,'observedAt',v.observed_at) ORDER BY v.observed_at,v.id)
      FROM growth_execution_evidence v WHERE v.operation_id=o.id),'[]'::jsonb),
    'liveChecks',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',c.id,'result',c.result,'url',c.url,'httpStatus',c.http_status,'detail',c.detail,
      'bodyDigest',c.body_digest,'checkedAt',c.checked_at) ORDER BY c.checked_at DESC,c.id) FROM growth_execution_live_checks c WHERE c.operation_id=o.id),'[]'::jsonb),
    'receipt',(SELECT jsonb_build_object('interventionId',i.id,'claim',i.verification_claim,'mergedAt',i.performed_at,'mergeCommitSha',m.detail->>'mergeCommitSha','pullRequestUrl',i.target)
      FROM interventions i JOIN growth_initiative_actions a ON a.intervention_id=i.id AND a.business_id=i.business_id
      JOIN growth_execution_evidence m ON m.operation_id=o.id AND m.kind='PR_MERGE_CONFIRMED'
      WHERE i.verification_kind='GROWTH_DELIVERY' AND i.verification_id=o.id AND a.opportunity_id=o.opportunity_id LIMIT 1)) AS document
  FROM growth_execution_operations o JOIN growth_execution_targets t ON t.id=o.target_id AND t.business_id=o.business_id
  JOIN LATERAL (SELECT * FROM growth_execution_events e WHERE e.operation_id=o.id ORDER BY revision DESC LIMIT 1) last_event ON true;
