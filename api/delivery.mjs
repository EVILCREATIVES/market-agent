import { requireUser } from "../server/auth.mjs";
import { cancelDeliveryJob, executeDeliveryJob, listDeliveryJobs, prepareDeliveryJobs } from "../server/delivery.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const projectId = String(req.query?.projectId || req.body?.projectId || "project-default").trim().slice(0, 200);
    const runId = String(req.query?.runId || req.body?.runId || "").trim().slice(0, 200);
    if (req.method === "GET") return res.status(200).json(await listDeliveryJobs(userId, projectId, runId));
    const action = String(req.body?.action || "prepare");
    if (action === "execute") return res.status(200).json(await executeDeliveryJob(userId, String(req.body?.id || "").slice(0, 100)));
    if (action === "cancel") return res.status(200).json(await cancelDeliveryJob(userId, String(req.body?.id || "").slice(0, 100)));
    if (!runId) return res.status(400).json({ error: "Choose approved work first." });
    return res.status(200).json(await prepareDeliveryJobs(userId, projectId, runId, await loadUserApiEnv(userId)));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Delivery action failed." });
  }
}
