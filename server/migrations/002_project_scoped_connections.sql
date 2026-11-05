ALTER TABLE market_agent_connections
  ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'project-default';

ALTER TABLE market_agent_connections
  ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT '';

ALTER TABLE market_agent_connections
  ADD COLUMN IF NOT EXISTS account_label TEXT NOT NULL DEFAULT '';

ALTER TABLE market_agent_connections
  DROP CONSTRAINT IF EXISTS market_agent_connections_pkey;

CREATE UNIQUE INDEX IF NOT EXISTS market_agent_connections_user_project_provider_uidx
  ON market_agent_connections (user_id, project_id, provider);
