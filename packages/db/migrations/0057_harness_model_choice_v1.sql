-- Which of a provider's models the person turned off. Stored as the models
-- turned off (not on), so a model the provider adds later is available until
-- the person says otherwise, the same as before this column existed.
ALTER TABLE agent_harness_instances ADD COLUMN IF NOT EXISTS disabled_models TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE agent_harness_instances DROP CONSTRAINT IF EXISTS agent_harness_instances_disabled_models_check;
ALTER TABLE agent_harness_instances ADD CONSTRAINT agent_harness_instances_disabled_models_check
  CHECK (coalesce(array_length(disabled_models, 1), 0) <= 500);
