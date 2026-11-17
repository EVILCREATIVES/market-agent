import { getPublicOptinCampaign } from "../server/newsletters.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const action = req.query?.join === "1" ? "join" : req.query?.preview === "1" ? "preview" : "view";
    const result = await getPublicOptinCampaign(req.query?.token, action);
    if (result.redirectUrl) {
      res.setHeader("Cache-Control", "no-store");
      return res.redirect(302, result.redirectUrl);
    }
    res.setHeader("Cache-Control", action === "preview" ? "private, no-store" : "public, max-age=60");
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "This signup page is unavailable." });
  }
}
