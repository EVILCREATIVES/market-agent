ALTER TABLE market_agent_email_suppressions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'suppressed',
  ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_message_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS market_agent_email_suppressions_active_idx
  ON market_agent_email_suppressions (user_id, project_id, email, hold_until);

CREATE TABLE IF NOT EXISTS market_agent_gmail_monitor_state (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  account_email TEXT NOT NULL DEFAULT '',
  history_id TEXT NOT NULL DEFAULT '',
  last_checked_at TIMESTAMPTZ,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, project_id)
);

CREATE TABLE IF NOT EXISTS market_agent_email_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  email TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bounce','auto_reply','human_reply')),
  provider_message_id TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, project_id, provider_message_id)
);

CREATE INDEX IF NOT EXISTS market_agent_email_events_project_idx
  ON market_agent_email_events (user_id, project_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS market_agent_email_events_job_idx
  ON market_agent_email_events (job_id, occurred_at DESC);
