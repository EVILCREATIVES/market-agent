import { requireUser } from "../server/auth.mjs";
import { loadStateForUser, saveStateForUser } from "../server/db.mjs";

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    if (req.method === "GET") {
      return res.status(200).json(await loadStateForUser(userId));
    }
    const state = await saveStateForUser(userId, req.body?.state);
    return res.status(200).json({ ok: true, state });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Cloud workspace request failed." });
  }
}
