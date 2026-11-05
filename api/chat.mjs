import { requireUser } from "../server/auth.mjs";
import { runProjectConversation } from "../server/agent.mjs";

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    await requireUser(req);
    const result = await runProjectConversation(req.body || {});
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "The project assistant could not reply." });
  }
}
