import { runMarketingAgent } from "../server/agent.mjs";
import { createRunRecord } from "../server/agent.mjs";
import { requireUser } from "../server/auth.mjs";
import { appendRunForUser, enforceRunBudget } from "../server/db.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";
import { getConnectionStatus } from "../server/connections.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    await enforceRunBudget(userId, req.body?.mode || "single");
    const userApiEnv = await loadUserApiEnv(userId);
    const projectId = req.body?.projectId || "project-default";
    const connections = await getConnectionStatus(userId, projectId);
    const result = await runMarketingAgent({ ...req.body, connections }, userApiEnv);
    const run = createRunRecord(result, req.body?.action || "chat", req.body?.prompt || "", projectId);
    await appendRunForUser(userId, run);
    return res.status(200).json({ ...result, run });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Agent run failed." });
  }
}
