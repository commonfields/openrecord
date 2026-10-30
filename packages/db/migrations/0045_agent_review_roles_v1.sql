-- Two more helper roles: a reviewer that critiques work and a fact-checker
-- that confirms claims against fresh evidence, usually on another provider.
ALTER TABLE agent_conversations DROP CONSTRAINT IF EXISTS agent_conversations_session_check;
ALTER TABLE agent_conversations ADD CONSTRAINT agent_conversations_session_check CHECK (
  depth BETWEEN 0 AND 3 AND (parent_conversation_id IS NULL OR parent_conversation_id <> id)
  AND (task_title IS NULL OR length(task_title) BETWEEN 1 AND 120)
  AND (task_role IS NULL OR task_role IN ('general','researcher','seo','aeo','content','analyst','reviewer','verifier')));
ALTER TABLE agent_tasks DROP CONSTRAINT IF EXISTS agent_tasks_role_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_role_check CHECK (role IN ('general','researcher','seo','aeo','content','analyst','reviewer','verifier'));
