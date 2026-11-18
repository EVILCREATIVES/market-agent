import { archiveCompletedConversationDays } from "../server/conversation-memory.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const results = await archiveCompletedConversationDays(process.env, 100);
  return res.status(200).json({ ok: true, processed: results.length, results });
}
