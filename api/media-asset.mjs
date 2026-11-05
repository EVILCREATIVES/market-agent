import { serveMediaAsset } from "../server/media.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    return await serveMediaAsset(req, res);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Media could not be opened." });
  }
}
