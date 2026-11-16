ALTER TABLE IF EXISTS market_agent_delivery_jobs
  DROP CONSTRAINT IF EXISTS market_agent_delivery_jobs_channel_check;

ALTER TABLE IF EXISTS market_agent_delivery_jobs
  ADD CONSTRAINT market_agent_delivery_jobs_channel_check
  CHECK (channel IN ('gmail','linkedin','instagram','tiktok','youtube','x','discord','reddit'));
