CREATE TABLE IF NOT EXISTS market_agent_model_usage_measurements (
  measurement_key TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO market_agent_model_usage_measurements (measurement_key, started_at, ends_at)
VALUES ('utility-router-v1', NOW(), NOW() + INTERVAL '30 days')
ON CONFLICT (measurement_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS market_agent_model_usage_events (
  id BIGSERIAL PRIMARY KEY,
  measurement_key TEXT NOT NULL REFERENCES market_agent_model_usage_measurements(measurement_key),
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  access_mode TEXT NOT NULL,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tier TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  actual_cost_microusd BIGINT CHECK (actual_cost_microusd >= 0),
  baseline_cost_microusd BIGINT CHECK (baseline_cost_microusd >= 0),
  savings_microusd BIGINT,
  fallback BOOLEAN NOT NULL DEFAULT FALSE,
  succeeded BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_agent_model_usage_user_window_idx
  ON market_agent_model_usage_events (user_id, measurement_key, created_at DESC);
