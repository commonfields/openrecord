-- Agent sessions that work together, and CLIProxyAPI as a local provider.
--
-- A session (agent conversation) may start helper sessions for one task each,
-- in the same business and for the same user. A helper session is an ordinary
-- conversation with a parent; it never becomes the business's default chat,
-- so it is created archived. Each delegation is an agent_tasks row: who asked,
-- which helper session ran it, the task text, and its terminal result. The
-- helper runs the same server-owned tools as its parent and nothing broader;
-- anything it proposes still waits for a person's decision.
--
-- Additive and replay-safe: every statement is idempotent.

ALTER TABLE agent_harness_instances DROP CONSTRAINT IF EXISTS agent_harness_instances_driver_check;
ALTER TABLE agent_harness_instances ADD CONSTRAINT agent_harness_instances_driver_check
  CHECK (driver IN ('codex','claude','opencode','cursor','cliproxy'));

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS parent_conversation_id UUID NULL REFERENCES agent_conversations(id) ON DELETE SET NULL;
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS depth SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS task_title TEXT NULL;
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS task_role TEXT NULL;
-- The revision after the operator's own last turn. Turns and results another
-- session adds do not move it, so an operator who has not seen them can still send.
ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS user_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_conversations DROP CONSTRAINT IF EXISTS agent_conversations_session_check;
ALTER TABLE agent_conversations ADD CONSTRAINT agent_conversations_session_check CHECK (
  depth BETWEEN 0 AND 3 AND (parent_conversation_id IS NULL OR parent_conversation_id <> id)
  AND (task_title IS NULL OR length(task_title) BETWEEN 1 AND 120)
  AND (task_role IS NULL OR task_role IN ('general','researcher','seo','aeo','content','analyst')));
CREATE INDEX IF NOT EXISTS agent_conversations_parent ON agent_conversations(parent_conversation_id) WHERE parent_conversation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  parent_conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  parent_run_id UUID NULL REFERENCES agent_runs(id) ON DELETE SET NULL,
  child_conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  -- NEW: a helper session started for this task. MESSAGE: a turn sent to an existing session.
  kind TEXT NOT NULL CHECK (kind IN ('NEW','MESSAGE')),
  role TEXT NOT NULL CHECK (role IN ('general','researcher','seo','aeo','content','analyst')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  task TEXT NOT NULL CHECK (length(task) BETWEEN 1 AND 4000),
  mode TEXT NOT NULL CHECK (mode IN ('wait','async')),
  -- The provider and model the helper runs on; NULL is the hosted model.
  selection JSONB NULL CHECK (selection IS NULL OR (jsonb_typeof(selection) = 'object' AND octet_length(selection::text) <= 1000)),
  -- Idempotency: one task per request ID within a parent run.
  client_request_id UUID NOT NULL,
  request_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  result_summary TEXT NULL CHECK (result_summary IS NULL OR length(result_summary) <= 8000),
  result JSONB NULL CHECK (result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 16000)),
  failure_reason TEXT NULL CHECK (failure_reason IS NULL OR length(failure_reason) <= 64),
  -- The parent read the result (wait mode, read_task) or it was posted into the parent session.
  delivered_at TIMESTAMPTZ NULL,
  -- An async batch wakes its parent once, after every task of the parent run finished.
  woke_parent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL,
  CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
  CHECK (parent_conversation_id <> child_conversation_id),
  UNIQUE (parent_conversation_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS agent_tasks_parent ON agent_tasks(parent_conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_tasks_child ON agent_tasks(child_conversation_id);
CREATE INDEX IF NOT EXISTS agent_tasks_running ON agent_tasks(account_id) WHERE status = 'RUNNING';
CREATE INDEX IF NOT EXISTS agent_tasks_undelivered ON agent_tasks(parent_conversation_id) WHERE delivered_at IS NULL AND status <> 'RUNNING';

CREATE OR REPLACE FUNCTION agent_task_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Both sessions belong to the same account, user and business as the task.
    IF NOT EXISTS (SELECT 1 FROM agent_conversations WHERE id = NEW.parent_conversation_id AND account_id = NEW.account_id AND user_id = NEW.user_id AND business_id = NEW.business_id)
       OR NOT EXISTS (SELECT 1 FROM agent_conversations WHERE id = NEW.child_conversation_id AND account_id = NEW.account_id AND user_id = NEW.user_id AND business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'agent task outside scope';
    END IF;
    IF NEW.status <> 'RUNNING' OR NEW.delivered_at IS NOT NULL OR NEW.woke_parent_at IS NOT NULL THEN RAISE EXCEPTION 'agent tasks start running'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.account_id, NEW.user_id, NEW.business_id, NEW.parent_conversation_id, NEW.child_conversation_id, NEW.kind, NEW.role, NEW.title, NEW.task, NEW.mode, NEW.selection, NEW.client_request_id, NEW.request_id, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.user_id, OLD.business_id, OLD.parent_conversation_id, OLD.child_conversation_id, OLD.kind, OLD.role, OLD.title, OLD.task, OLD.mode, OLD.selection, OLD.client_request_id, OLD.request_id, OLD.created_at) THEN
    RAISE EXCEPTION 'agent task identity is immutable';
  END IF;
  IF OLD.status <> 'RUNNING' AND (NEW.status, NEW.result_summary, NEW.result, NEW.failure_reason, NEW.finished_at) IS DISTINCT FROM (OLD.status, OLD.result_summary, OLD.result, OLD.failure_reason, OLD.finished_at) THEN
    RAISE EXCEPTION 'agent task result is final';
  END IF;
  IF (OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at) OR (OLD.woke_parent_at IS NOT NULL AND NEW.woke_parent_at IS DISTINCT FROM OLD.woke_parent_at) THEN
    RAISE EXCEPTION 'agent task delivery is recorded once';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_task_guard ON agent_tasks;
CREATE TRIGGER agent_task_guard BEFORE INSERT OR UPDATE ON agent_tasks FOR EACH ROW EXECUTE FUNCTION agent_task_guard();
