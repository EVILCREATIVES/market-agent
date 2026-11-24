import { QueueClient } from "@vercel/queue";
import { enqueueBackgroundWakes, nextDailyRoutineAt } from "../server/background-queue.mjs";
import { runScheduledDeliveryJob } from "../server/delivery.mjs";
import { runAutonomyCycleForProject } from "../server/autonomy.mjs";

export const config = { maxDuration: 300 };

const queue = new QueueClient();
const { handleNodeCallback } = queue;

export default handleNodeCallback(async (message) => {
  const type = String(message?.type || "");
  const scheduledAt = new Date(String(message?.scheduledAt || ""));
  if (!Number.isFinite(scheduledAt.getTime())) throw new Error("The scheduled background task has no valid time.");

  if (scheduledAt.getTime() > Date.now() + 1_000) {
    await enqueueBackgroundWakes([message]);
    return;
  }

  if (type === "delivery") {
    const jobId = String(message?.jobId || "").trim();
    if (!jobId) throw new Error("The scheduled delivery has no job identifier.");
    const result = await runScheduledDeliveryJob(jobId);
    const job = result?.job;
    if (job?.status === "scheduled" && job.nextAttemptAt) {
      await enqueueBackgroundWakes([{ type: "delivery", jobId: job.id, scheduledAt: job.nextAttemptAt }]);
    }
    return;
  }

  if (type === "autonomy") {
    const userId = String(message?.userId || "").trim();
    const projectId = String(message?.projectId || "").trim();
    if (!userId || !projectId) throw new Error("The scheduled assistant routine is missing its project.");
    const result = await runAutonomyCycleForProject(userId, projectId);
    if (result?.enabled !== false) {
      await enqueueBackgroundWakes([{ type: "autonomy", userId, projectId, scheduledAt: nextDailyRoutineAt(result?.schedule || { lastRunAt: result?.ranAt }) }]);
    }
    return;
  }

  throw new Error("Unsupported background task type.");
}, { visibilityTimeoutSeconds: 600 });
