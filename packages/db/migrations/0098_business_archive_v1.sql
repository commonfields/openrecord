-- Archiving a business takes it out of the business lists and the scheduled
-- work (weekly briefs) without deleting anything. Restoring clears the mark;
-- its records, chats and connections are as they were.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
