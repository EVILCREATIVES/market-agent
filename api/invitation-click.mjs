import { recordInvitationClick } from "../server/delivery.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  try {
    const result = await recordInvitationClick(String(req.query?.token || ""));
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Location", result.destination);
    return res.status(302).end();
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(error.statusCode || 400).send("This invitation link could not be opened.");
  }
}
