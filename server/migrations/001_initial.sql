CREATE TABLE IF NOT EXISTS market_agent_states (
  user_id TEXT PRIMARY KEY,
  state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_agent_states_updated_at_idx
  ON market_agent_states (updated_at DESC);

CREATE TABLE IF NOT EXISTS market_agent_connections (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL DEFAULT '',
  account_label TEXT NOT NULL DEFAULT '',
  account_email TEXT NOT NULL DEFAULT '',
  encrypted_credentials TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'connected',
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider)
);

CREATE INDEX IF NOT EXISTS market_agent_connections_updated_at_idx
  ON market_agent_connections (updated_at DESC);
