-- Provider credentials stay with the local harness. Only hashes of bridge
-- capabilities are stored here; every bridge is owned by one account member.
CREATE TABLE IF NOT EXISTS agent_bridges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  user_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  token_hash TEXT UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  pair_hash TEXT UNIQUE CHECK (pair_hash ~ '^[a-f0-9]{64}$'),
  pair_expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '10 minutes',
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(account_id,user_id) REFERENCES account_users(account_id,user_id) ON DELETE CASCADE,
  UNIQUE(id,account_id,user_id)
);
ALTER TABLE agent_bridges ADD COLUMN IF NOT EXISTS refresh_requested BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS agent_harness_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bridge_id UUID NOT NULL,
  account_id UUID NOT NULL,
  user_id UUID NOT NULL,
  local_id UUID NOT NULL,
  driver TEXT NOT NULL CHECK (driver IN ('codex','claude','opencode','cursor')),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  enabled BOOLEAN NOT NULL DEFAULT false,
  report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object' AND octet_length(report::text) <= 200000),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(bridge_id,account_id,user_id) REFERENCES agent_bridges(id,account_id,user_id) ON DELETE CASCADE,
  UNIQUE(bridge_id,local_id),
  UNIQUE(id,bridge_id,account_id,user_id)
);
CREATE TABLE IF NOT EXISTS agent_harness_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL,
  bridge_id UUID NOT NULL,
  account_id UUID NOT NULL,
  user_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED')),
  input JSONB NOT NULL CHECK (octet_length(input::text) <= 150000),
  result JSONB,
  lease UUID,
  deadline TIMESTAMPTZ NOT NULL DEFAULT now() + interval '100 seconds',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  FOREIGN KEY(instance_id,bridge_id,account_id,user_id) REFERENCES agent_harness_instances(id,bridge_id,account_id,user_id) ON DELETE CASCADE,
  CHECK ((status = 'RUNNING') = (lease IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS agent_harness_jobs_claim ON agent_harness_jobs(bridge_id,created_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS agent_harness_jobs_cleanup ON agent_harness_jobs(deadline);

CREATE OR REPLACE FUNCTION agent_harness_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM businesses WHERE id=NEW.business_id AND account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'Harness business scope refused';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.instance_id,NEW.bridge_id,NEW.account_id,NEW.user_id,NEW.business_id,NEW.model)
      IS DISTINCT FROM (OLD.instance_id,OLD.bridge_id,OLD.account_id,OLD.user_id,OLD.business_id,OLD.model) THEN
      RAISE EXCEPTION 'Harness turn identity is immutable';
    END IF;
    IF OLD.status IN ('COMPLETED','FAILED','CANCELLED') AND NEW.status <> OLD.status THEN
      RAISE EXCEPTION 'Harness terminal state is final';
    END IF;
    IF OLD.status IN ('COMPLETED','FAILED','CANCELLED') AND
      (NEW.result,NEW.completed_at,NEW.lease,NEW.input) IS DISTINCT FROM (OLD.result,OLD.completed_at,OLD.lease,OLD.input) THEN
      RAISE EXCEPTION 'Harness terminal receipt is immutable';
    END IF;
    IF NEW.status <> OLD.status AND NOT (
      (OLD.status='QUEUED' AND NEW.status IN ('RUNNING','FAILED','CANCELLED')) OR
      (OLD.status='RUNNING' AND NEW.status IN ('COMPLETED','FAILED','CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'Harness transition refused';
    END IF;
    IF OLD.status='RUNNING' AND NEW.status='RUNNING' AND NEW.input IS DISTINCT FROM OLD.input THEN
      RAISE EXCEPTION 'Harness in-flight input is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_harness_scope ON agent_harness_jobs;
CREATE TRIGGER agent_harness_scope BEFORE INSERT OR UPDATE ON agent_harness_jobs
  FOR EACH ROW EXECUTE FUNCTION agent_harness_scope_guard();
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS last_request_digest TEXT;
