import { recordEmailOptOut } from "../server/delivery.mjs";

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).send("Method not allowed");
  try {
    await recordEmailOptOut(String(req.query?.token || req.body?.token || ""));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send("<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width\"><title>Unsubscribed</title></head><body style=\"font:16px system-ui;padding:48px;max-width:640px;margin:auto\"><h1>You’re unsubscribed.</h1><p>This address will not receive future direct campaign emails from this project.</p></body></html>");
  } catch (error) {
    return res.status(error.statusCode || 400).send("This opt-out link could not be processed.");
  }
}
