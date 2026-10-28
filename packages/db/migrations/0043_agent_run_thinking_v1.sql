-- What the model is doing while a run is in progress.
--
-- MODEL_REQUESTED: a model step started (the chat shows "Thinking").
-- MODEL_THINKING: the reasoning text the provider has produced so far in that
-- step, throttled and bounded. It is the model's own reasoning output, shown
-- to the operator; OpenRecord never asks for extra text to fill it, and it is
-- never sent back to the model.
--
-- A bridge reports a running job's reasoning in agent_harness_jobs.progress,
-- bounded and fenced by the job lease like its result.
--
-- Additive and replay-safe: every statement is idempotent.

ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_type_check;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_type_check CHECK (type IN (
  'RUN_STARTED','CONTEXT_BUILT','MODEL_REQUESTED','MODEL_THINKING','MODEL_STEP','TOOL_STARTED','TOOL_COMPLETED','TOOL_FAILED','VERIFICATION','RUN_FINISHED'));

ALTER TABLE agent_harness_jobs ADD COLUMN IF NOT EXISTS progress JSONB NULL;
ALTER TABLE agent_harness_jobs DROP CONSTRAINT IF EXISTS agent_harness_jobs_progress_check;
ALTER TABLE agent_harness_jobs ADD CONSTRAINT agent_harness_jobs_progress_check
  CHECK (progress IS NULL OR (jsonb_typeof(progress) = 'object' AND octet_length(progress::text) <= 8000));
