-- GEO citation targets: pages AI answers cite for a business's buyer
-- questions that name its competitors but not the business, kept as a work
-- list with a status the team moves (to contact, pitched, listed, declined,
-- ignored). Evidence counts come from saved AI answers; "listed" is only
-- confirmed when a re-read of the page finds the business named
-- (verified_at, verified_mention). Nothing is contacted automatically.
CREATE TABLE IF NOT EXISTS geo_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 600),
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 253),
  source_type TEXT NOT NULL CHECK (length(source_type) BETWEEN 1 AND 40),
  citations INTEGER NOT NULL DEFAULT 0 CHECK (citations >= 0),
  competitors TEXT[] NOT NULL DEFAULT '{}',
  questions TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'TO_CONTACT' CHECK (status IN ('TO_CONTACT', 'PITCHED', 'LISTED', 'DECLINED', 'IGNORED')),
  note TEXT NULL CHECK (note IS NULL OR length(note) <= 500),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_cited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ NULL,
  verified_mention BOOLEAN NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, url)
);
CREATE INDEX IF NOT EXISTS geo_targets_business ON geo_targets(business_id, status, citations DESC);
