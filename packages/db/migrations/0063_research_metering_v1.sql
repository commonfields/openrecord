-- Research call metering: every catalog endpoint call is recorded, and calls
-- served on OpenRecord's own provider account are paid from the account's
-- prepaid research credit.
--
-- research_calls is the audit log: one row per endpoint call, with whose
-- credential served it (the business's own connection, a public route that
-- needs none, or OpenRecord's platform account), the outcome, its duration
-- and what it cost. Credentials are never stored here.
--
-- research_credit_entries is the credit ledger. The balance is the sum of an
-- account's entries: a TOPUP adds credit, a CHARGE (negative) is taken before
-- a platform-served call, and a REFUND returns it when the call fails. A call
-- has at most one charge and one refund, so a retried settlement cannot take
-- or return credit twice.
CREATE TABLE IF NOT EXISTS research_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL CHECK (endpoint ~ '^[a-z][a-z0-9_.-]{1,119}$'),
  provider TEXT NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]{1,39}$'),
  credential_source TEXT NOT NULL CHECK (credential_source IN ('BUSINESS', 'PUBLIC', 'PLATFORM')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
  failure TEXT NULL CHECK (failure IS NULL OR failure ~ '^[A-Z_]{1,40}$'),
  cost_micro BIGINT NOT NULL DEFAULT 0 CHECK (cost_micro >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NULL,
  duration_ms INTEGER NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CHECK ((status = 'PENDING') = (finished_at IS NULL)),
  CHECK (credential_source = 'PLATFORM' OR cost_micro = 0)
);
CREATE INDEX IF NOT EXISTS research_calls_account_started ON research_calls(account_id, started_at DESC);
CREATE INDEX IF NOT EXISTS research_calls_business_started ON research_calls(business_id, started_at DESC);

CREATE TABLE IF NOT EXISTS research_credit_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('TOPUP', 'CHARGE', 'REFUND')),
  amount_micro BIGINT NOT NULL,
  call_id UUID NULL REFERENCES research_calls(id) ON DELETE SET NULL,
  note TEXT NULL CHECK (note IS NULL OR length(note) <= 200),
  created_by_user_id UUID NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((kind = 'CHARGE') = (amount_micro < 0)),
  CHECK (amount_micro <> 0),
  CHECK ((kind = 'TOPUP') = (call_id IS NULL))
);
CREATE INDEX IF NOT EXISTS research_credit_entries_account ON research_credit_entries(account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS research_credit_entries_call_kind ON research_credit_entries(call_id, kind) WHERE call_id IS NOT NULL;
