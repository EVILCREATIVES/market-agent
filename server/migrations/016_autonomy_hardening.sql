ALTER TABLE market_agent_states
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE market_agent_delivery_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS market_agent_delivery_jobs_idempotency_uidx
  ON market_agent_delivery_jobs (user_id, idempotency_key)
  WHERE idempotency_key <> '';

CREATE INDEX IF NOT EXISTS market_agent_delivery_jobs_due_idx
  ON market_agent_delivery_jobs (status, next_attempt_at, updated_at);

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'market_agent_delivery_jobs'::regclass
      AND conname = 'market_agent_delivery_jobs_status_check'
  ) THEN
    ALTER TABLE market_agent_delivery_jobs DROP CONSTRAINT market_agent_delivery_jobs_status_check;
  END IF;
  ALTER TABLE market_agent_delivery_jobs ADD CONSTRAINT market_agent_delivery_jobs_status_check
    CHECK (status IN ('awaiting_approval','scheduled','running','submitted','complete','failed','dead_letter','cancelled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS market_agent_email_suppressions (
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'unsubscribed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, project_id, email)
);
