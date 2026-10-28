-- Durable agent runs. One row per attempt to answer one user message, with an
-- append-only event journal: model steps, tool invocations and their receipts,
-- verification and the terminal outcome. A run that stops before its reply is
-- settled into the conversation as an explicit interruption note, so work that
-- was already saved (proposals, drafts) is never left unexplained.
-- Raw provider payloads and full tool evidence are never copied here; tool
-- events keep the server summary, evidence references and proposal receipts.
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id UUID NOT NULL,
  -- The conversation lease this run executes under; a run whose lease is gone
  -- while still RUNNING was interrupted (crash, cancel or lease expiry).
  lease_id UUID NOT NULL,
  objective TEXT NOT NULL CHECK (length(objective) <= 4000),
  workflow JSONB NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
  outcome TEXT NULL CHECK (outcome IS NULL OR outcome IN ('ANSWERED','ANSWERED_WITH_GAPS')),
  failure_reason TEXT NULL CHECK (failure_reason IS NULL OR length(failure_reason) <= 64),
  model_steps INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  next_seq INTEGER NOT NULL DEFAULT 0,
  -- Set once the run's terminal state is reflected in the conversation
  -- (its reply, or an interruption note). Unsettled stopped runs are retried.
  settled_at TIMESTAMPTZ NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL,
  CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
  CHECK (status = 'COMPLETED' OR outcome IS NULL)
);
CREATE INDEX IF NOT EXISTS agent_runs_conversation ON agent_runs(conversation_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_request ON agent_runs(account_id, user_id, request_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_unsettled ON agent_runs(conversation_id) WHERE settled_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('RUN_STARTED','CONTEXT_BUILT','MODEL_STEP','TOOL_STARTED','TOOL_COMPLETED','TOOL_FAILED','VERIFICATION','RUN_FINISHED')),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 16000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

-- The journal is append-only and a finished run is final.
CREATE OR REPLACE FUNCTION agent_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.conversation_id, NEW.account_id, NEW.business_id, NEW.user_id, NEW.request_id, NEW.lease_id, NEW.objective, NEW.started_at)
    IS DISTINCT FROM (OLD.id, OLD.conversation_id, OLD.account_id, OLD.business_id, OLD.user_id, OLD.request_id, OLD.lease_id, OLD.objective, OLD.started_at) THEN
    RAISE EXCEPTION 'Agent run identity is immutable';
  END IF;
  IF OLD.status <> 'RUNNING' AND (NEW.status, NEW.outcome, NEW.failure_reason, NEW.finished_at) IS DISTINCT FROM (OLD.status, OLD.outcome, OLD.failure_reason, OLD.finished_at) THEN
    RAISE EXCEPTION 'Agent run terminal state is final';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_run_guard ON agent_runs;
CREATE TRIGGER agent_run_guard BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION agent_run_guard();

CREATE OR REPLACE FUNCTION agent_run_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Agent run events are append-only';
END $$;
DROP TRIGGER IF EXISTS agent_run_event_guard ON agent_run_events;
CREATE TRIGGER agent_run_event_guard BEFORE UPDATE ON agent_run_events FOR EACH ROW EXECUTE FUNCTION agent_run_event_guard();

-- Long investigations need more than 24 stored messages. The model still sees
-- a bounded, compacted window built by the API's context builder.
ALTER TABLE agent_conversations DROP CONSTRAINT IF EXISTS agent_conversations_messages_check;
ALTER TABLE agent_conversations ADD CONSTRAINT agent_conversations_messages_check
  CHECK (jsonb_typeof(messages) = 'array' AND jsonb_array_length(messages) <= 200);
