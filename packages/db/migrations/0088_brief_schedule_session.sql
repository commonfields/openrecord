-- Keep the weekly brief control in the chat where it was enabled.
ALTER TABLE growth_brief_schedules ADD COLUMN IF NOT EXISTS conversation_id uuid
  REFERENCES agent_conversations(id) ON DELETE SET NULL;

-- Existing schedules belong to their latest generated weekly-brief chat.
UPDATE growth_brief_schedules s SET conversation_id = (
  SELECT b.conversation_id FROM growth_briefs b
  JOIN agent_conversations c ON c.id = b.conversation_id
  WHERE b.business_id = s.business_id AND b.account_id = s.account_id
    AND c.business_id = s.business_id AND c.account_id = s.account_id AND c.user_id = s.user_id
  ORDER BY b.started_at DESC LIMIT 1
) WHERE s.conversation_id IS NULL;
