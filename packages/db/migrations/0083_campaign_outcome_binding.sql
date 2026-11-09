-- M2: campaign WEBSITE deliverable -> exact WordPress change -> predeclared plan -> observed outcome.
-- Additive only: one column on wordpress_changes, one on marketing_campaign_deliveries, one new table,
-- guard triggers and indexes. Existing rows are not modified. Rollback: drop the new table, triggers,
-- functions, indexes and the two columns (no existing column or row is changed by this migration).

-- 1. Delivery time. Set only by the statement that records PUBLISHED after the adapter's read-back.
ALTER TABLE wordpress_changes ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION guard_wordpress_published_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.published_at IS NOT NULL THEN RAISE EXCEPTION 'published_at is set only when publication is recorded' USING ERRCODE = '23514'; END IF;
  ELSIF NEW.published_at IS DISTINCT FROM OLD.published_at
    AND NOT (OLD.published_at IS NULL AND OLD.status = 'PUBLISHING' AND NEW.status = 'PUBLISHED') THEN
    RAISE EXCEPTION 'published_at is set once, when publication is recorded' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wordpress_changes_published_at ON wordpress_changes;
CREATE TRIGGER wordpress_changes_published_at BEFORE INSERT OR UPDATE ON wordpress_changes FOR EACH ROW EXECUTE FUNCTION guard_wordpress_published_at();

-- 2. Delivery links pin the exact prepared values. Legacy links keep a null digest.
ALTER TABLE marketing_campaign_deliveries ADD COLUMN IF NOT EXISTS prepared_digest TEXT
  CHECK (prepared_digest IS NULL OR prepared_digest ~ '^[a-f0-9]{64}$');
-- One change is the delivery of at most one deliverable.
CREATE UNIQUE INDEX IF NOT EXISTS marketing_campaign_deliveries_one_change ON marketing_campaign_deliveries(wordpress_change_id) WHERE prepared_digest IS NOT NULL;

CREATE OR REPLACE FUNCTION wordpress_prepared_digest(prepared JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(prepared::text, 'UTF8')), 'hex')
$$;

-- A new link must name a change still awaiting its decision, prepared for this run, under the campaign's objective.
CREATE OR REPLACE FUNCTION guard_campaign_delivery_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM marketing_campaign_runs r
    JOIN marketing_campaigns c ON c.id = r.campaign_id AND c.business_id = r.business_id
    JOIN wordpress_changes w ON w.id = NEW.wordpress_change_id AND w.business_id = r.business_id
    WHERE r.id = NEW.run_id AND r.business_id = NEW.business_id
      AND w.status = 'PROPOSED' AND w.decided_at IS NULL AND w.created_at >= r.created_at
      AND w.objective_goal_id IS NOT DISTINCT FROM c.objective_goal_id
      AND NEW.prepared_digest = wordpress_prepared_digest(w.after_values)
  ) THEN
    RAISE EXCEPTION 'delivery link requires a pending change prepared for this run under the campaign objective' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS marketing_campaign_delivery_guard ON marketing_campaign_deliveries;
CREATE TRIGGER marketing_campaign_delivery_guard BEFORE INSERT ON marketing_campaign_deliveries FOR EACH ROW EXECUTE FUNCTION guard_campaign_delivery_link();
DROP TRIGGER IF EXISTS marketing_campaign_delivery_append ON marketing_campaign_deliveries;
CREATE TRIGGER marketing_campaign_delivery_append BEFORE UPDATE OR DELETE ON marketing_campaign_deliveries FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();

-- Once linked, the prepared change is what the operator approves: its values can no longer change.
CREATE OR REPLACE FUNCTION protect_linked_wordpress_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM marketing_campaign_deliveries WHERE wordpress_change_id = OLD.id AND prepared_digest IS NOT NULL) AND (
    NEW.after_values IS DISTINCT FROM OLD.after_values OR NEW.before_values IS DISTINCT FROM OLD.before_values
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.post_type IS DISTINCT FROM OLD.post_type OR NEW.post_id IS DISTINCT FROM OLD.post_id
    OR NEW.target_modified IS DISTINCT FROM OLD.target_modified OR NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
  ) THEN
    RAISE EXCEPTION 'a change linked to a campaign deliverable is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS wordpress_changes_linked_immutable ON wordpress_changes;
CREATE TRIGGER wordpress_changes_linked_immutable BEFORE UPDATE ON wordpress_changes FOR EACH ROW EXECUTE FUNCTION protect_linked_wordpress_change();

