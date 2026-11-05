-- Only newly started setups opt in; existing manual workflows must not be
-- silently advanced when a server is upgraded.
ALTER TABLE business_setups ADD COLUMN IF NOT EXISTS auto_advance boolean NOT NULL DEFAULT false;
