-- W8: authenticated, read-only GA4 measurement. One Google identity authorizes
-- read access for one account (a connection); an operator binds one GA4
-- property and key event to one immutable W0 metric definition (a binding);
-- durable jobs synchronize daily key-event counts. Each synchronized response
-- is stored as a W3 import with its own provenance, AUTHENTICATED_PROVIDER_API,
-- plus one observation row naming the connection, identity, property, key
-- event, requested window, collection time and response digest. W3 resolution,
-- W4 evaluation and W5 reports read those imports unchanged.
--
-- Additive and replay-safe: every statement is idempotent and nothing in
-- 0030/0032/0033/0034 is replaced. 0032's import guard keeps running; this file
-- adds separate triggers next to it. Credentials are stored only as AES-GCM
-- ciphertext (the format is checked here) and are erased on disconnect. The
-- old W2 0031 must never be replayed; a database carrying it is refused first.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='growth_execution_jobs') THEN
    RAISE EXCEPTION 'W8 requires the W7 execution tables; run 0034 before 0035';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='growth_opportunity_events' AND column_name='delivery_id')
     OR EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('growth_deliveries','growth_delivery_events','growth_delivery_targets')) THEN
    RAISE EXCEPTION 'old 0031 delivery artifacts detected; the preserved 0031 must never be replayed over W8';
  END IF;
END $$;

-- W3 provenance gains one value. Operator CSVs can never claim it: the import
-- route's schema accepts only the two original values, and the deferred guard
-- below requires a matching GA4 observation in the same transaction.
ALTER TABLE growth_metric_imports DROP CONSTRAINT IF EXISTS growth_metric_imports_provenance_check;
ALTER TABLE growth_metric_imports ADD CONSTRAINT growth_metric_imports_provenance_check
  CHECK (provenance IN ('OPERATOR_SUPPLIED_EXPORT','SYNTHETIC_FIXTURE','AUTHENTICATED_PROVIDER_API'));

CREATE OR REPLACE FUNCTION growth_ga4_ciphertext(v TEXT) RETURNS BOOLEAN AS $$
  SELECT v ~ '^v1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$'
$$ LANGUAGE sql IMMUTABLE;

-- A connection records who authorized read access. It is not proof that the
-- identity owns any property; bindings record the selected property separately.
CREATE TABLE IF NOT EXISTS growth_ga4_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  google_subject TEXT NOT NULL CHECK (google_subject ~ '^[0-9A-Za-z_-]{1,255}$'),
  google_email TEXT NOT NULL CHECK (length(google_email) BETWEEN 3 AND 320 AND position('@' in google_email) > 1),
  granted_scopes TEXT[] NOT NULL CHECK ('https://www.googleapis.com/auth/analytics.readonly' = ANY(granted_scopes)
    AND granted_scopes <@ ARRAY['openid','email','https://www.googleapis.com/auth/analytics.readonly','https://www.googleapis.com/auth/userinfo.email']),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','REAUTHORIZATION_REQUIRED','DISCONNECTED')),
  status_reason TEXT CHECK (status_reason IS NULL OR status_reason ~ '^[A-Z_]{1,64}$'),
  connected_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disconnected_at TIMESTAMPTZ,
  revocation_confirmed BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, account_id),
  UNIQUE (account_id, google_subject),
  CHECK ((status = 'DISCONNECTED') = (disconnected_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION guard_growth_ga4_connection() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ga4 connections keep their history'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM account_users WHERE account_id = NEW.account_id AND user_id = NEW.connected_by_user_id) THEN
      RAISE EXCEPTION 'ga4 connection author must be an account member';
    END IF;
    IF NEW.status <> 'ACTIVE' THEN RAISE EXCEPTION 'ga4 connections start ACTIVE'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.account_id, NEW.google_subject, NEW.created_at, NEW.connected_by_user_id) IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.google_subject, OLD.created_at, OLD.connected_by_user_id) THEN
    RAISE EXCEPTION 'ga4 connection identity is immutable';
  END IF;
  -- Back to ACTIVE only through a new authorization.
  IF NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE' AND NEW.last_authorized_at <= OLD.last_authorized_at THEN
    RAISE EXCEPTION 'ga4 connection reactivation requires a new authorization';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_ga4_connection_guard ON growth_ga4_connections;
