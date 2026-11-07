import { finishAnalyticsAuthorization } from "../server/analytics.mjs";
import { requestOrigin } from "../server/connections.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const origin = requestOrigin(req);
  try {
    if (req.query?.error) throw Object.assign(new Error("Google Analytics authorization was cancelled."), { statusCode: 400 });
    const result = await finishAnalyticsAuthorization({ code: req.query?.code, state: req.query?.state });
    const suffix = result.propertyId ? "analytics-success" : "analytics-select";
    return res.redirect(302, `${origin}/connection-result?connection=${suffix}`);
  } catch (error) {
    const message = encodeURIComponent(error.message || "Google Analytics connection failed.");
    return res.redirect(302, `${origin}/connection-result?connection=analytics-error&reason=${message}`);
  }
}
