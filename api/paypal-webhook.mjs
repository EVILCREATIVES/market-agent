import { processPayPalWebhook } from "../server/billing.mjs";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const result = await processPayPalWebhook(req.headers || {}, req.body || {});
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "PayPal webhook failed." });
  }
}
