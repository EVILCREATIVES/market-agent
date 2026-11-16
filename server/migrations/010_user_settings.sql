CREATE TABLE IF NOT EXISTS market_agent_user_settings (
  user_id TEXT PRIMARY KEY,
  media_monthly_budget_cents INTEGER NOT NULL DEFAULT 2500 CHECK (media_monthly_budget_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
