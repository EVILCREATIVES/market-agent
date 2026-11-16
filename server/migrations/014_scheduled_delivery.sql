DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'market_agent_delivery_jobs'::regclass
      AND conname = 'market_agent_delivery_jobs_status_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%scheduled%'
  ) THEN
    ALTER TABLE market_agent_delivery_jobs DROP CONSTRAINT market_agent_delivery_jobs_status_check;
    ALTER TABLE market_agent_delivery_jobs ADD CONSTRAINT market_agent_delivery_jobs_status_check
      CHECK (status IN ('awaiting_approval','scheduled','running','submitted','complete','failed','cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS market_agent_delivery_jobs_scheduled_idx
  ON market_agent_delivery_jobs (status);
