-- A turn that pauses for the owner's decision (wait_for_decision) keeps its
-- own model conversation here: everything it had read and asked for, and the
-- results of the step it paused on. When every card it waits on is decided,
-- the next turn continues from this conversation, with the decisions as the
-- answer to the tool it paused on, instead of rebuilding from the chat text.
-- A pause is used once; one the chat has moved past is never resumed.
CREATE TABLE IF NOT EXISTS agent_turn_pauses (
  run_id uuid PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_ids uuid[] NOT NULL CHECK (cardinality(item_ids) BETWEEN 1 AND 5),
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object' AND octet_length(checkpoint::text) <= 4000000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resumed_at timestamptz,
  resumed_by_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS agent_turn_pauses_waiting
  ON agent_turn_pauses (conversation_id) WHERE resumed_at IS NULL;
