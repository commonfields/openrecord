-- Existing setups require an explicit Continue; new starts opt in.
ALTER TABLE business_setups ADD COLUMN IF NOT EXISTS auto_advance boolean NOT NULL DEFAULT false;
