-- Saved playbooks: an account's own reusable requests for the agent (an
-- agency's weekly SEO review, a launch checklist), available as /name in the
-- composer for every business in the account. Choosing one types its prompt;
-- nothing runs until a person sends it. {business} in a prompt becomes the
-- business's name.
CREATE TABLE IF NOT EXISTS agent_playbooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{1,39}$'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 4000),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, name)
);
