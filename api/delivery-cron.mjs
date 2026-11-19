import { runScheduledDeliveryJobs } from "../server/delivery.mjs";
import { runGmailMonitoringCycle } from "../server/gmail-monitor.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.status(401).json({ error: "Unauthorized" });
  const monitored = await runGmailMonitoringCycle(process.env, 10);
  const results = await runScheduledDeliveryJobs(process.env, 25);
  return res.status(200).json({ ok: true, monitored: monitored.length, monitoring: monitored, processed: results.length, results });
}