CREATE TRIGGER growth_ga4_connection_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_ga4_connections FOR EACH ROW EXECUTE FUNCTION guard_growth_ga4_connection();

CREATE TABLE IF NOT EXISTS growth_ga4_connection_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  account_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('CONNECTED','REAUTHORIZED','AUTHORIZATION_FAILED','DISCONNECTED')),
  user_id UUID REFERENCES users(id),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, account_id) REFERENCES growth_ga4_connections(id, account_id)
);
CREATE INDEX IF NOT EXISTS growth_ga4_connection_events_connection ON growth_ga4_connection_events(connection_id, created_at);

-- Server-side credentials. Ciphertext only; the check refuses anything that is
-- not the cipher's envelope, so a plaintext token cannot be stored by mistake.
CREATE TABLE IF NOT EXISTS growth_ga4_credentials (
  connection_id UUID PRIMARY KEY,
  account_id UUID NOT NULL,
  refresh_ciphertext TEXT CHECK (refresh_ciphertext IS NULL OR growth_ga4_ciphertext(refresh_ciphertext)),
  access_ciphertext TEXT CHECK (access_ciphertext IS NULL OR growth_ga4_ciphertext(access_ciphertext)),
  access_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (connection_id, account_id) REFERENCES growth_ga4_connections(id, account_id),
  CHECK ((access_ciphertext IS NULL) = (access_expires_at IS NULL))
);

CREATE OR REPLACE FUNCTION guard_growth_ga4_credentials() RETURNS trigger AS $$
DECLARE st TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ga4 credentials are erased, not deleted'; END IF;
  SELECT status INTO st FROM growth_ga4_connections WHERE id = NEW.connection_id AND account_id = NEW.account_id;
  IF st = 'DISCONNECTED' AND (NEW.refresh_ciphertext IS NOT NULL OR NEW.access_ciphertext IS NOT NULL) THEN
    RAISE EXCEPTION 'a disconnected ga4 connection holds no credentials';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_ga4_credentials_guard ON growth_ga4_credentials;
CREATE TRIGGER growth_ga4_credentials_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_ga4_credentials FOR EACH ROW EXECUTE FUNCTION guard_growth_ga4_credentials();

-- Disconnecting erases the stored credentials in the same statement.
CREATE OR REPLACE FUNCTION erase_growth_ga4_credentials() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'DISCONNECTED' AND OLD.status <> 'DISCONNECTED' THEN
    UPDATE growth_ga4_credentials SET refresh_ciphertext = NULL, access_ciphertext = NULL, access_expires_at = NULL WHERE connection_id = NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_ga4_connection_erase ON growth_ga4_connections;
CREATE TRIGGER growth_ga4_connection_erase AFTER UPDATE ON growth_ga4_connections FOR EACH ROW EXECUTE FUNCTION erase_growth_ga4_credentials();

