import { buildProductBrain } from "../server/agent.mjs";
import { requireUser } from "../server/auth.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";
import { consumeAiUsage } from "../server/billing.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const userApiEnv = await loadUserApiEnv(userId);
    await consumeAiUsage(userId, "workspace", userApiEnv);
    return res.status(200).json(await buildProductBrain(req.body, userApiEnv));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Project onboarding failed." });
  }
}
