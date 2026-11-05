CREATE TABLE IF NOT EXISTS market_agent_media_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_budget'
    CHECK (status IN ('awaiting_budget', 'approved', 'running', 'complete', 'failed', 'cancelled')),
  aspect_ratio TEXT NOT NULL,
  resolution TEXT NOT NULL,
  duration_seconds INTEGER,
  estimated_cost_cents INTEGER NOT NULL CHECK (estimated_cost_cents > 0),
  approved_budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (approved_budget_cents >= 0),
  actual_cost_cents INTEGER CHECK (actual_cost_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  external_id TEXT NOT NULL DEFAULT '',
  asset_url TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  usage JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_agent_media_jobs_owner_project_idx
  ON market_agent_media_jobs (user_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS market_agent_media_jobs_running_idx
  ON market_agent_media_jobs (status, updated_at DESC)
  WHERE status = 'running';
