CREATE TABLE IF NOT EXISTS market_agent_user_api_credentials (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'google', 'anthropic')),
  encrypted_key TEXT NOT NULL,
  key_hint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'invalid')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider)
);

CREATE INDEX IF NOT EXISTS market_agent_user_api_credentials_owner_idx
  ON market_agent_user_api_credentials (user_id, updated_at DESC);
