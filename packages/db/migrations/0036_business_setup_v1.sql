-- Agent-native onboarding: one resumable setup per business. The row is both
-- the setup record and the homepage discovery job (claim-token pattern from
-- assay_sources), so a crash anywhere leaves state the next run can judge.
--
-- `discovery` holds signals read from a public page. It is untrusted data and
-- never authority: nothing in it becomes a fact, a goal or an initiative until
-- an operator confirms it through a session-authenticated request.
--
-- Additive and replay-safe: every statement is idempotent.
CREATE TABLE IF NOT EXISTS business_setups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  business_id UUID NOT NULL UNIQUE REFERENCES businesses(id),
  website_url TEXT NOT NULL CHECK (website_url ~ '^https?://' AND length(website_url) <= 2000),
  website_host TEXT NOT NULL CHECK (length(website_host) BETWEEN 1 AND 253 AND website_host = lower(website_host)),
  goal_statement TEXT CHECK (goal_statement IS NULL OR (length(goal_statement) <= 1000 AND goal_statement ~ '[^[:space:]]')),
  started_by_user_id UUID NOT NULL REFERENCES users(id),
  discovery_status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (discovery_status IN ('QUEUED','FETCHING','DONE','FAILED')),
  discovery_attempts INT NOT NULL DEFAULT 0 CHECK (discovery_attempts >= 0),
  claim_token UUID,
  claimed_at TIMESTAMPTZ,
  discovered_at TIMESTAMPTZ,
  discovery JSONB,
  discovery_failure TEXT,
  brief JSONB,
  brief_confirmed_by_user_id UUID REFERENCES users(id),
  brief_confirmed_at TIMESTAMPTZ,
  channels_reviewed_by_user_id UUID REFERENCES users(id),
  channels_reviewed_at TIMESTAMPTZ,
  opportunity_id UUID REFERENCES growth_opportunities(id),
  revision INT NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (account_id, website_host),
  CHECK ((brief IS NULL) = (brief_confirmed_at IS NULL) AND (brief_confirmed_at IS NULL) = (brief_confirmed_by_user_id IS NULL)),
  CHECK ((channels_reviewed_at IS NULL) = (channels_reviewed_by_user_id IS NULL)),
  CHECK (discovery_status <> 'DONE' OR (discovery IS NOT NULL AND discovered_at IS NOT NULL)),
  CHECK (discovery_status <> 'FAILED' OR discovery_failure IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_business_setups_queue ON business_setups(discovery_status, created_at);

-- A setup can only name a business of its own account, and the discovery
-- snapshot is evidence: once recorded it is never rewritten, only re-queued
-- by an explicit retry after a failure.
CREATE OR REPLACE FUNCTION business_setups_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM businesses b WHERE b.id = NEW.business_id AND b.account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'business_setups: business % is not in account %', NEW.business_id, NEW.account_id USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.account_id <> OLD.account_id OR NEW.business_id <> OLD.business_id OR NEW.started_by_user_id <> OLD.started_by_user_id THEN
      RAISE EXCEPTION 'business_setups: identity columns are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.discovery_status = 'DONE' AND (NEW.discovery IS DISTINCT FROM OLD.discovery OR NEW.discovery_status <> 'DONE') THEN
      RAISE EXCEPTION 'business_setups: recorded discovery is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.opportunity_id IS NOT NULL AND NEW.opportunity_id IS DISTINCT FROM OLD.opportunity_id THEN
      RAISE EXCEPTION 'business_setups: the first initiative link is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.opportunity_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM growth_opportunities o WHERE o.id = NEW.opportunity_id AND o.business_id = NEW.business_id) THEN
    RAISE EXCEPTION 'business_setups: initiative belongs to another business' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS business_setups_guard ON business_setups;
CREATE TRIGGER business_setups_guard BEFORE INSERT OR UPDATE ON business_setups FOR EACH ROW EXECUTE FUNCTION business_setups_guard();
