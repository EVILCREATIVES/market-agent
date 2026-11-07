import { finishSocialAuthorization } from "../server/social-connections.mjs";
import { requestOrigin } from "../server/connections.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const origin = requestOrigin(req);
  try {
    if (req.query?.error) {
      const detail = req.query?.error_description ? ` ${req.query.error_description}` : "";
      throw Object.assign(new Error(`Account authorization was cancelled.${detail}`), { statusCode: 400 });
    }
    const result = await finishSocialAuthorization({ code: req.query?.code, state: req.query?.state });
    return res.redirect(302, `${origin}/connection-result?connection=${encodeURIComponent(result.provider)}-success`);
  } catch (error) {
    const message = encodeURIComponent(error.message || "Account connection failed.");
    return res.redirect(302, `${origin}/connection-result?connection=social-error&reason=${message}`);
  }
}
