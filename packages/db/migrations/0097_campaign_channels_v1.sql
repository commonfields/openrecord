-- Campaign channels the owner sends themselves (an email, a post), traced to
-- the campaign page they point at.
--
-- campaign_links gives each email or post deliverable its own link to a
-- campaign page, so views and inquiries can be read by source. A link is
-- created for one deliverable of the same campaign as the page.
CREATE TABLE IF NOT EXISTS campaign_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  publication_id UUID NOT NULL REFERENCES campaign_publications(id) ON DELETE CASCADE,
  task_id UUID NOT NULL,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Za-z0-9]{10}$'),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 300),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (publication_id, task_id)
);
CREATE TABLE IF NOT EXISTS campaign_link_days (
  link_id UUID NOT NULL REFERENCES campaign_links(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  views INT NOT NULL DEFAULT 0 CHECK (views >= 0),
  PRIMARY KEY (link_id, day)
);
ALTER TABLE campaign_form_tickets ADD COLUMN IF NOT EXISTS link_id UUID NULL REFERENCES campaign_links(id) ON DELETE SET NULL;
ALTER TABLE campaign_inquiries ADD COLUMN IF NOT EXISTS link_id UUID NULL REFERENCES campaign_links(id) ON DELETE SET NULL;

-- The owner's own report that they sent or posted a deliverable. OpenRecord
-- did not send it and cannot verify it; it is shown as the owner's report.
CREATE TABLE IF NOT EXISTS campaign_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL,
  task_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SENT', 'POSTED')),
  public_url TEXT NULL CHECK (public_url IS NULL OR (public_url ~ '^https://[^[:space:]]+$' AND length(public_url) <= 1000)),
  reported_by_user_id UUID NOT NULL REFERENCES users(id),
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, campaign_id) REFERENCES marketing_campaigns(business_id, id) ON DELETE CASCADE,
  UNIQUE (campaign_id, task_id)
);
