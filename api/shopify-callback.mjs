import { finishShopifyAuthorization } from "../server/shopify.mjs";
import { requestOrigin } from "../server/connections.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const origin = requestOrigin(req);
  try {
    if (req.query?.error) throw Object.assign(new Error("Shopify authorization was cancelled."), { statusCode: 400 });
    await finishShopifyAuthorization(req.query);
    return res.redirect(302, `${origin}/connection-result?connection=shopify-success`);
  } catch (error) {
    const message = encodeURIComponent(error.message || "Shopify connection failed.");
    return res.redirect(302, `${origin}/connection-result?connection=shopify-error&reason=${message}`);
  }
}
