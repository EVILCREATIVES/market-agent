import { finishGoogleAuthorization, requestOrigin } from "../server/connections.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const origin = requestOrigin(req);
  try {
    if (req.query?.error) throw Object.assign(new Error("Google mailbox authorization was cancelled."), { statusCode: 400 });
    await finishGoogleAuthorization({ code: req.query?.code, state: req.query?.state });
    return res.redirect(302, `${origin}/?connection=gmail-success`);
  } catch (error) {
    const message = encodeURIComponent(error.message || "Mailbox connection failed.");
    return res.redirect(302, `${origin}/?connection=gmail-error&reason=${message}`);
  }
}
