-- Google Business Profile on the ad connection tables (0046): one more
-- provider, signed in with Google like Google Ads. Google offers one scope for
-- Business Profile (business.manage), which could edit a profile or reply to
-- reviews; OpenRecord only ever reads with it (accounts, locations,
-- performance, search keywords and reviews). A bound location keeps the
-- Business Profile account it belongs to, which the reviews API needs.
--
-- Additive and replay-safe.
ALTER TABLE ad_connections DROP CONSTRAINT IF EXISTS ad_connections_provider_check;
ALTER TABLE ad_connections ADD CONSTRAINT ad_connections_provider_check CHECK (provider IN ('meta','google_ads','google_business'));
ALTER TABLE ad_connections DROP CONSTRAINT IF EXISTS ad_connections_google_business_scopes_check;
ALTER TABLE ad_connections ADD CONSTRAINT ad_connections_google_business_scopes_check CHECK (provider <> 'google_business' OR (
  granted_scopes <@ ARRAY['openid','email','https://www.googleapis.com/auth/userinfo.email','https://www.googleapis.com/auth/business.manage']
  AND 'https://www.googleapis.com/auth/business.manage' = ANY(granted_scopes)));
ALTER TABLE ad_oauth_states DROP CONSTRAINT IF EXISTS ad_oauth_states_provider_check;
ALTER TABLE ad_oauth_states ADD CONSTRAINT ad_oauth_states_provider_check CHECK (provider IN ('meta','google_ads','google_business'));
ALTER TABLE ad_account_bindings DROP CONSTRAINT IF EXISTS ad_account_bindings_provider_check;
ALTER TABLE ad_account_bindings ADD CONSTRAINT ad_account_bindings_provider_check CHECK (provider IN ('meta','google_ads','google_business'));
ALTER TABLE ad_account_bindings ADD COLUMN IF NOT EXISTS parent_id TEXT NULL;
ALTER TABLE ad_account_bindings DROP CONSTRAINT IF EXISTS ad_account_bindings_parent_id_check;
ALTER TABLE ad_account_bindings ADD CONSTRAINT ad_account_bindings_parent_id_check CHECK (
  (parent_id IS NULL OR parent_id ~ '^[0-9]{1,30}$') AND (provider <> 'google_business' OR parent_id IS NOT NULL));
-- Business Profile location IDs can be longer than ad account IDs.
ALTER TABLE ad_account_bindings DROP CONSTRAINT IF EXISTS ad_account_bindings_external_id_check;
ALTER TABLE ad_account_bindings ADD CONSTRAINT ad_account_bindings_external_id_check CHECK (external_id ~ '^[0-9]{1,30}$');