-- 3. Measurement bindings: a deliverable of a current run, measured by an approved opportunity's latest plan.
-- Append-only and auditable (who, as which actor and model, when). An operator may dissolve one, once.
CREATE TABLE IF NOT EXISTS marketing_campaign_measurement_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  campaign_id UUID NOT NULL,
  run_id UUID NOT NULL,
  task_id UUID NOT NULL,
  opportunity_id UUID NOT NULL,
  plan_id UUID NOT NULL,
  request_key TEXT NOT NULL CHECK (request_key ~ '^[a-f0-9]{64}$'),
  bound_by_user_id UUID NOT NULL REFERENCES users(id),
  bound_by_actor TEXT NOT NULL CHECK (bound_by_actor IN ('ASSISTANT', 'OPERATOR')),
  origin_provider TEXT NULL CHECK (origin_provider IS NULL OR length(origin_provider) <= 200),
  origin_model TEXT NULL CHECK (origin_model IS NULL OR length(origin_model) <= 200),
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dissolved_by_user_id UUID NULL REFERENCES users(id),
  dissolved_at TIMESTAMPTZ NULL,
  dissolution_reason TEXT NULL CHECK (dissolution_reason IS NULL OR length(trim(dissolution_reason)) BETWEEN 1 AND 1000),
  UNIQUE (id, business_id),
  UNIQUE (business_id, request_key),
  CHECK ((dissolved_at IS NULL) = (dissolved_by_user_id IS NULL) AND (dissolved_at IS NULL) = (dissolution_reason IS NULL)),
  FOREIGN KEY (business_id, campaign_id) REFERENCES marketing_campaigns(business_id, id),
  FOREIGN KEY (business_id, run_id) REFERENCES marketing_campaign_runs(business_id, id),
  FOREIGN KEY (opportunity_id, business_id) REFERENCES growth_opportunities(id, business_id),
  FOREIGN KEY (plan_id, business_id) REFERENCES growth_measurement_plans(id, business_id)
);
-- At most one active binding per deliverable. Several deliverables may share one plan.
CREATE UNIQUE INDEX IF NOT EXISTS marketing_campaign_measurement_active ON marketing_campaign_measurement_bindings(run_id, task_id) WHERE dissolved_at IS NULL;
CREATE INDEX IF NOT EXISTS marketing_campaign_measurement_history ON marketing_campaign_measurement_bindings(business_id, campaign_id, bound_at, id);

CREATE OR REPLACE FUNCTION guard_campaign_measurement_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.dissolved_at IS NOT NULL OR NOT record_member(NEW.business_id, NEW.bound_by_user_id) OR NOT EXISTS (
      SELECT 1 FROM marketing_campaign_runs r
      JOIN marketing_campaigns c ON c.id = r.campaign_id AND c.business_id = r.business_id
      JOIN growth_opportunities o ON o.id = NEW.opportunity_id AND o.business_id = r.business_id
      JOIN growth_measurement_plans p ON p.id = NEW.plan_id AND p.business_id = o.business_id AND p.opportunity_id = o.id
      WHERE r.id = NEW.run_id AND r.business_id = NEW.business_id AND r.campaign_id = NEW.campaign_id
        AND r.cancelled_at IS NULL AND r.campaign_revision = c.revision
        AND c.objective_goal_id IS NOT NULL AND o.goal_id = c.objective_goal_id
        AND growth_opportunity_status(o.id) = 'APPROVED'
        AND p.declared_at <= NEW.bound_at
        AND p.id = (SELECT id FROM growth_measurement_plans WHERE opportunity_id = o.id AND business_id = o.business_id ORDER BY declared_at DESC, id DESC LIMIT 1)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.snapshot->'tasks') t WHERE t->>'id' = NEW.task_id::text AND t->>'channel' = 'WEBSITE')
        -- Measurement is chosen before delivery is decided, never after seeing results.
        AND NOT EXISTS (SELECT 1 FROM marketing_campaign_deliveries d JOIN wordpress_changes w ON w.id = d.wordpress_change_id
          WHERE d.run_id = NEW.run_id AND d.task_id = NEW.task_id AND (w.status <> 'PROPOSED' OR w.decided_at IS NOT NULL))
    ) THEN
      RAISE EXCEPTION 'measurement binding outside scope, not approved, not predeclared or after delivery was decided' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only a single dissolution by a member may change a binding.
    IF OLD.dissolved_at IS NOT NULL OR NEW.dissolved_at IS NULL
      OR (NEW.id, NEW.business_id, NEW.campaign_id, NEW.run_id, NEW.task_id, NEW.opportunity_id, NEW.plan_id, NEW.request_key,
          NEW.bound_by_user_id, NEW.bound_by_actor, NEW.origin_provider, NEW.origin_model, NEW.bound_at)
        IS DISTINCT FROM (OLD.id, OLD.business_id, OLD.campaign_id, OLD.run_id, OLD.task_id, OLD.opportunity_id, OLD.plan_id, OLD.request_key,
          OLD.bound_by_user_id, OLD.bound_by_actor, OLD.origin_provider, OLD.origin_model, OLD.bound_at)
      OR NOT record_member(NEW.business_id, NEW.dissolved_by_user_id) THEN
      RAISE EXCEPTION 'a measurement binding is append-only; it can only be dissolved once' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS marketing_campaign_measurement_guard ON marketing_campaign_measurement_bindings;
CREATE TRIGGER marketing_campaign_measurement_guard BEFORE INSERT OR UPDATE ON marketing_campaign_measurement_bindings FOR EACH ROW EXECUTE FUNCTION guard_campaign_measurement_binding();
DROP TRIGGER IF EXISTS marketing_campaign_measurement_no_delete ON marketing_campaign_measurement_bindings;
CREATE TRIGGER marketing_campaign_measurement_no_delete BEFORE DELETE ON marketing_campaign_measurement_bindings FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
DROP TRIGGER IF EXISTS marketing_campaign_measurement_no_truncate ON marketing_campaign_measurement_bindings;
CREATE TRIGGER marketing_campaign_measurement_no_truncate BEFORE TRUNCATE ON marketing_campaign_measurement_bindings EXECUTE FUNCTION prevent_append_only_mutation();
