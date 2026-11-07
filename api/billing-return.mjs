import { finishManagedSubscription } from "../server/billing.mjs";
import { requestOrigin } from "../server/connections.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const origin = requestOrigin(req);
  try {
    await finishManagedSubscription(req.query?.token, req.query?.subscription_id || req.query?.ba_token);
    return res.redirect(302, `${origin}/connection-result?connection=billing-success`);
  } catch (error) {
    const reason = encodeURIComponent(error.message || "The subscription could not be verified.");
    return res.redirect(302, `${origin}/connection-result?connection=billing-error&reason=${reason}`);
  }
}
