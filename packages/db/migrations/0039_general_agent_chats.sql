-- A NULL business is a real, private general chat, never a synthetic business.
ALTER TABLE agent_conversations ALTER COLUMN business_id DROP NOT NULL;
ALTER TABLE agent_harness_jobs ALTER COLUMN business_id DROP NOT NULL;
DROP INDEX IF EXISTS agent_conversations_current;
CREATE UNIQUE INDEX agent_conversations_current ON agent_conversations(account_id,business_id,user_id)
  NULLS NOT DISTINCT WHERE archived_at IS NULL;

CREATE OR REPLACE FUNCTION agent_harness_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='INSERT' AND NOT EXISTS(SELECT 1 FROM account_users WHERE account_id=NEW.account_id AND user_id=NEW.user_id))
    OR (NEW.business_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM businesses WHERE id=NEW.business_id AND account_id=NEW.account_id)) THEN
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
