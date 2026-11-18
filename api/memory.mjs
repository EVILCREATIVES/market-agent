import { requireUser } from "../server/auth.mjs";
import { pinProjectConversationNote } from "../server/conversation-memory.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const projectId = String(req.body?.projectId || "").trim().slice(0, 200);
    if (!projectId) return res.status(400).json({ error: "Choose a project first." });
    if (req.body?.action !== "pin") return res.status(400).json({ error: "Unsupported memory action." });
    return res.status(200).json(await pinProjectConversationNote(userId, projectId, req.body?.note, req.body?.timeZone));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "The project note could not be saved." });
  }
}
