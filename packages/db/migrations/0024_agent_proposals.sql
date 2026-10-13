-- Agent proposals: human-gated execution of agent-suggested writes.
-- A proposal is a draft the assistant (or an operator driving an
-- integration) records; nothing executes until the operator approves, and
-- approval attributes execution to the approving session user. The tool
-- registry stays read-only: proposals are the only agent write path.
CREATE TABLE agent_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('REQUEST_CHECK')),
  question_id UUID NULL REFERENCES buyer_questions(id) ON DELETE CASCADE,
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  proposer TEXT NOT NULL CHECK (proposer IN ('assistant-v1', 'operator')),
  proposed_by_user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED', 'EXECUTED', 'REJECTED')),
  decided_by_user_id UUID NULL REFERENCES users(id),
  decided_at TIMESTAMPTZ NULL,
  executed_check_run_id UUID NULL REFERENCES check_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'PROPOSED') = (decided_by_user_id IS NULL AND decided_at IS NULL)),
  CHECK ((status = 'EXECUTED') = (executed_check_run_id IS NOT NULL))
);
CREATE INDEX agent_proposals_business_status ON agent_proposals(business_id, status);

-- One decision per proposal: only a PROPOSED row may change status, and the
-- executed run is set exactly once with the decision. Execution itself runs
-- inside the approving transaction (SELECT ... FOR UPDATE in the repo), so
-- concurrent approvals serialize and the loser replays the winner.
CREATE OR REPLACE FUNCTION guard_agent_proposal_decision() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PROPOSED' THEN
    RAISE EXCEPTION 'agent proposal already decided';
  END IF;
  IF NEW.status = 'PROPOSED' THEN
    RAISE EXCEPTION 'agent proposal cannot return to PROPOSED';
  END IF;
  IF (NEW.business_id, NEW.kind, NEW.question_id, NEW.message, NEW.proposer, NEW.proposed_by_user_id, NEW.created_at)
    IS DISTINCT FROM
     (OLD.business_id, OLD.kind, OLD.question_id, OLD.message, OLD.proposer, OLD.proposed_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'agent proposal content is immutable; propose again';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_agent_proposal_decision ON agent_proposals;
CREATE TRIGGER trg_agent_proposal_decision BEFORE UPDATE ON agent_proposals
FOR EACH ROW EXECUTE FUNCTION guard_agent_proposal_decision();
