import { requireUser } from "../server/auth.mjs";
import { brandBuilderRequest } from "../server/brand-builder.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  try {
    const account = await requireUser(req);
    const projectId = String((req.method === "GET" ? req.query?.projectId : req.body?.projectId) || "").trim();
    return res.status(200).json(await brandBuilderRequest(account, projectId, req.method === "POST" ? req.body : {}));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Build Your Brand could not finish that action. Your current work is saved." });
  }
}
