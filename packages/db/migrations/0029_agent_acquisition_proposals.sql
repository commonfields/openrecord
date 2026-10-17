ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS executed_acquisition_batch_id UUID NULL REFERENCES acq_batches(id);
ALTER TABLE agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_kind_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_kind_check CHECK (kind IN ('REQUEST_CHECK','DRAFT_SOURCE_ACTION','PREPARE_CLIENT_REPORT','PROPOSE_QUESTION_SET','REQUEST_ACQUISITION_BATCH'));
ALTER TABLE agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_draft_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_draft_check CHECK ((
  (kind = 'REQUEST_CHECK' AND payload IS NULL AND status <> 'APPROVED') OR
  (kind <> 'REQUEST_CHECK' AND payload IS NOT NULL AND payload->>'kind' = kind AND payload->>'businessId' = business_id::text
    AND (kind = 'REQUEST_ACQUISITION_BATCH' OR status <> 'EXECUTED') AND (kind <> 'REQUEST_ACQUISITION_BATCH' OR status <> 'APPROVED'))
) IS TRUE);
-- Replace the old anonymous execution constraint, including on migration replay.
DO $$ DECLARE c RECORD; BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'agent_proposals'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%executed_check_run_id IS NOT NULL%'
  LOOP EXECUTE format('ALTER TABLE agent_proposals DROP CONSTRAINT %I', c.conname); END LOOP;
END $$;
ALTER TABLE agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_execution_check;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_execution_check CHECK (
  (status = 'EXECUTED') = (executed_check_run_id IS NOT NULL OR executed_acquisition_batch_id IS NOT NULL)
  AND NOT (executed_check_run_id IS NOT NULL AND executed_acquisition_batch_id IS NOT NULL)
  AND (executed_check_run_id IS NULL OR kind = 'REQUEST_CHECK')
  AND (executed_acquisition_batch_id IS NULL OR kind = 'REQUEST_ACQUISITION_BATCH')
);

ALTER TABLE agent_proposals DROP CONSTRAINT IF EXISTS agent_proposals_acq_tenant_fk;
ALTER TABLE agent_proposals ADD CONSTRAINT agent_proposals_acq_tenant_fk FOREIGN KEY (executed_acquisition_batch_id, business_id) REFERENCES acq_batches(id, business_id);
