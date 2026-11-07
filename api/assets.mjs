import { requireUser } from "../server/auth.mjs";
import {
  approveAssetProposal,
  cancelAssetProposal,
  listProjectAssets,
  registerLinkedAsset,
  registerUploadedAsset,
} from "../server/assets.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";
import { consumeAiUsage } from "../server/billing.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    if (req.method === "GET") return res.status(200).json(await listProjectAssets(userId, req.query?.projectId));
    const action = String(req.body?.action || "");
    const userApiEnv = await loadUserApiEnv(userId);
    if (action !== "cancel-proposal") await consumeAiUsage(userId, "workspace", userApiEnv);
    if (action === "register-upload") return res.status(200).json(await registerUploadedAsset(userId, req.body, userApiEnv));
    if (action === "add-link") return res.status(200).json(await registerLinkedAsset(userId, req.body, userApiEnv));
    if (action === "approve-proposal") return res.status(200).json(await approveAssetProposal(userId, req.body, userApiEnv));
    if (action === "cancel-proposal") return res.status(200).json(await cancelAssetProposal(userId, req.body, userApiEnv));
    return res.status(400).json({ error: "Unknown asset action." });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Project asset request failed." });
  }
}
