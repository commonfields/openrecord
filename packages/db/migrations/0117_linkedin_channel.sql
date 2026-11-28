-- LinkedIn on the ad connection tables (0046, 0049) and as an account action
-- (0077): post to a company page or the member's own profile, only after a
-- person approves the exact text, and delete it again on undo.
--
-- A LinkedIn member is identified by an alphanumeric person id, not a number,
-- and a LinkedIn binding is an author URN (urn:li:organization:<n> or
-- urn:li:person:<id>), so the numeric checks hold for the other providers
-- only. Scopes are limited to what posting and page statistics need.
--
-- Additive and replay-safe: 0049 keeps these wider checks when it is replayed.
-- A later migration that widens one of them again must guard this file the same way.
ALTER TABLE ad_connections DROP CONSTRAINT IF EXISTS ad_connections_provider_check;
ALTER TABLE ad_connections ADD CONSTRAINT ad_connections_provider_check CHECK (provider IN ('meta','google_ads','google_business','linkedin'));
ALTER TABLE ad_connections DROP CONSTRAINT IF EXISTS ad_connections_subject_check;
ALTER TABLE ad_connections ADD CONSTRAINT ad_connections_subject_check CHECK (
  CASE WHEN provider = 'linkedin' THEN subject ~ '^[A-Za-z0-9_-]{1,64}$' ELSE subject ~ '^[0-9]{1,30}$' END);
ALTER TABLE ad_connections DROP CONSTRAINT IF EXISTS ad_connections_linkedin_scopes_check;
ALTER TABLE ad_connections ADD CONSTRAINT ad_connections_linkedin_scopes_check CHECK (provider <> 'linkedin' OR (
  granted_scopes <@ ARRAY['openid','profile','email','w_member_social','w_organization_social','r_organization_social','rw_organization_admin']
  AND ('w_member_social' = ANY(granted_scopes) OR 'w_organization_social' = ANY(granted_scopes))));

ALTER TABLE ad_oauth_states DROP CONSTRAINT IF EXISTS ad_oauth_states_provider_check;
ALTER TABLE ad_oauth_states ADD CONSTRAINT ad_oauth_states_provider_check CHECK (provider IN ('meta','google_ads','google_business','linkedin'));

ALTER TABLE ad_account_bindings DROP CONSTRAINT IF EXISTS ad_account_bindings_provider_check;
ALTER TABLE ad_account_bindings ADD CONSTRAINT ad_account_bindings_provider_check CHECK (provider IN ('meta','google_ads','google_business','linkedin'));
ALTER TABLE ad_account_bindings DROP CONSTRAINT IF EXISTS ad_account_bindings_external_id_check;
ALTER TABLE ad_account_bindings ADD CONSTRAINT ad_account_bindings_external_id_check CHECK (
  CASE WHEN provider = 'linkedin' THEN external_id ~ '^urn:li:(organization:[0-9]{1,30}|person:[A-Za-z0-9_-]{1,64})$' ELSE external_id ~ '^[0-9]{1,30}$' END);

ALTER TABLE account_actions DROP CONSTRAINT IF EXISTS account_actions_provider_check;
ALTER TABLE account_actions ADD CONSTRAINT account_actions_provider_check CHECK (provider IN ('google_business','google_ads','linkedin'));
ALTER TABLE account_actions DROP CONSTRAINT IF EXISTS account_actions_kind_check;
ALTER TABLE account_actions ADD CONSTRAINT account_actions_kind_check
  CHECK (kind IN ('REPLY_TO_REVIEW','PAUSE_CAMPAIGN','ENABLE_CAMPAIGN','SET_DAILY_BUDGET','CREATE_SEARCH_AD','PUBLISH_POST'));
ALTER TABLE account_actions DROP CONSTRAINT IF EXISTS account_actions_linkedin_kind_check;
ALTER TABLE account_actions ADD CONSTRAINT account_actions_linkedin_kind_check CHECK ((provider = 'linkedin') = (kind = 'PUBLISH_POST'));
