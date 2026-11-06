import { requireUser } from "../server/auth.mjs";
import { getAnalyticsReport } from "../server/analytics.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const projectId = String(req.query?.projectId || "project-default").trim().slice(0, 200);
    const range = String(req.query?.range || "28daysAgo");
    return res.status(200).json(await getAnalyticsReport(userId, projectId, range));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Google Analytics report failed." });
  }
}
