import { requireUser } from "../server/auth.mjs";
import {
  deleteUserApiCredential,
  getUserApiCredentialStatus,
  saveUserApiCredential,
} from "../server/user-api-credentials.mjs";

export default async function handler(req, res) {
  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { userId } = await requireUser(req);
    if (req.method === "GET") return res.status(200).json(await getUserApiCredentialStatus(userId));
    if (req.method === "POST") {
      return res.status(200).json(await saveUserApiCredential(userId, req.body?.provider, req.body?.apiKey));
    }
    return res.status(200).json(await deleteUserApiCredential(userId, req.query?.provider || req.body?.provider));
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "API connection failed." });
  }
}
