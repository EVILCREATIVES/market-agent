import { requireUser } from "../server/auth.mjs";
import { deleteRunForUser, loadStateForUser, saveStateForUser, updateRunStatusForUser } from "../server/db.mjs";

export default async function handler(req, res) {
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    if (req.method === "GET") {
      return res.status(200).json(await loadStateForUser(userId));
    }
    if (req.method === "DELETE") return res.status(200).json(await deleteRunForUser(userId, req.query?.runId || req.body?.runId));
    if (req.body?.action === "update-run-status") return res.status(200).json(await updateRunStatusForUser(userId, req.body?.runId, req.body?.status));
    const saved = await saveStateForUser(userId, req.body?.state, process.env, req.body?.baseRevision);
    return res.status(200).json({ ok: true, ...saved });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Cloud workspace request failed.", ...(error.current || {}) });
  }
}
