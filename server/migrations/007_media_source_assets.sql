ALTER TABLE market_agent_media_jobs
  ADD COLUMN IF NOT EXISTS source_asset_id TEXT NOT NULL DEFAULT '';
