CREATE TABLE IF NOT EXISTS market_agent_metric_snapshots (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  captured_on DATE NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  account JSONB NOT NULL DEFAULT '{}'::jsonb,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, project_id, provider, captured_on)
);

CREATE INDEX IF NOT EXISTS market_agent_metric_snapshots_lookup_idx
  ON market_agent_metric_snapshots (user_id, project_id, provider, captured_at DESC);
