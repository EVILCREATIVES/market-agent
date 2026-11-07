import { requireUser } from "../server/auth.mjs";
import { cancelManagedSubscription, createManagedSubscription, getManagedSubscriptionStatus } from "../server/billing.mjs";
import { requestOrigin } from "../server/connections.mjs";

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    if (req.method === "GET") return res.status(200).json(await getManagedSubscriptionStatus(userId));
    const action = String(req.body?.action || "create");
    if (action === "create") return res.status(200).json(await createManagedSubscription(userId, requestOrigin(req)));
    if (action === "cancel") return res.status(200).json(await cancelManagedSubscription(userId));
    return res.status(400).json({ error: "Unknown billing action." });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Billing request failed." });
  }
}
