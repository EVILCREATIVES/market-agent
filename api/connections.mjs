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
import {
  createAnalyticsAuthorizationUrl,
  disconnectAnalytics,
  selectAnalyticsProperty,
} from "../server/analytics.mjs";

export default async function handler(req, res) {
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId, email } = await requireUser(req);
    const projectId = String(req.query?.projectId || req.body?.projectId || "project-default").trim().slice(0, 200);
    if (!projectId) return res.status(400).json({ error: "Choose a project before connecting an account." });
    if (req.method === "GET") return res.status(200).json(await getConnectionStatus(userId, projectId));
    if (req.method === "DELETE") {
      const provider = String(req.query?.provider || req.body?.provider || "google-gmail");
      if (provider === "google-gmail") await disconnectGoogleMailbox(userId, projectId);
      else if (provider === "google-analytics") await disconnectAnalytics(userId, projectId);
      else await disconnectSocialConnection(userId, projectId, provider);
      return res.status(200).json({ ok: true, ...(await getConnectionStatus(userId, projectId)) });
    }
    const provider = String(req.body?.provider || "google-gmail");
    if (provider === "google-analytics" && req.body?.propertyId) {
      await selectAnalyticsProperty(userId, projectId, req.body.propertyId);
      return res.status(200).json({ ok: true, ...(await getConnectionStatus(userId, projectId)) });
    }
    const origin = requestOrigin(req);
    const authorizationUrl = provider === "google-analytics"
      ? await createAnalyticsAuthorizationUrl({ userId, projectId, origin })
      : SOCIAL_PROVIDERS.includes(provider)
        ? await createSocialAuthorizationUrl({ provider, userId, projectId, origin })
        : await createGoogleAuthorizationUrl({ userId, projectId, appEmail: email, origin });
    return res.status(200).json({ authorizationUrl });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Account connection failed." });
  }
}
