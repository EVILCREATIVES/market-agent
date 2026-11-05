import { requireUser } from "../server/auth.mjs";
import { getUserApiCredentialStatus, saveUserApiCredential } from "../server/user-api-credentials.mjs";

const OWNER_EMAIL = "unleash@evilcreatives.com";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId, email } = await requireUser(req);
    if (email !== OWNER_EMAIL) return res.status(403).json({ error: "This migration is available only to the deployment owner." });
    const keys = [
      ["openai", process.env.OPENAI_API_KEY],
      ["google", process.env.GOOGLE_GENERATIVE_AI_API_KEY],
      ["anthropic", process.env.ANTHROPIC_API_KEY],
    ];
    const missing = keys.filter(([, key]) => !key).map(([provider]) => provider);
    if (missing.length) return res.status(409).json({ error: "One or more previously stored API keys are unavailable in production." });
    for (const [provider, apiKey] of keys) await saveUserApiCredential(userId, provider, apiKey);
    return res.status(200).json(await getUserApiCredentialStatus(userId));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Stored API connections could not be restored." });
  }
}
