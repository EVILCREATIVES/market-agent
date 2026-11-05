import { requireUser } from "../server/auth.mjs";
import { approveMediaJob, cancelMediaJob, listMediaJobs, prepareMediaJob } from "../server/media.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const userApiEnv = await loadUserApiEnv(userId);
    if (req.method === "GET") {
      return res.status(200).json(await listMediaJobs(userId, req.query?.projectId, userApiEnv));
    }
    const action = req.body?.action;
    if (action === "prepare") return res.status(200).json(await prepareMediaJob(userId, req.body, userApiEnv));
    if (action === "approve") return res.status(200).json(await approveMediaJob(userId, req.body, userApiEnv));
    if (action === "cancel") return res.status(200).json(await cancelMediaJob(userId, req.body));
    return res.status(400).json({ error: "Unknown media action." });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Media request failed." });
  }
}
