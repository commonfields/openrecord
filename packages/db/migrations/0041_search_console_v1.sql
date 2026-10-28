-- Read-only Google Search Console through the existing Google connection.
-- A connection may now hold webmasters.readonly next to (or instead of)
-- analytics.readonly; nothing broader is ever accepted. One Search Console
-- site is bound to one business at a time. Bindings are append-only history:
-- ending one sets ended_at, and a new binding is a new row. Performance numbers
-- are read live from Google and not stored here.
--
-- Additive and replay-safe: every statement is idempotent.

-- Either read scope is enough; the allowed set gains webmasters.readonly.
ALTER TABLE growth_ga4_connections DROP CONSTRAINT IF EXISTS growth_ga4_connections_granted_scopes_check;
ALTER TABLE growth_ga4_connections ADD CONSTRAINT growth_ga4_connections_granted_scopes_check CHECK (
  ('https://www.googleapis.com/auth/analytics.readonly' = ANY(granted_scopes) OR 'https://www.googleapis.com/auth/webmasters.readonly' = ANY(granted_scopes))
  AND granted_scopes <@ ARRAY['openid','email','https://www.googleapis.com/auth/analytics.readonly','https://www.googleapis.com/auth/webmasters.readonly','https://www.googleapis.com/auth/userinfo.email']);

-- Where the operator lands after Google. Set when the authorization starts; never changed.
ALTER TABLE growth_ga4_oauth_states ADD COLUMN IF NOT EXISTS return_to TEXT NOT NULL DEFAULT 'MEASUREMENT';
ALTER TABLE growth_ga4_oauth_states DROP CONSTRAINT IF EXISTS growth_ga4_oauth_states_return_to_check;
ALTER TABLE growth_ga4_oauth_states ADD CONSTRAINT growth_ga4_oauth_states_return_to_check CHECK (return_to IN ('MEASUREMENT','CHANNELS'));
CREATE OR REPLACE FUNCTION guard_growth_ga4_oauth_state() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM account_users WHERE account_id = NEW.account_id AND user_id = NEW.user_id)
       OR NOT EXISTS (SELECT 1 FROM businesses WHERE id = NEW.business_id AND account_id = NEW.account_id) THEN
      RAISE EXCEPTION 'ga4 authorization outside scope';
    END IF;
    IF NEW.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'ga4 authorization starts unconsumed'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.consumed_at IS NOT NULL OR NEW.consumed_at IS NULL
     OR (NEW.id, NEW.account_id, NEW.user_id, NEW.business_id, NEW.connection_id, NEW.state_sha256, NEW.verifier_ciphertext, NEW.expires_at, NEW.created_at, NEW.return_to)
        IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.user_id, OLD.business_id, OLD.connection_id, OLD.state_sha256, OLD.verifier_ciphertext, OLD.expires_at, OLD.created_at, OLD.return_to) THEN
    RAISE EXCEPTION 'ga4 authorization state is single use';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS search_console_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL,
  site_url TEXT NOT NULL CHECK (length(site_url) <= 2048 AND site_url ~ '^(sc-domain:[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?|https?://[^[:space:]/?#]+(/[^[:space:]?#]*)?/)$'),
  permission_level TEXT NOT NULL CHECK (permission_level IN ('siteOwner','siteFullUser','siteRestrictedUser')),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  ended_by_user_id UUID REFERENCES users(id),
  CHECK ((ended_at IS NULL) = (ended_by_user_id IS NULL)),
  FOREIGN KEY (connection_id, account_id) REFERENCES growth_ga4_connections(id, account_id)
);
-- One active site per business.
CREATE UNIQUE INDEX IF NOT EXISTS search_console_bindings_active ON search_console_bindings(business_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS search_console_bindings_business ON search_console_bindings(business_id, created_at DESC);

CREATE OR REPLACE FUNCTION guard_search_console_binding() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Deleting the business removes its history; nothing else deletes a binding.
    IF EXISTS (SELECT 1 FROM businesses WHERE id = OLD.business_id) THEN RAISE EXCEPTION 'search console bindings keep their history'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = NEW.business_id AND account_id = NEW.account_id)
       OR NOT EXISTS (SELECT 1 FROM account_users WHERE account_id = NEW.account_id AND user_id = NEW.created_by_user_id) THEN
      RAISE EXCEPTION 'search console binding outside scope';
    END IF;
    IF NEW.ended_at IS NOT NULL THEN RAISE EXCEPTION 'search console bindings start active'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
     OR (NEW.id, NEW.account_id, NEW.business_id, NEW.connection_id, NEW.site_url, NEW.permission_level, NEW.created_by_user_id, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.account_id, OLD.business_id, OLD.connection_id, OLD.site_url, OLD.permission_level, OLD.created_by_user_id, OLD.created_at) THEN
    RAISE EXCEPTION 'a search console binding only ends, once';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS search_console_binding_guard ON search_console_bindings;
CREATE TRIGGER search_console_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON search_console_bindings FOR EACH ROW EXECUTE FUNCTION guard_search_console_binding();
