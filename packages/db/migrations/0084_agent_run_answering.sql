-- The answer as it is written.
--
-- MODEL_ANSWERING: the next piece of the answer text the provider has produced
-- in a model step, throttled, with internal identifiers already removed and
-- the last few characters held back until they are settled. Clients append
-- the pieces to show the reply while it is written; the stored reply is still
-- the one the finished run returns. A step that ends in tool calls discards
-- its pieces. Never sent back to the model.
--
-- Additive and replay-safe: every statement is idempotent.

ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_type_check;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_type_check CHECK (type IN (
  'RUN_STARTED','CONTEXT_BUILT','MODEL_REQUESTED','MODEL_THINKING','MODEL_ANSWERING','MODEL_STEP','TOOL_STARTED','TOOL_COMPLETED','TOOL_FAILED','VERIFICATION','RUN_FINISHED'));
