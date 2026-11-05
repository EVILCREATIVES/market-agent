import { refineProductBrain } from "../server/agent.mjs";
import { requireUser } from "../server/auth.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    return res.status(200).json(await refineProductBrain(req.body, await loadUserApiEnv(userId)));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "The product brain could not be updated." });
  }
}
