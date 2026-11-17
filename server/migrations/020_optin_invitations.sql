ALTER TABLE market_agent_optin_campaigns
  ADD COLUMN IF NOT EXISTS invitation_subject TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS invitation_body TEXT NOT NULL DEFAULT '';
