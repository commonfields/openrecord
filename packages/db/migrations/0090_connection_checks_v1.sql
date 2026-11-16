-- Connection health: the last time OpenRecord checked that each connection
-- still works, and what it found. One row per connection, whichever table
-- holds the connection itself (Google sign-ins, ad sign-ins, Stripe keys,
-- WordPress and Webflow credentials).
--
-- A check is one cheap authenticated read. A credential the provider refuses
-- is also marked on its own connection (REVOKED or REAUTHORIZATION_REQUIRED),
-- so the connection table stays the source of truth for whether it can be
-- used; this table says when that was last confirmed and keeps a failure the
-- provider did not explain (a timeout, an outage) visible without guessing it
-- means the person must reconnect.
CREATE TABLE IF NOT EXISTS connection_checks (
  connector TEXT NOT NULL CHECK (connector IN ('google', 'google_ads', 'google_business', 'meta', 'stripe', 'wordpress', 'webflow')),
  connection_id TEXT NOT NULL CHECK (connection_id ~ '^[0-9a-f-]{36}$'),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Null until the first check finishes (the row is created when a check is claimed).
  result TEXT NULL CHECK (result IN ('OK', 'NEEDS_RECONNECT', 'FAILING')),
  -- A stable reason word, never provider text.
  reason TEXT NULL CHECK (reason ~ '^[A-Za-z0-9_]{1,80}$'),
  checked_at TIMESTAMPTZ NULL,
  -- When the connection last passed a check; kept across failures.
  last_ok_at TIMESTAMPTZ NULL,
  -- Consecutive checks that did not pass.
  failures INT NOT NULL DEFAULT 0 CHECK (failures >= 0),
  next_check_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ NULL,
  PRIMARY KEY (connector, connection_id),
  CHECK (result IS NULL AND reason IS NULL AND checked_at IS NULL OR result IS NOT NULL AND checked_at IS NOT NULL AND (result = 'OK') = (reason IS NULL))
);
CREATE INDEX IF NOT EXISTS connection_checks_due ON connection_checks(next_check_at);
CREATE INDEX IF NOT EXISTS connection_checks_account ON connection_checks(account_id);
