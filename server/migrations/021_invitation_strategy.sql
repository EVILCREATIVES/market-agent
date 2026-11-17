ALTER TABLE market_agent_optin_campaigns
  ADD COLUMN IF NOT EXISTS invitation_strategy TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS invitation_cta_label TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS invitation_url TEXT NOT NULL DEFAULT '';