-- One pending authorization. Only the SHA-256 of the state is stored; the PKCE
-- verifier is encrypted. Single use, ten minutes, bound to the user and account
-- that started it.
CREATE TABLE IF NOT EXISTS growth_ga4_oauth_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  user_id UUID NOT NULL REFERENCES users(id),
  business_id UUID NOT NULL REFERENCES businesses(id),
  connection_id UUID,
  state_sha256 TEXT NOT NULL UNIQUE CHECK (state_sha256 ~ '^[a-f0-9]{64}$'),
  verifier_ciphertext TEXT NOT NULL CHECK (growth_ga4_ciphertext(verifier_ciphertext)),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  FOREIGN KEY (connection_id, account_id) REFERENCES growth_ga4_connections(id, account_id)
);
CREATE OR REPLACE FUNCTION guard_growth_ga4_oauth_state() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM account_users WHERE account_id = NEW.account_id AND user_id = NEW.user_id)
       OR NOT EXISTS (SELECT 1 FROM businesses WHERE id = NEW.business_id AND account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'ga4 authorization outside scope';
    END IF;
    IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'ga4 authorization starts unconsumed'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
     OR (NEW.id, NEW.account_id, NEW.user_id, NEW.business_id, NEW.connection_id, NEW.state_sha256, NEW.verifier_ciphertext, NEW.expires_at, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.user_id, OLD.business_id, OLD.connection_id, OLD.state_sha256, OLD.verifier_ciphertext, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'ga4 authorization state is single use';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_ga4_oauth_state_guard ON growth_ga4_oauth_states;
CREATE TRIGGER growth_ga4_oauth_state_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_ga4_oauth_states FOR EACH ROW EXECUTE FUNCTION guard_growth_ga4_oauth_state();

-- An explicit binding of one property and key event to one business metric.
-- Append-only: rebinding is a new row; the newest binding per definition is the
-- active one and older bindings stop synchronizing.
CREATE TABLE IF NOT EXISTS growth_ga4_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  connection_id UUID NOT NULL REFERENCES growth_ga4_connections(id),
  property TEXT NOT NULL CHECK (property ~ '^properties/[0-9]{1,20}$'),
  property_display_name TEXT NOT NULL CHECK (length(property_display_name) BETWEEN 1 AND 200),
  property_account TEXT CHECK (property_account IS NULL OR property_account ~ '^accounts/[0-9]{1,20}$'),
  property_time_zone TEXT NOT NULL CHECK (length(property_time_zone) BETWEEN 1 AND 64),
  metric_definition_id UUID NOT NULL,
  event_name TEXT NOT NULL CHECK (event_name ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
  provider_metric TEXT NOT NULL CHECK (provider_metric = 'keyEvents'),
  key_event_counting_method TEXT CHECK (key_event_counting_method IS NULL OR key_event_counting_method ~ '^[A-Z_]{1,64}$'),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  request_key UUID NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id), UNIQUE (business_id, request_key),
  FOREIGN KEY (metric_definition_id, business_id) REFERENCES growth_metric_definitions(id, business_id)
);
CREATE INDEX IF NOT EXISTS growth_ga4_bindings_definition ON growth_ga4_bindings(business_id, metric_definition_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION growth_ga4_property_matches(property TEXT, ref TEXT) RETURNS BOOLEAN AS $$
  SELECT ref IS NOT NULL AND (btrim(ref) = property OR 'properties/' || btrim(ref) = property)
$$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION growth_ga4_binding_active(b UUID) RETURNS BOOLEAN AS $$
  SELECT NOT EXISTS (SELECT 1 FROM growth_ga4_bindings x JOIN growth_ga4_bindings n
      ON n.business_id = x.business_id AND n.metric_definition_id = x.metric_definition_id AND (n.created_at, n.id) > (x.created_at, x.id)
    WHERE x.id = b)
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION guard_growth_ga4_binding() RETURNS trigger AS $$
DECLARE def growth_metric_definitions; conn growth_ga4_connections;
BEGIN
  IF NOT record_member(NEW.business_id, NEW.created_by_user_id) THEN RAISE EXCEPTION 'ga4 binding author must be an account member'; END IF;
  SELECT c.* INTO conn FROM growth_ga4_connections c JOIN businesses b ON b.account_id = c.account_id WHERE c.id = NEW.connection_id AND b.id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'ga4 connection belongs to another account'; END IF;
  IF conn.status <> 'ACTIVE' THEN RAISE EXCEPTION 'ga4 connection is not active'; END IF;
  SELECT * INTO def FROM growth_metric_definitions WHERE id = NEW.metric_definition_id AND business_id = NEW.business_id;
  IF def.source_kind <> 'GA4_AGGREGATE_EXPORT' OR def.counting_semantics <> 'EVENT_COUNT' OR def.unit <> 'COUNT' THEN
    RAISE EXCEPTION 'ga4 binding requires a GA4 key-event count definition';
  END IF;
  IF NOT growth_ga4_property_matches(NEW.property, def.property_ref) THEN RAISE EXCEPTION 'ga4 binding property differs from the definition'; END IF;
  IF NEW.event_name IS DISTINCT FROM def.event_name THEN RAISE EXCEPTION 'ga4 binding key event differs from the definition'; END IF;
  IF NEW.property_time_zone IS DISTINCT FROM def.reporting_time_zone THEN RAISE EXCEPTION 'ga4 binding time zone differs from the definition'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_ga4_binding_guard ON growth_ga4_bindings;
CREATE TRIGGER growth_ga4_binding_guard BEFORE INSERT ON growth_ga4_bindings FOR EACH ROW EXECUTE FUNCTION guard_growth_ga4_binding();

-- Durable scheduling state only; no provider fact lives here. One open job per
-- binding, so two workers never read and record the same binding at once.
CREATE TABLE IF NOT EXISTS growth_ga4_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id UUID NOT NULL,
  business_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('BACKFILL','REFRESH','SCHEDULED')),
  date_start DATE NOT NULL,
  date_end DATE NOT NULL,
  CHECK (date_end >= date_start AND (date_end - date_start) <= 365),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','CLAIMED','SUCCEEDED','FAILED','CANCELLED')),
  not_before TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_by TEXT,
  lease_expires_at TIMESTAMPTZ,
  attempt_count INT NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT CHECK (last_error IS NULL OR last_error ~ '^[A-Z_]{1,64}$'),
  request_key UUID,
  request_fingerprint TEXT CHECK (request_fingerprint IS NULL OR request_fingerprint ~ '^[a-f0-9]{64}$'),
  requested_by_user_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id),
  FOREIGN KEY (binding_id, business_id) REFERENCES growth_ga4_bindings(id, business_id),
  CHECK ((status = 'CLAIMED') = (claimed_by IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((kind = 'SCHEDULED') = (requested_by_user_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS growth_ga4_sync_jobs_one_open ON growth_ga4_sync_jobs(binding_id) WHERE status IN ('QUEUED','CLAIMED');
CREATE UNIQUE INDEX IF NOT EXISTS growth_ga4_sync_jobs_request ON growth_ga4_sync_jobs(binding_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS growth_ga4_sync_jobs_ready ON growth_ga4_sync_jobs(not_before) WHERE status IN ('QUEUED','CLAIMED');
CREATE INDEX IF NOT EXISTS growth_ga4_sync_jobs_binding ON growth_ga4_sync_jobs(binding_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_growth_ga4_sync_job() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'ga4 sync jobs keep their history'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'QUEUED' THEN RAISE EXCEPTION 'ga4 sync jobs start QUEUED'; END IF;
    IF NEW.requested_by_user_id IS NOT NULL AND NOT record_member(NEW.business_id, NEW.requested_by_user_id) THEN RAISE EXCEPTION 'ga4 sync requester must be an account member'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.binding_id, NEW.business_id, NEW.kind, NEW.date_start, NEW.date_end, NEW.request_key, NEW.request_fingerprint, NEW.requested_by_user_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.binding_id, OLD.business_id, OLD.kind, OLD.date_start, OLD.date_end, OLD.request_key, OLD.request_fingerprint, OLD.requested_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'ga4 sync job identity is immutable';
  END IF;
  IF OLD.status IN ('SUCCEEDED','FAILED','CANCELLED') THEN RAISE EXCEPTION 'a finished ga4 sync job cannot change'; END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_ga4_sync_job_guard ON growth_ga4_sync_jobs;
CREATE TRIGGER growth_ga4_sync_job_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_ga4_sync_jobs FOR EACH ROW EXECUTE FUNCTION guard_growth_ga4_sync_job();

-- What each attempt did. Health and freshness are read from here.
CREATE TABLE IF NOT EXISTS growth_ga4_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL,
  binding_id UUID NOT NULL,
  business_id UUID NOT NULL,
  attempt INT NOT NULL CHECK (attempt > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('RECORDED','UNCHANGED','RETRYING','FAILED')),
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z_]{1,64}$'),
  import_id UUID,
  response_digest TEXT CHECK (response_digest IS NULL OR response_digest ~ '^[a-f0-9]{64}$'),
  days_reported INT CHECK (days_reported IS NULL OR days_reported >= 0),
  quota JSONB CHECK (quota IS NULL OR jsonb_typeof(quota) = 'object'),
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, business_id) REFERENCES growth_ga4_sync_jobs(id, business_id),
  FOREIGN KEY (binding_id, business_id) REFERENCES growth_ga4_bindings(id, business_id),
  CHECK ((outcome IN ('RECORDED','UNCHANGED')) = (error_code IS NULL AND response_digest IS NOT NULL)),
  CHECK ((outcome IN ('RECORDED','UNCHANGED')) = (import_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS growth_ga4_sync_runs_binding ON growth_ga4_sync_runs(binding_id, finished_at DESC);

-- The provider identity of one authenticated import. Append-only, one per import.
CREATE TABLE IF NOT EXISTS growth_ga4_observations (
  import_id UUID PRIMARY KEY,
  business_id UUID NOT NULL,
  binding_id UUID NOT NULL,
  connection_id UUID NOT NULL REFERENCES growth_ga4_connections(id),
  google_subject TEXT NOT NULL,
  job_id UUID NOT NULL,
  property TEXT NOT NULL,
  event_name TEXT NOT NULL,
  provider_metric TEXT NOT NULL CHECK (provider_metric = 'keyEvents'),
  metric_definition_id UUID NOT NULL,
  metric_definition_version INT NOT NULL,
  time_zone TEXT NOT NULL,
  requested_start DATE NOT NULL,
  requested_end DATE NOT NULL,
  observed_start DATE,
  observed_end DATE,
  response_digest TEXT NOT NULL CHECK (response_digest ~ '^[a-f0-9]{64}$'),
  subject_to_thresholding BOOLEAN NOT NULL,
  supersedes_import_id UUID,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (import_id, business_id) REFERENCES growth_metric_imports(id, business_id),
  FOREIGN KEY (binding_id, business_id) REFERENCES growth_ga4_bindings(id, business_id),
  FOREIGN KEY (job_id, business_id) REFERENCES growth_ga4_sync_jobs(id, business_id),
  CHECK ((observed_start IS NULL) = (observed_end IS NULL)),
  CHECK (observed_start IS NULL OR (observed_start >= requested_start AND observed_end <= requested_end AND observed_start <= observed_end))
);
CREATE INDEX IF NOT EXISTS growth_ga4_observations_binding ON growth_ga4_observations(binding_id, collected_at DESC, import_id DESC);

ALTER TABLE growth_ga4_sync_runs DROP CONSTRAINT IF EXISTS growth_ga4_sync_runs_import_fk;
ALTER TABLE growth_ga4_sync_runs ADD CONSTRAINT growth_ga4_sync_runs_import_fk FOREIGN KEY (import_id) REFERENCES growth_ga4_observations(import_id);

CREATE OR REPLACE FUNCTION guard_growth_ga4_observation() RETURNS trigger AS $$
DECLARE imp growth_metric_imports; bind growth_ga4_bindings; conn growth_ga4_connections; def growth_metric_definitions; job growth_ga4_sync_jobs;
BEGIN
  SELECT * INTO imp FROM growth_metric_imports WHERE id = NEW.import_id AND business_id = NEW.business_id;
  SELECT * INTO bind FROM growth_ga4_bindings WHERE id = NEW.binding_id AND business_id = NEW.business_id;
  SELECT * INTO conn FROM growth_ga4_connections WHERE id = NEW.connection_id;
  SELECT * INTO job FROM growth_ga4_sync_jobs WHERE id = NEW.job_id AND business_id = NEW.business_id;
  IF imp.id IS NULL OR bind.id IS NULL OR conn.id IS NULL OR job.id IS NULL THEN RAISE EXCEPTION 'ga4 observation outside scope'; END IF;
  SELECT * INTO def FROM growth_metric_definitions WHERE id = imp.metric_definition_id AND business_id = imp.business_id;
  IF imp.provenance <> 'AUTHENTICATED_PROVIDER_API' THEN RAISE EXCEPTION 'ga4 observation requires an authenticated import'; END IF;
  IF bind.connection_id <> NEW.connection_id OR conn.google_subject <> NEW.google_subject OR conn.status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'ga4 observation must come from the binding''s active connection';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = NEW.business_id AND b.account_id = conn.account_id) THEN RAISE EXCEPTION 'ga4 observation outside scope'; END IF;
  IF NOT growth_ga4_binding_active(bind.id) THEN RAISE EXCEPTION 'ga4 binding is no longer active'; END IF;
  IF job.binding_id <> bind.id OR job.status <> 'CLAIMED' THEN RAISE EXCEPTION 'ga4 observation requires the claimed job of its binding'; END IF;
  IF NEW.property <> bind.property OR NEW.event_name <> bind.event_name OR NEW.metric_definition_id <> bind.metric_definition_id
     OR imp.metric_definition_id <> bind.metric_definition_id OR NEW.metric_definition_version <> def.version THEN
    RAISE EXCEPTION 'ga4 observation differs from its binding';
  END IF;
  IF NEW.time_zone <> bind.property_time_zone OR NEW.time_zone <> imp.time_zone THEN RAISE EXCEPTION 'ga4 observation time zone differs from its binding'; END IF;
  IF NEW.requested_start <> imp.date_start OR NEW.requested_end <> imp.date_end OR NEW.requested_start < job.date_start OR NEW.requested_end > job.date_end THEN
    RAISE EXCEPTION 'ga4 observation window differs from its import';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_ga4_observation_guard ON growth_ga4_observations;
CREATE TRIGGER growth_ga4_observation_guard BEFORE INSERT ON growth_ga4_observations FOR EACH ROW EXECUTE FUNCTION guard_growth_ga4_observation();

-- An authenticated import must carry its observation by the end of its
-- transaction: provider provenance is never a bare label.
CREATE OR REPLACE FUNCTION require_growth_ga4_observation() RETURNS trigger AS $$
BEGIN
  IF NEW.provenance = 'AUTHENTICATED_PROVIDER_API' AND NOT EXISTS (SELECT 1 FROM growth_ga4_observations o WHERE o.import_id = NEW.id) THEN
    RAISE EXCEPTION 'authenticated provider import without a ga4 observation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_metric_import_requires_observation ON growth_metric_imports;
CREATE CONSTRAINT TRIGGER growth_metric_import_requires_observation AFTER INSERT ON growth_metric_imports
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_growth_ga4_observation();

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['growth_ga4_connection_events','growth_ga4_bindings','growth_ga4_sync_runs','growth_ga4_observations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS growth_ga4_append_only ON %I', t);
    EXECUTE format('CREATE TRIGGER growth_ga4_append_only BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation()', t);
    EXECUTE format('DROP TRIGGER IF EXISTS growth_ga4_no_truncate ON %I', t);
    EXECUTE format('CREATE TRIGGER growth_ga4_no_truncate BEFORE TRUNCATE ON %I EXECUTE FUNCTION prevent_append_only_mutation()', t);
  END LOOP;
END $$;

-- Read documents never select credentials.
CREATE OR REPLACE VIEW growth_ga4_connection_documents AS SELECT c.id, c.account_id, c.created_at,
  jsonb_build_object('id', c.id, 'accountId', c.account_id, 'googleEmail', c.google_email, 'grantedScopes', to_jsonb(c.granted_scopes),
    'status', c.status, 'statusReason', c.status_reason, 'connectedByUserId', c.connected_by_user_id, 'createdAt', c.created_at,
    'lastAuthorizedAt', c.last_authorized_at, 'disconnectedAt', c.disconnected_at, 'revocationConfirmed', c.revocation_confirmed) AS document
  FROM growth_ga4_connections c;
CREATE OR REPLACE VIEW growth_ga4_binding_documents AS SELECT b.id, b.business_id, b.metric_definition_id, b.created_at,
  jsonb_build_object('id', b.id, 'businessId', b.business_id, 'connectionId', b.connection_id, 'property', b.property,
    'propertyDisplayName', b.property_display_name, 'propertyTimeZone', b.property_time_zone, 'metricDefinitionId', b.metric_definition_id,
    'metricDefinitionVersion', d.version, 'eventName', b.event_name, 'providerMetric', b.provider_metric,
    'keyEventCountingMethod', b.key_event_counting_method, 'createdByUserId', b.created_by_user_id, 'createdAt', b.created_at) AS document
  FROM growth_ga4_bindings b JOIN growth_metric_definitions d ON d.id = b.metric_definition_id AND d.business_id = b.business_id;
