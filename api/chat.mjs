import { requireUser } from "../server/auth.mjs";
import { runProjectConversation } from "../server/agent.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";
import { consumeAiUsage } from "../server/billing.mjs";
import { getConnectionStatus } from "../server/connections.mjs";
import { findProjectAssetForInstruction, listProjectAssets } from "../server/assets.mjs";
import { replaceDeliveryMediaFromAsset } from "../server/delivery.mjs";
import { updateLatestNewsletterLink, updateLatestNewsletterLogo } from "../server/newsletters.mjs";
import { updateCampaignLink } from "../server/campaign-edits.mjs";

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const userApiEnv = await loadUserApiEnv(userId);
    const projectId = String(req.body?.projectId || req.body?.workspace?.id || "project-default");
    const connections = await getConnectionStatus(userId, projectId);
    const library = await listProjectAssets(userId, projectId, userApiEnv).catch(() => ({ assets: [] }));
    const message = String(req.body?.message || "");
    const runId = String(req.body?.activeCampaignRunId || "").slice(0, 200);
    let assetAction = null;
    let newsletterAction = null;
    let newsletterLogoAction = null;
    let campaignAction = null;
    if (runId && isCampaignAssetReplacement(message)) {
      const asset = await findProjectAssetForInstruction(userId, projectId, message, userApiEnv);
      if (asset) assetAction = await replaceDeliveryMediaFromAsset(userId, projectId, runId, asset, userApiEnv);
    }
    const requestedNewsletterUrl = newsletterLinkUpdate(message);
    if (requestedNewsletterUrl) {
      campaignAction = await updateCampaignLink(userId, projectId, runId, requestedNewsletterUrl).catch(() => null);
      newsletterAction = await updateLatestNewsletterLink(userId, projectId, requestedNewsletterUrl).catch((error) => {
        if (error?.statusCode === 404) return null;
        throw error;
      });
    }
    if (newsletterLogoUpdate(message)) {
      newsletterLogoAction = await updateLatestNewsletterLogo(userId, projectId, message).catch((error) => {
        if (error?.statusCode === 404) return null;
        throw error;
      });
    }
    const libraryContext = (library.assets || []).filter((asset) => asset.status === "ready").slice(0, 80).map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, tags: asset.tags, summary: asset.summary, recommendation: asset.recommendation }));
    const completedActions = [
      assetAction ? `The saved Content Library asset “${assetAction.asset.name}” replaced the media in ${assetAction.replaced} unapproved campaign ${assetAction.replaced === 1 ? "item" : "items"}.` : "",
      newsletterAction ? `The primary link in newsletter draft “${newsletterAction.draft.content.subject}” was changed to ${newsletterAction.requestedUrl}. Campaign tracking was added automatically. The saved draft and its preview were regenerated. Nothing was sent or scheduled.` : "",
      newsletterLogoAction ? `Newsletter draft “${newsletterLogoAction.draft.content.subject}” now uses the saved Brand logo “${newsletterLogoAction.logo.name}” (${newsletterLogoAction.logo.usage}). The saved draft and preview were regenerated. Nothing was sent or scheduled.` : "",
      campaignAction?.replaced ? `${campaignAction.replaced} saved link ${campaignAction.replaced === 1 ? "reference was" : "references were"} changed in the active campaign to ${campaignAction.targetUrl}.` : "",
    ].filter(Boolean);
    const completedContext = completedActions.length ? `${message}\n\nCOMPLETED APP ACTION\n${completedActions.join("\n")} Tell the user the action is complete. Never say that you cannot save it or that the user must edit the campaign manually.` : message;
    if ((newsletterAction || newsletterLogoAction || campaignAction?.replaced) && !assetAction) {
      const changed = [campaignAction?.replaced ? "the active campaign" : "", newsletterAction ? "the newsletter link and preview" : "", newsletterLogoAction ? `the newsletter logo to “${newsletterLogoAction.logo.name}”` : ""].filter(Boolean).join(" and ");
      return res.status(200).json({
        reply: `Updated ${changed}.${campaignAction?.targetUrl || newsletterAction?.requestedUrl ? ` The primary link is ${campaignAction?.targetUrl || newsletterAction?.requestedUrl}.` : ""} Nothing was sent or scheduled.`,
        createdAt: new Date().toISOString(),
        newsletterAction,
        newsletterLogoAction,
        campaignAction,
        assetAction: null,
      });
    }
    await consumeAiUsage(userId, "chat", userApiEnv);
    const result = await runProjectConversation({ ...(req.body || {}), projectId, message: completedContext, workspace: { ...(req.body?.workspace || {}), contentLibraryAssets: libraryContext }, connections }, userApiEnv);
    return res.status(200).json({ ...result, assetAction, newsletterAction, newsletterLogoAction, campaignAction });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "The project assistant could not reply." });
  }
}

function isCampaignAssetReplacement(value) {
  const message = String(value || "").toLowerCase();
  return /\b(replace|swap|switch|change|use|instead of)\b/.test(message) && /\b(image|video|asset|media|creative|post|campaign|reel)\b/.test(message);
}

function newsletterLinkUpdate(value) {
  const message = String(value || "").trim();
  if (!/\b(update|change|replace|set|use|correct|fix)\b/i.test(message)) return "";
  if (!/\b(newsletter|email|campaign)\b/i.test(message) || !/\b(link|url|website|site)\b/i.test(message)) return "";
  const explicit = message.match(/https?:\/\/[^\s<>"']+/i)?.[0];
  const bare = message.match(/\b(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,62}\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/i)?.[0];
  return String(explicit || bare || "").replace(/[),.;!?]+$/, "");
}

function newsletterLogoUpdate(value) {
  const message = String(value || "").trim();
  return /\b(update|change|replace|set|use|swap|correct|fix)\b/i.test(message)
    && /\b(newsletter|email|campaign)\b/i.test(message)
    && /\b(logo|wordmark|brand mark)\b/i.test(message);
}
