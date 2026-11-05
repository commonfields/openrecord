CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);
CREATE INDEX IF NOT EXISTS marketing_campaigns_business ON marketing_campaigns(business_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS marketing_campaign_revisions (
  campaign_id uuid NOT NULL REFERENCES marketing_campaigns(id),
  revision integer NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  brief jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, revision)
);
