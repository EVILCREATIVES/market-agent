import { requireUser } from "../server/auth.mjs";
import { getAnalyticsReport } from "../server/analytics.mjs";
import { connectorAllowedForAccess } from "../server/billing.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const accessEnv = await loadUserApiEnv(userId);
    if (!connectorAllowedForAccess(accessEnv, "google-analytics")) {
      return res.status(403).json({ error: "Google Analytics is available with your own APIs or the managed plan." });
    }
    const projectId = String(req.query?.projectId || "project-default").trim().slice(0, 200);
    const range = String(req.query?.range || "28daysAgo");
    return res.status(200).json(await getAnalyticsReport(userId, projectId, range));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Google Analytics report failed." });
  }
}
