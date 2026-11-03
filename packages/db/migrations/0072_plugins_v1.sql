-- Plugins: bundles of playbooks, agent guidance and suggested tool servers.
-- OpenRecord ships first-party plugins in code; an account adds its own from
-- a manifest (agent_plugins). A plugin does nothing until it is switched on
-- for a business (business_plugins). Guidance is the team's own text: it
-- shapes how the agent works, and cannot grant tools or lift OpenRecord's
-- rules (no approving, publishing or changing facts).
CREATE TABLE IF NOT EXISTS agent_plugins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,39}$'),
  manifest JSONB NOT NULL,
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);
CREATE TABLE IF NOT EXISTS business_plugins (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plugin TEXT NOT NULL CHECK (plugin ~ '^[a-z][a-z0-9-]{1,39}$'),
  enabled_by_user_id UUID NOT NULL REFERENCES users(id),
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, plugin)
);
