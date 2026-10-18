ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS payload JSONB NULL;
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agent_proposals' AND column_name = 'executed_acquisition_batch_id') THEN
ALTER TABLE agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_kind_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_kind_check CHECK (kind IN ('REQUEST_CHECK','DRAFT_SOURCE_ACTION','PREPARE_CLIENT_REPORT'));
END IF; END $$;
ALTER TABLE agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_status_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_status_check CHECK (status IN ('PROPOSED','APPROVED','EXECUTED','REJECTED'));
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agent_proposals' AND column_name = 'executed_acquisition_batch_id') THEN
ALTER TABLE agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_draft_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_draft_check CHECK (
  (kind = 'REQUEST_CHECK' AND payload IS NULL AND status <> 'APPROVED') OR
  (kind <> 'REQUEST_CHECK' AND payload IS NOT NULL AND payload->>'kind' = kind AND payload->>'businessId' = business_id::text AND status <> 'EXECUTED') IS TRUE
);
END IF; END $$;
DROP INDEX IF EXISTS agent_proposals_pending_unique;
CREATE UNIQUE INDEX agent_proposals_pending_unique ON agent_proposals(business_id,kind,question_id) NULLS NOT DISTINCT WHERE status='PROPOSED';
CREATE OR REPLACE FUNCTION guard_agent_proposal_decision() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'PROPOSED' THEN RAISE EXCEPTION 'agent proposal already decided'; END IF;
  IF (NEW.business_id,NEW.kind,NEW.question_id,NEW.message,NEW.payload,NEW.proposer,NEW.proposed_by_user_id,NEW.created_at)
    IS DISTINCT FROM (OLD.business_id,OLD.kind,OLD.question_id,OLD.message,OLD.payload,OLD.proposer,OLD.proposed_by_user_id,OLD.created_at)
    THEN RAISE EXCEPTION 'agent proposal content is immutable; propose again'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
