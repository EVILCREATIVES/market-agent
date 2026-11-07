import { appendRunForUser, listScheduledStates, loadStateForUser, saveStateForUser } from "../server/db.mjs";
import { createRunRecord, runMarketingAgent } from "../server/agent.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";
import { consumeAiUsage } from "../server/billing.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const today = new Date().toISOString().slice(0, 10);
  const scheduled = await listScheduledStates();
  const results = [];

  for (const entry of scheduled) {
    const { schedule, project } = entry;
    if (schedule.lastRunAt?.slice(0, 10) === today) continue;
    try {
      const userApiEnv = await loadUserApiEnv(entry.userId);
      await consumeAiUsage(entry.userId, "cron", userApiEnv);
      const result = await runMarketingAgent({
        action: schedule.action || "research",
        prompt: schedule.prompt || "Create today's market pulse.",
        workspace: project,
        useWeb: schedule.useWeb !== false,
        mode: "panel",
      }, userApiEnv);
      const run = createRunRecord(result, schedule.action || "research", schedule.prompt || "Scheduled market pulse", project.id);
      await appendRunForUser(entry.userId, run);
      entry.state.schedules[project.id] = { ...schedule, lastRunAt: new Date().toISOString() };
      const refreshed = await loadStateForUser(entry.userId);
      refreshed.state.schedules[project.id] = entry.state.schedules[project.id];
      await saveStateForUser(entry.userId, refreshed.state);
      results.push({ userId: entry.userId, projectId: project.id, ok: true, runId: run.id });
    } catch (error) {
      results.push({ userId: entry.userId, ok: false, error: error.message || "Scheduled run failed." });
    }
  }

  return res.status(200).json({ ok: true, processed: results.length, results });
}
