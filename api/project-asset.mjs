import { requireUser } from "../server/auth.mjs";
import { serveProjectFile } from "../server/assets.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    return await serveProjectFile(userId, req, res);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "File could not be downloaded." });
  }
}
