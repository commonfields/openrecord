-- A bridge the OpenRecord app runs on its own computer (the desktop app, or a
-- local dev server with OPENRECORD_LOCAL_BRIDGE on), paired without a code.
--
-- managed: the server started this bridge for the signed-in user. Its
-- providers turn on by themselves once they report ready and signed in.
-- enabled_by_user: the person's own choice from Settings. NULL until they
-- touch the toggle; after that the automatic rule never overrides it.
ALTER TABLE agent_bridges ADD COLUMN IF NOT EXISTS managed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_harness_instances ADD COLUMN IF NOT EXISTS enabled_by_user BOOLEAN NULL;
