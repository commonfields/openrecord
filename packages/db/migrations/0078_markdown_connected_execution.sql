-- Carry the historical exact Markdown edits into W7, not its old 0031
-- lifecycle. In particular, never add delivery states to human decisions.
-- Retain the function name used by existing table/target constraints.
CREATE OR REPLACE FUNCTION growth_execution_html_path(p TEXT) RETURNS BOOLEAN AS $$
  SELECT p IS NOT NULL AND length(p) BETWEEN 1 AND 300
    AND p ~ '^([A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$'
    AND p ~* '\.(html?|mdx?)$'
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE growth_execution_operations DROP CONSTRAINT IF EXISTS growth_execution_operations_action_kind_check;
ALTER TABLE growth_execution_operations ADD CONSTRAINT growth_execution_operations_action_kind_check
  CHECK (action_kind IN ('REMOVE_NOINDEX_META','SET_TITLE','SET_META_DESCRIPTION','SET_CANONICAL','ADD_JSON_LD','SET_IMAGE_ALT','REPLACE_MARKDOWN'));
ALTER TABLE growth_execution_operations DROP CONSTRAINT IF EXISTS growth_execution_kind_path_check;
ALTER TABLE growth_execution_operations ADD CONSTRAINT growth_execution_kind_path_check
  CHECK ((action_kind='REPLACE_MARKDOWN' AND file_path ~* '\.mdx?$') OR (action_kind<>'REPLACE_MARKDOWN' AND file_path ~* '\.html?$'));
