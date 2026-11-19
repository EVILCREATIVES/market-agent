ALTER TABLE market_agent_ai_usage_events
  ADD COLUMN IF NOT EXISTS estimated_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (estimated_cost_cents >= 0);

CREATE TABLE IF NOT EXISTS market_agent_owner_cost_controls (
  control_key TEXT PRIMARY KEY,
  monthly_cap_cents INTEGER NOT NULL CHECK (monthly_cap_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

