import { requireUser } from "../server/auth.mjs";
import {
  createGoogleAuthorizationUrl,
  disconnectGoogleMailbox,
  getConnectionStatus,
  requestOrigin,
} from "../server/connections.mjs";
import {
  createSocialAuthorizationUrl,
  disconnectSocialConnection,
  SOCIAL_PROVIDERS,
} from "../server/social-connections.mjs";

export default async function handler(req, res) {
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId, email } = await requireUser(req);
    if (req.method === "GET") return res.status(200).json(await getConnectionStatus(userId));
    if (req.method === "DELETE") {
      const provider = String(req.query?.provider || req.body?.provider || "google-gmail");
      if (provider === "google-gmail") await disconnectGoogleMailbox(userId);
      else await disconnectSocialConnection(userId, provider);
      return res.status(200).json({ ok: true, ...(await getConnectionStatus(userId)) });
    }
    const provider = String(req.body?.provider || "google-gmail");
    const origin = requestOrigin(req);
    const authorizationUrl = SOCIAL_PROVIDERS.includes(provider)
      ? await createSocialAuthorizationUrl({ provider, userId, origin })
      : await createGoogleAuthorizationUrl({ userId, appEmail: email, origin });
    return res.status(200).json({ authorizationUrl });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Account connection failed." });
  }
}
