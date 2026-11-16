import { appendRunForUser, listScheduledStates, markScheduleRunForUser } from "./db.mjs";
import { createRunRecord, runMarketingAgent } from "./agent.mjs";
import { loadUserApiEnv } from "./user-api-credentials.mjs";
import { consumeAiUsage } from "./billing.mjs";
import { approveTrustedDeliveryJobs, prepareDeliveryJobs } from "./delivery.mjs";
import { getAgentPerformanceContext } from "./growth.mjs";
import { getConnectionStatus } from "./connections.mjs";

export async function runAutonomyCycles(env = process.env, limit = 5) {
  const today = new Date().toISOString().slice(0, 10);
  const scheduled = (await listScheduledStates(env))
    .filter((entry) => entry.schedule.lastRunAt?.slice(0, 10) !== today)
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 5)));
  const results = [];
  for (const entry of scheduled) {
    const { schedule, project } = entry;
    try {
      const userApiEnv = await loadUserApiEnv(entry.userId, env);
      await consumeAiUsage(entry.userId, "cron", userApiEnv, env);
      const [connections, performanceContext] = await Promise.all([
        getConnectionStatus(entry.userId, project.id, env),
        getAgentPerformanceContext(entry.userId, project.id, env).catch(() => ""),
      ]);
      const result = await runMarketingAgent({
        action: schedule.action || "research",
        prompt: schedule.prompt || "Create today's market pulse.",
        workspace: { ...project, performanceContext },
        connections,
        useWeb: schedule.useWeb !== false,
        mode: "panel",
      }, userApiEnv);
      const run = createRunRecord(result, schedule.action || "research", schedule.prompt || "Scheduled market pulse", project.id);
      if (["prepare", "publish"].includes(schedule.autonomyLevel)) run.status = "Approved";
      await appendRunForUser(entry.userId, run, env);
      let prepared = 0;
      let autoScheduled = 0;
      if (["prepare", "publish"].includes(schedule.autonomyLevel) && run.campaignPlan?.items?.length) {
        const delivery = await prepareDeliveryJobs(entry.userId, project.id, run.id, userApiEnv, env);
        prepared = delivery.jobs.length;
        if (schedule.autonomyLevel === "publish") {
          const approved = await approveTrustedDeliveryJobs(entry.userId, project.id, run.id, schedule.trustedChannels, userApiEnv, env);
          autoScheduled = approved.approved;
        }
      }
      await markScheduleRunForUser(entry.userId, project.id, new Date().toISOString(), env);
      results.push({ userId: entry.userId, projectId: project.id, ok: true, runId: run.id, prepared, autoScheduled });
    } catch (error) {
      results.push({ userId: entry.userId, projectId: project.id, ok: false, error: String(error?.message || "Scheduled cycle failed.").slice(0, 500) });
    }
  }
  return results;
}
