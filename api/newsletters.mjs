import { requireUser } from "../server/auth.mjs";
import { consumeAiUsage, connectorAllowedForAccess } from "../server/billing.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";
import {
  createNewsletterDraft,
  createOptinCampaign,
  deliverNewsletter,
  getContactImportDetails,
  getNewsletterDashboard,
  getSubscriberDetails,
  importContactList,
  registerSubscriber,
  stageContactImport,
  updateNewsletterSettings,
  updateNewsletterDraft,
  updateOptinCampaign,
} from "../server/newsletters.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const projectId = String(req.query?.projectId || req.body?.projectId || "project-default").trim().slice(0, 200);
    const accessEnv = await loadUserApiEnv(userId);
    const action = String(req.body?.action || "");
    if (["register-subscriber", "import-contact-list", "send", "schedule"].includes(action) && !connectorAllowedForAccess(accessEnv, "mailchimp")) {
      return res.status(403).json({ error: "Newsletter delivery is available after connecting your APIs or activating the managed plan." });
    }
    if (req.method === "GET") return res.status(200).json(await getNewsletterDashboard(userId, projectId));
    if (action === "register-subscriber") return res.status(200).json(await registerSubscriber(userId, projectId, req.body));
    if (action === "contact-import-details") return res.status(200).json(await getContactImportDetails(userId, projectId, req.body));
    if (action === "subscriber-details") return res.status(200).json(await getSubscriberDetails(userId, projectId, req.body));
    if (action === "update-welcome-settings") return res.status(200).json(await updateNewsletterSettings(userId, projectId, req.body));
    if (action === "stage-contact-import") {
      const staged = await stageContactImport(userId, projectId, req.body);
      let draft = null;
      let draftError = "";
      if (req.body?.createDraft) {
        try {
          await consumeAiUsage(userId, "agent", accessEnv);
          ({ draft } = await createNewsletterDraft(userId, projectId, req.body?.direction, accessEnv));
        } catch (error) {
          draftError = String(error?.message || "The contact list was saved, but the newsletter draft could not be created.");
        }
      }
      return res.status(200).json({ ...staged, draft, draftError });
    }
    if (action === "import-contact-list") return res.status(200).json(await importContactList(userId, projectId, req.body));
    if (action === "create-optin-campaign") {
      if (!connectorAllowedForAccess(accessEnv, "mailchimp")) return res.status(403).json({ error: "Prospect conversion requires an active Mailchimp connection and your APIs or managed plan." });
      if (req.body?.approvalConfirmed !== true) return res.status(400).json({ error: "Approve publishing the public opt-in page first." });
      await consumeAiUsage(userId, "agent", accessEnv);
      return res.status(200).json(await createOptinCampaign(userId, projectId, req.body?.direction, accessEnv));
    }
    if (action === "update-optin-campaign") return res.status(200).json(await updateOptinCampaign(userId, projectId, String(req.body?.id || ""), req.body));
    if (action === "create-draft") {
      await consumeAiUsage(userId, "agent", accessEnv);
      return res.status(200).json(await createNewsletterDraft(userId, projectId, req.body?.direction, accessEnv));
    }
    if (action === "update-draft") return res.status(200).json(await updateNewsletterDraft(userId, projectId, String(req.body?.id || ""), req.body?.changes || {}));
    if (action === "send" || action === "schedule") {
      await consumeAiUsage(userId, "delivery", accessEnv);
      return res.status(200).json(await deliverNewsletter(userId, projectId, String(req.body?.id || ""), action, req.body?.scheduleTime));
    }
    return res.status(400).json({ error: "Choose a newsletter action." });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Newsletter action failed.", draft: error.newsletter || undefined });
  }
}
