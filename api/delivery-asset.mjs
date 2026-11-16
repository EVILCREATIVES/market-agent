import { servePublicProjectAsset } from "../server/assets.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).send("Method not allowed");
  try {
    return await servePublicProjectAsset(req, res);
  } catch (error) {
    return res.status(error.statusCode || 404).send(error.message || "Asset unavailable");
  }
}
