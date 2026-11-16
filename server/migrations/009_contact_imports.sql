CREATE TABLE IF NOT EXISTS market_agent_contact_imports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_asset_id TEXT NOT NULL DEFAULT '',
  source_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','importing','imported','partial','failed')),
  contacts JSONB NOT NULL DEFAULT '[]'::jsonb,
  column_map JSONB NOT NULL DEFAULT '{}'::jsonb,
  total_count INTEGER NOT NULL DEFAULT 0,
  valid_count INTEGER NOT NULL DEFAULT 0,
  invalid_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  consented_count INTEGER NOT NULL DEFAULT 0,
  unknown_count INTEGER NOT NULL DEFAULT 0,
  denied_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  import_mode TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_agent_contact_imports_user_project_idx
  ON market_agent_contact_imports (user_id, project_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS market_agent_contact_imports_source_asset_uidx
  ON market_agent_contact_imports (source_asset_id) WHERE source_asset_id <> '';
