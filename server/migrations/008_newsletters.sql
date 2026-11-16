CREATE TABLE IF NOT EXISTS market_agent_newsletters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT '',
  draft JSONB NOT NULL DEFAULT '{}'::jsonb,
  html TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preparing','scheduled','sent','failed')),
  external_id TEXT NOT NULL DEFAULT '',
  archive_url TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  approved_at TIMESTAMPTZ,
  scheduled_for TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_agent_newsletters_user_project_idx
  ON market_agent_newsletters (user_id, project_id, created_at DESC);
