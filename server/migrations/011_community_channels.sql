DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'market_agent_delivery_jobs'::regclass
      AND conname = 'market_agent_delivery_jobs_channel_check'
      AND pg_get_constraintdef(oid) NOT LIKE '%discord%'
  ) THEN
    ALTER TABLE market_agent_delivery_jobs DROP CONSTRAINT market_agent_delivery_jobs_channel_check;
    ALTER TABLE market_agent_delivery_jobs ADD CONSTRAINT market_agent_delivery_jobs_channel_check
      CHECK (channel IN ('gmail','linkedin','instagram','tiktok','x','discord','reddit'));
  END IF;
END $$;
