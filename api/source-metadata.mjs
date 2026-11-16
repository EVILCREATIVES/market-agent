import { readConnectedSourceMetadata } from "../server/agent.mjs";
import { requireUser } from "../server/auth.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    await requireUser(req);
    const links = Array.isArray(req.body?.links) ? req.body.links.map(String).slice(0, 15) : [];
    return res.status(200).json({ sources: await readConnectedSourceMetadata(links) });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Source details could not be read." });
  }
}
