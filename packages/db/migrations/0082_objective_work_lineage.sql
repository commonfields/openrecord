-- Objective lineage for work, written by the application at creation time.
-- objective_goal_id is the business's primary growth goal (growth_profiles.primary_goal_id)
-- when the row was created, read in the creating statement. It is never taken from
-- model arguments, notes or conversation text. Null means the objective was unknown
-- (no growth profile) or the row predates this migration; no backfill guesses it.
-- Deliverables live in marketing_campaigns.brief.tasks and runs reference their
-- campaign, so both inherit the campaign's lineage. Growth opportunities already
-- carry goal_id NOT NULL. Investigation notes remain optional explanatory context.
ALTER TABLE marketing_campaigns ADD COLUMN IF NOT EXISTS objective_goal_id UUID;
ALTER TABLE wordpress_changes ADD COLUMN IF NOT EXISTS objective_goal_id UUID;
ALTER TABLE account_actions ADD COLUMN IF NOT EXISTS objective_goal_id UUID;

DO $$
BEGIN
  -- A composite key: a row can only name a goal of its own business.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketing_campaigns_objective_goal_fk') THEN
    ALTER TABLE marketing_campaigns ADD CONSTRAINT marketing_campaigns_objective_goal_fk
      FOREIGN KEY (objective_goal_id, business_id) REFERENCES growth_goals(id, business_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wordpress_changes_objective_goal_fk') THEN
    ALTER TABLE wordpress_changes ADD CONSTRAINT wordpress_changes_objective_goal_fk
      FOREIGN KEY (objective_goal_id, business_id) REFERENCES growth_goals(id, business_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_actions_objective_goal_fk') THEN
    ALTER TABLE account_actions ADD CONSTRAINT account_actions_objective_goal_fk
      FOREIGN KEY (objective_goal_id, business_id) REFERENCES growth_goals(id, business_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS marketing_campaigns_objective_work ON marketing_campaigns(business_id, objective_goal_id) WHERE objective_goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wordpress_changes_objective_work ON wordpress_changes(business_id, objective_goal_id) WHERE objective_goal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS account_actions_objective_work ON account_actions(business_id, objective_goal_id) WHERE objective_goal_id IS NOT NULL;

-- Creation-time lineage is never added, changed or removed afterwards.
CREATE OR REPLACE FUNCTION preserve_objective_work_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.objective_goal_id IS DISTINCT FROM OLD.objective_goal_id THEN
    RAISE EXCEPTION 'objective lineage is set at creation and is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS marketing_campaigns_objective_immutable ON marketing_campaigns;
CREATE TRIGGER marketing_campaigns_objective_immutable BEFORE UPDATE OF objective_goal_id ON marketing_campaigns
  FOR EACH ROW EXECUTE FUNCTION preserve_objective_work_lineage();
DROP TRIGGER IF EXISTS wordpress_changes_objective_immutable ON wordpress_changes;
CREATE TRIGGER wordpress_changes_objective_immutable BEFORE UPDATE OF objective_goal_id ON wordpress_changes
  FOR EACH ROW EXECUTE FUNCTION preserve_objective_work_lineage();
DROP TRIGGER IF EXISTS account_actions_objective_immutable ON account_actions;
CREATE TRIGGER account_actions_objective_immutable BEFORE UPDATE OF objective_goal_id ON account_actions
  FOR EACH ROW EXECUTE FUNCTION preserve_objective_work_lineage();
