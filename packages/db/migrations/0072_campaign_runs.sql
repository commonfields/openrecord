CREATE TABLE IF NOT EXISTS marketing_campaign_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  campaign_id uuid NOT NULL,
  campaign_revision integer NOT NULL CHECK (campaign_revision > 0),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  snapshot jsonb NOT NULL,
  playbook_version integer NOT NULL DEFAULT 1 CHECK (playbook_version = 1),
  cancelled_at timestamptz,
  cancelled_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, campaign_id, campaign_revision),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, campaign_id) REFERENCES marketing_campaigns(business_id, id)
);
CREATE TABLE IF NOT EXISTS marketing_campaign_deliveries (
  business_id uuid NOT NULL,
  run_id uuid NOT NULL,
  task_id uuid NOT NULL,
  wordpress_change_id uuid NOT NULL REFERENCES wordpress_changes(id),
  linked_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, task_id),
  UNIQUE (run_id, wordpress_change_id),
  FOREIGN KEY (business_id, run_id) REFERENCES marketing_campaign_runs(business_id, id)
);
