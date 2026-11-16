import { requireUser } from "../server/auth.mjs";
import { getProjectAssetPreviewUrl, serveProjectFile } from "../server/assets.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    if (req.query?.mode === "preview-url") return res.status(200).json(await getProjectAssetPreviewUrl(userId, req.query?.id));
    return await serveProjectFile(userId, req, res);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "File could not be downloaded." });
  }
}
