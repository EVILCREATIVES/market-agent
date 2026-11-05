CREATE TABLE IF NOT EXISTS market_agent_project_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('upload', 'link')),
  asset_kind TEXT NOT NULL CHECK (asset_kind IN ('document', 'image', 'video', 'figma', 'link')),
  mime_type TEXT NOT NULL DEFAULT '',
  size_bytes BIGINT NOT NULL DEFAULT 0,
  blob_path TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'analyzing' CHECK (status IN ('analyzing', 'ready', 'failed')),
  tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  summary TEXT NOT NULL DEFAULT '',
  recommendation TEXT NOT NULL DEFAULT 'review' CHECK (recommendation IN ('reuse', 'adapt', 'replace', 'archive', 'review')),
  rationale TEXT NOT NULL DEFAULT '',
  suggested_changes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_agent_project_assets_owner_project_idx
  ON market_agent_project_assets (user_id, project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS market_agent_asset_proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pdf', 'deck')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rationale TEXT NOT NULL DEFAULT '',
  source_asset_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'awaiting_approval'
    CHECK (status IN ('awaiting_approval', 'approved', 'running', 'complete', 'failed', 'cancelled')),
  estimated_cost_cents INTEGER NOT NULL DEFAULT 15 CHECK (estimated_cost_cents >= 0),
  approved_budget_cents INTEGER NOT NULL DEFAULT 0 CHECK (approved_budget_cents >= 0),
  actual_cost_cents INTEGER CHECK (actual_cost_cents >= 0),
  blob_path TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS market_agent_asset_proposals_owner_project_idx
  ON market_agent_asset_proposals (user_id, project_id, created_at DESC);
