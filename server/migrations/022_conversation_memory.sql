CREATE TABLE IF NOT EXISTS market_agent_project_memory (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  pinned_notes JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS market_agent_conversation_archives (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  local_day DATE NOT NULL,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  message_count INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, project_id, local_day)
);

CREATE INDEX IF NOT EXISTS market_agent_conversation_archives_project_day_idx
  ON market_agent_conversation_archives (user_id, project_id, local_day DESC);

CREATE INDEX IF NOT EXISTS market_agent_project_messages_content_fts_idx
  ON market_agent_project_messages USING GIN (to_tsvector('simple', COALESCE(data->>'content', '')));
