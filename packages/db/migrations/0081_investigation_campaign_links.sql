-- An append-only investigation note may name one campaign of the same business
-- and the campaign revision the server read when the note was saved. Live
-- campaign state is always read from campaign records, never from the note.
ALTER TABLE growth_investigation_notes
  ADD COLUMN IF NOT EXISTS campaign_id UUID,
  ADD COLUMN IF NOT EXISTS campaign_revision INTEGER;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'growth_investigation_notes_campaign_link_check') THEN
    ALTER TABLE growth_investigation_notes ADD CONSTRAINT growth_investigation_notes_campaign_link_check
      CHECK ((campaign_id IS NULL) = (campaign_revision IS NULL) AND (campaign_revision IS NULL OR campaign_revision > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'growth_investigation_notes_campaign_fk') THEN
    ALTER TABLE growth_investigation_notes ADD CONSTRAINT growth_investigation_notes_campaign_fk
      FOREIGN KEY (business_id, campaign_id) REFERENCES marketing_campaigns(business_id, id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS growth_investigation_note_campaign ON growth_investigation_notes(investigation_id, business_id, sequence DESC)
  WHERE campaign_id IS NOT NULL;
