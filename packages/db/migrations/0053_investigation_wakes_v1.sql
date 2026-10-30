-- Human opt-in for bounded, read-only investigation wake-ups. A model cannot
-- grant itself background authority. One policy per person and business.
CREATE TABLE IF NOT EXISTS growth_investigation_wake_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  user_id UUID NOT NULL REFERENCES users(id),
  business_id UUID NOT NULL REFERENCES businesses(id),
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  grant_id UUID NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  selection JSONB CHECK (selection IS NULL OR jsonb_typeof(selection) = 'object'),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 200),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(account_id, user_id, business_id)
);
CREATE TABLE IF NOT EXISTS growth_investigation_wakes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id UUID NOT NULL REFERENCES growth_investigation_wake_policies(id) ON DELETE CASCADE,
  grant_id UUID NOT NULL,
  note_id UUID NOT NULL REFERENCES growth_investigation_notes(id),
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deadline TIMESTAMPTZ NOT NULL DEFAULT now() + interval '3 minutes',
  finished_at TIMESTAMPTZ,
  UNIQUE(policy_id, note_id),
  CHECK ((status = 'RUNNING') = (finished_at IS NULL))
);
CREATE INDEX IF NOT EXISTS growth_investigation_wakes_daily ON growth_investigation_wakes(policy_id, started_at DESC);

CREATE OR REPLACE FUNCTION guard_investigation_wake_scope() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'growth_investigation_wake_policies' THEN
    IF NOT EXISTS (SELECT 1 FROM agent_conversations c JOIN businesses b ON b.id = c.business_id
      JOIN account_users u ON u.account_id = c.account_id AND u.user_id = c.user_id
      WHERE c.id = NEW.conversation_id AND c.account_id = NEW.account_id AND c.user_id = NEW.user_id
        AND c.business_id = NEW.business_id AND b.account_id = NEW.account_id AND c.depth = 0) THEN
      RAISE EXCEPTION 'Wake policy is not in scope' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.id,NEW.account_id,NEW.user_id,NEW.business_id) IS DISTINCT FROM
      (OLD.id,OLD.account_id,OLD.user_id,OLD.business_id) THEN
      RAISE EXCEPTION 'Wake policy identity is immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF TG_OP = 'UPDATE' THEN
      IF OLD.status <> 'RUNNING' OR (NEW.id,NEW.policy_id,NEW.grant_id,NEW.note_id,NEW.conversation_id,NEW.started_at,NEW.deadline) IS DISTINCT FROM
        (OLD.id,OLD.policy_id,OLD.grant_id,OLD.note_id,OLD.conversation_id,OLD.started_at,OLD.deadline) THEN
        RAISE EXCEPTION 'Wake receipt is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF TG_OP = 'INSERT' AND NOT EXISTS (
      SELECT 1 FROM growth_investigation_wake_policies p JOIN growth_investigation_notes n ON n.id = NEW.note_id
      WHERE p.id = NEW.policy_id AND p.enabled AND p.grant_id = NEW.grant_id
        AND p.conversation_id = NEW.conversation_id
        AND p.business_id = n.business_id AND p.user_id = n.created_by_user_id
        AND n.work_state = 'WAITING_FOR_INPUT' AND (n.resume_after IS NOT NULL OR n.await_proposal_id IS NOT NULL)
    ) THEN
      RAISE EXCEPTION 'Wake is not in scope' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS investigation_wake_policy_scope ON growth_investigation_wake_policies;
CREATE TRIGGER investigation_wake_policy_scope BEFORE INSERT OR UPDATE ON growth_investigation_wake_policies
  FOR EACH ROW EXECUTE FUNCTION guard_investigation_wake_scope();
DROP TRIGGER IF EXISTS investigation_wake_scope ON growth_investigation_wakes;
CREATE TRIGGER investigation_wake_scope BEFORE INSERT OR UPDATE ON growth_investigation_wakes
  FOR EACH ROW EXECUTE FUNCTION guard_investigation_wake_scope();
