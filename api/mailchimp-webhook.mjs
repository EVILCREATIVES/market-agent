import { sendGmailMessage } from "../server/connections.mjs";
import { completeSubscriberWelcome, processMailchimpWebhook } from "../server/newsletters.mjs";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).send("Market Agent Mailchimp webhook");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const result = await processMailchimpWebhook(String(req.query?.t || ""), req.body || {});
    if (result.welcome) {
      try {
        await sendGmailMessage(result.userId, result.projectId, result.welcome);
        await completeSubscriberWelcome(result.userId, result.projectId, result.welcome.to);
      } catch (error) {
        await completeSubscriberWelcome(result.userId, result.projectId, result.welcome.to, error?.message || "Welcome email could not be sent.");
      }
    }
    return res.status(200).send("ok");
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Webhook processing failed." });
  }
}
