CREATE TABLE IF NOT EXISTS market_agent_delivery_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('gmail','linkedin','instagram','tiktok','x')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('awaiting_approval','running','submitted','complete','failed','cancelled')),
  external_id TEXT NOT NULL DEFAULT '',
  result JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT NOT NULL DEFAULT '',
  approved_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_agent_delivery_jobs_user_project_run_idx
  ON market_agent_delivery_jobs (user_id, project_id, run_id, created_at DESC);
