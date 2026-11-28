-- A monthly limit on what one business's research may spend on OpenRecord's
-- own provider accounts. Checked when a paid call takes its price from the
-- account's research credit; calls on the business's own connection or a
-- public route are never charged, so the limit never stops them. No row, or a
-- NULL limit, means no limit beyond the credit itself.
CREATE TABLE IF NOT EXISTS business_research_budgets (
  business_id uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  monthly_limit_micro bigint CHECK (monthly_limit_micro IS NULL OR (monthly_limit_micro >= 0 AND monthly_limit_micro <= 100000000000)),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
