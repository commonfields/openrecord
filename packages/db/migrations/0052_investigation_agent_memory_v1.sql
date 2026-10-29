-- Working memory has explicit authorship. Assistant notes never become human
-- judgments, approvals, verified observations, or execution records.
ALTER TABLE growth_investigations
  ADD COLUMN IF NOT EXISTS created_by_actor TEXT NOT NULL DEFAULT 'OPERATOR' CHECK (created_by_actor IN ('OPERATOR', 'ASSISTANT')),
  ADD COLUMN IF NOT EXISTS origin_provider TEXT CHECK (origin_provider IS NULL OR length(origin_provider) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS origin_model TEXT CHECK (origin_model IS NULL OR length(origin_model) BETWEEN 1 AND 200);
ALTER TABLE growth_investigation_notes
  ADD COLUMN IF NOT EXISTS sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  ADD COLUMN IF NOT EXISTS work_state TEXT CHECK (work_state IS NULL OR work_state IN ('OPEN', 'WAITING_FOR_INPUT', 'CLOSED')),
  ADD COLUMN IF NOT EXISTS resume_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS await_proposal_id UUID REFERENCES agent_proposals(id),
  ADD COLUMN IF NOT EXISTS created_by_actor TEXT NOT NULL DEFAULT 'OPERATOR' CHECK (created_by_actor IN ('OPERATOR', 'ASSISTANT')),
  ADD COLUMN IF NOT EXISTS origin_provider TEXT CHECK (origin_provider IS NULL OR length(origin_provider) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS origin_model TEXT CHECK (origin_model IS NULL OR length(origin_model) BETWEEN 1 AND 200),
  ADD COLUMN IF NOT EXISTS revision_reason TEXT CHECK (revision_reason IS NULL OR length(trim(revision_reason)) BETWEEN 1 AND 2000);
CREATE UNIQUE INDEX IF NOT EXISTS growth_investigation_note_sequence ON growth_investigation_notes(sequence);
CREATE INDEX IF NOT EXISTS growth_investigation_note_history ON growth_investigation_notes(investigation_id, business_id, sequence DESC);
CREATE INDEX IF NOT EXISTS growth_investigation_note_state ON growth_investigation_notes(investigation_id, business_id, sequence DESC) WHERE work_state IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_growth_investigation_memory() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Investigation history is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Append a revision rather than rewriting investigation history' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM businesses b JOIN account_users u ON u.account_id = b.account_id
    WHERE b.id = NEW.business_id AND u.user_id = NEW.created_by_user_id) THEN
    RAISE EXCEPTION 'Investigation author is not in scope' USING ERRCODE = '23514';
  END IF;
  IF TG_TABLE_NAME = 'growth_investigation_notes' THEN
    IF NEW.resume_after IS NOT NULL OR NEW.await_proposal_id IS NOT NULL THEN
      IF NEW.work_state IS DISTINCT FROM 'WAITING_FOR_INPUT' OR
        (NEW.resume_after IS NOT NULL AND NEW.await_proposal_id IS NOT NULL) THEN
        RAISE EXCEPTION 'A follow-up requires one waiting condition' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.await_proposal_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM agent_proposals WHERE id = NEW.await_proposal_id AND business_id = NEW.business_id
    ) THEN
      RAISE EXCEPTION 'Follow-up proposal is not in scope' USING ERRCODE = '23514';
    END IF;
    IF NEW.created_by_actor = 'ASSISTANT' AND NEW.kind = 'REVISION' AND NEW.revision_reason IS NULL THEN
      RAISE EXCEPTION 'An assistant revision requires a reason' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS growth_investigations_memory_guard ON growth_investigations;
CREATE TRIGGER growth_investigations_memory_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_investigations
  FOR EACH ROW EXECUTE FUNCTION guard_growth_investigation_memory();
DROP TRIGGER IF EXISTS growth_investigation_notes_memory_guard ON growth_investigation_notes;
CREATE TRIGGER growth_investigation_notes_memory_guard BEFORE INSERT OR UPDATE OR DELETE ON growth_investigation_notes
  FOR EACH ROW EXECUTE FUNCTION guard_growth_investigation_memory();
