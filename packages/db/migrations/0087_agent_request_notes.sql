-- Notes the person sends while a turn is under way ("steering").
--
-- A message typed while the agent works no longer waits for the turn to end
-- or stops it: it is kept here against the request, and the run reads it
-- between model steps, beside the tool results, as the person's latest
-- instruction. `read_at` is set when a run takes it; a note no run took (the
-- answer was already being written) stays unread and the client sends it as
-- the next message. The read notes are kept on the turn's user message in the
-- conversation, so later turns see them too.
--
-- Additive and replay-safe: every statement is idempotent.

CREATE TABLE IF NOT EXISTS agent_request_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS agent_request_notes_unread ON agent_request_notes(request_id, created_at) WHERE read_at IS NULL;
