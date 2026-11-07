import { finishMailchimpAuthorization } from "../server/newsletters.mjs";
import { requestOrigin } from "../server/connections.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const origin = requestOrigin(req);
  try {
    if (req.query?.error) {
      const detail = req.query?.error_description ? ` ${req.query.error_description}` : "";
      throw Object.assign(new Error(`Mailchimp authorization was cancelled.${detail}`), { statusCode: 400 });
    }
    const result = await finishMailchimpAuthorization({ code: req.query?.code, state: req.query?.state });
    const connection = result.needsAudience ? "mailchimp-select" : "mailchimp-success";
    return res.redirect(302, `${origin}/connection-result?connection=${connection}`);
  } catch (error) {
    const message = encodeURIComponent(error.message || "Mailchimp connection failed.");
    return res.redirect(302, `${origin}/connection-result?connection=mailchimp-error&reason=${message}`);
  }
}
