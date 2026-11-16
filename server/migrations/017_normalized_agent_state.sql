CREATE TABLE IF NOT EXISTS market_agent_runs (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS market_agent_runs_project_created_idx
  ON market_agent_runs (user_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_agent_schedules (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS market_agent_project_messages (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX IF NOT EXISTS market_agent_project_messages_project_created_idx
  ON market_agent_project_messages (user_id, project_id, created_at ASC);
