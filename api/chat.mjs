import { requireUser } from "../server/auth.mjs";
import { planProjectInterfaceActions, rewriteProspectInvitation, runProjectConversation } from "../server/agent.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";
import { consumeAiUsage } from "../server/billing.mjs";
import { getConnectionStatus } from "../server/connections.mjs";
import { findProjectAssetForInstruction, listProjectAssets, updateProjectAsset } from "../server/assets.mjs";
import { replaceDeliveryMediaFromAsset } from "../server/delivery.mjs";
import { createNewsletterDraft, getNewsletterActionContext, updateLatestNewsletterLink, updateLatestNewsletterLogo, updateNewsletterDraft, updateOptinCampaign } from "../server/newsletters.mjs";
import { getCampaignActionContext, updateCampaignLink, updateCampaignText } from "../server/campaign-edits.mjs";
import { archiveProjectConversationDays, getProjectConversationMemory } from "../server/conversation-memory.mjs";
import { waitUntil } from "@vercel/functions";

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
    const timeZone = String(req.body?.timeZone || "UTC");
    const conversationMemory = await getProjectConversationMemory(userId, projectId, message, timeZone).catch(() => "");
    const rememberedWorkspace = { ...(req.body?.workspace || {}), conversationMemory };
    waitUntil(archiveProjectConversationDays(userId, projectId, timeZone).catch(() => undefined));
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
    if (mayRequestInterfaceAction(message) || isInvitationEditRequest(message)) {
      const uiContext = req.body?.uiContext && typeof req.body.uiContext === "object" ? req.body.uiContext : {};
      const campaignRunIdForContext = uiContext.page === "campaigns" && uiContext.campaignSection !== "newsletter" ? runId : "";
      const [newsletterContext, campaignContext] = await Promise.all([
        getNewsletterActionContext(userId, projectId, { newsletterId: uiContext.selectedNewsletterId }).catch(() => ({ newsletter: null, invitation: null })),
        getCampaignActionContext(userId, projectId, campaignRunIdForContext).catch(() => null),
      ]);
      const actionWorkspace = { ...rememberedWorkspace, contentLibraryAssets: libraryContext };
      let plan;
      if (newsletterContext.invitation && isInvitationEditRequest(message)) {
        const revision = await rewriteProspectInvitation({ workspace: actionWorkspace, invitation: newsletterContext.invitation, message }, userApiEnv);
        plan = {
          summary: "Update the saved prospect invitation.",
          actions: [{ type: "update_invitation", targetId: newsletterContext.invitation.id, subject: revision.invitationSubject, body: revision.invitationBody, ctaLabel: revision.invitationCtaLabel, url: revision.invitationUrl, strategy: revision.invitationStrategy }],
        };
      } else {
        plan = await planProjectInterfaceActions({
          projectId,
          message,
          workspace: actionWorkspace,
          uiContext,
          editable: { uiContext, newsletter: newsletterContext.newsletter, invitation: newsletterContext.invitation, campaign: campaignContext },
        }, userApiEnv);
      }
      const execution = await executeInterfaceActions({ userId, projectId, runId: campaignRunIdForContext, workspace: req.body?.workspace || {}, plan, newsletterContext, libraryContext, userApiEnv });
      if (execution.attempted) {
        return res.status(200).json({
          reply: execution.reply,
          createdAt: new Date().toISOString(),
          assetAction,
          newsletterAction: execution.newsletterAction,
          newsletterLogoAction,
          invitationAction: execution.invitationAction,
          campaignAction: execution.campaignAction,
          libraryAction: execution.libraryAction,
          workspaceUpdate: execution.workspaceUpdate,
          interfaceActions: execution.results,
        });
      }
    }
    const result = await runProjectConversation({ ...(req.body || {}), projectId, message: completedContext, workspace: { ...rememberedWorkspace, contentLibraryAssets: libraryContext }, connections }, userApiEnv);
    return res.status(200).json({ ...result, assetAction, newsletterAction, newsletterLogoAction, campaignAction });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "The project assistant could not reply." });
  }
}

async function executeInterfaceActions({ userId, projectId, runId, workspace, plan, newsletterContext, libraryContext, userApiEnv }) {
  const actions = Array.isArray(plan?.actions) ? plan.actions.filter((action) => action?.type && action.type !== "none") : [];
  if (!actions.length) return { attempted: false, results: [] };
  const results = [];
  const workspaceUpdate = {};
  let newsletterAction = null;
  let invitationAction = null;
  let campaignAction = null;
  let libraryAction = null;
  for (const action of actions.slice(0, 6)) {
    try {
      if (action.type === "update_workspace") {
        const applied = applyWorkspaceField(workspaceUpdate, workspace, action.field, action.value);
        if (!applied) throw new Error("The requested project field was not safe to change automatically.");
        results.push({ type: action.type, status: "completed", detail: `Updated ${friendlyField(action.field)}.` });
        continue;
      }
      if (action.type === "update_invitation") {
        const targetId = String(action.targetId || newsletterContext?.invitation?.id || "");
        if (!targetId) throw new Error("There is no editable prospect invitation in this project.");
        const changes = compactChanges({
          invitationSubject: action.subject,
          invitationBody: action.body,
          invitationCtaLabel: action.ctaLabel,
          invitationUrl: action.url,
          invitationStrategy: action.strategy,
        });
        if (!Object.keys(changes).length) throw new Error("The instruction did not contain a concrete invitation change.");
        invitationAction = await updateOptinCampaign(userId, projectId, targetId, { ...changes, approvalConfirmed: true });
        results.push({ type: action.type, status: "completed", detail: `Updated the saved prospect invitation “${invitationAction.campaign.invitationSubject}”.` });
        continue;
      }
      if (action.type === "update_newsletter") {
        const targetId = String(action.targetId || newsletterContext?.newsletter?.id || "");
        if (!targetId) throw new Error("There is no editable newsletter draft in this project.");
        const changes = compactChanges({
          subject: action.subject,
          previewText: action.previewText,
          headline: action.headline,
          introduction: action.body,
          closing: action.closing,
          ctaLabel: action.ctaLabel,
          ctaUrl: action.url,
          heroImageUrl: action.heroImageUrl,
          heroImageAlt: action.heroImageAlt,
          logoVariantId: action.logoVariantId,
          senderName: action.senderName,
          businessDetails: action.businessDetails,
          physicalAddress: action.physicalAddress,
          addressPreference: action.addressPreference,
        });
        if (!Object.keys(changes).length) throw new Error("The instruction did not contain a concrete newsletter change.");
        newsletterAction = await updateNewsletterDraft(userId, projectId, targetId, changes);
        results.push({ type: action.type, status: "completed", detail: `Updated newsletter “${newsletterAction.draft.content.subject}” and regenerated its preview.` });
        continue;
      }
      if (action.type === "update_asset") {
        const target = (Array.isArray(libraryContext) ? libraryContext : []).find((item) => item.id === action.targetId)
          || (Array.isArray(libraryContext) ? libraryContext : []).find((item) => String(item.name || "").toLowerCase() === String(action.name || "").toLowerCase());
        if (!target?.id) throw new Error("The requested Content Library asset was not found.");
        libraryAction = await updateProjectAsset(userId, {
          id: target.id,
          name: String(action.name || target.name || "").trim(),
          summary: String(action.body || target.summary || "").trim(),
        }, userApiEnv);
        results.push({ type: action.type, status: "completed", detail: `Updated the Content Library asset “${libraryAction.asset.name}”.` });
        continue;
      }
      if (action.type === "create_newsletter") {
        newsletterAction = await createNewsletterDraft(userId, projectId, action.direction || action.reason || "Create the requested newsletter.", userApiEnv);
        results.push({ type: action.type, status: "completed", detail: `Created newsletter “${newsletterAction.draft.content.subject}” in Campaigns.` });
        continue;
      }
      if (action.type === "update_campaign_text") {
        const targetId = String(action.targetId || runId || "");
        if (!targetId) throw new Error("There is no active campaign draft to edit.");
        campaignAction = await updateCampaignText(userId, projectId, targetId, action.findText, action.replacementText);
        if (!campaignAction?.replaced) throw new Error("The exact campaign text to replace was not found, so no change was saved.");
        results.push({ type: action.type, status: "completed", detail: `Changed ${campaignAction.replaced} saved campaign text ${campaignAction.replaced === 1 ? "block" : "blocks"}.` });
      }
    } catch (error) {
      results.push({ type: action.type, status: "failed", detail: String(error?.message || "The change could not be saved.") });
    }
  }
  const completed = results.filter((result) => result.status === "completed");
  const failed = results.filter((result) => result.status === "failed");
  const reply = completed.length
    ? `Done. ${completed.map((result) => result.detail).join(" ")}${failed.length ? ` ${failed.map((result) => result.detail).join(" ")}` : ""} Nothing was sent, scheduled, or published.`
    : `I did not claim the change was made because it could not be saved. ${failed.map((result) => result.detail).join(" ")}`;
  return {
    attempted: true,
    reply,
    results,
    workspaceUpdate: Object.keys(workspaceUpdate).length ? workspaceUpdate : null,
    newsletterAction,
    invitationAction,
    campaignAction,
    libraryAction,
  };
}

function compactChanges(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => String(item || "").trim()));
}

function applyWorkspaceField(patch, workspace, field, rawValue) {
  const value = String(rawValue || "").trim();
  if (!field || !value) return false;
  const [group, key] = String(field).split(".");
  if (!key) {
    const allowed = ["name", "website", "description", "segmentation", "positioning", "manifesto", "audience", "valueProposition", "voice", "guardrails", "notes", "reviewSummary", "sourcePriority", "sourceGuidance"];
    if (!allowed.includes(group)) return false;
    if (group === "sourcePriority" && !["best-evidence", "website", "deck"].includes(value)) return false;
    patch[group] = value;
    return true;
  }
  const allowed = {
    brand: ["primaryColor", "secondaryColor", "accentColor", "neutralLightColor", "neutralDarkColor", "typography", "lookAndFeel", "photographyStyle", "imageryStyle", "notes"],
    emailIdentity: ["senderName", "businessDetails", "physicalAddress", "addressPreference"],
    growth: ["objective", "primaryConversion", "analyticsEvent", "rationale", "targetValue", "targetPeriodDays"],
    issueNotes: ["high", "attention", "context"],
  };
  if (!allowed[group]?.includes(key)) return false;
  if (group === "emailIdentity" && key === "addressPreference" && !["ask", "include", "omit"].includes(value)) return false;
  if (group === "growth" && key === "objective" && !["visibility", "leads", "sales", "audience", "newsletter"].includes(value)) return false;
  if (group === "growth" && key === "primaryConversion" && !["contact_form", "demo_request", "newsletter_signup", "purchase", "reply", "custom"].includes(value)) return false;
  const nextValue = group === "growth" && ["targetValue", "targetPeriodDays"].includes(key) ? Number(value) : value;
  if (typeof nextValue === "number" && (!Number.isFinite(nextValue) || nextValue < 0)) return false;
  patch[group] = { ...(workspace?.[group] || {}), ...(patch[group] || {}), [key]: nextValue };
  return true;
}

function friendlyField(field) {
  return String(field || "project information").replace(/^brand\./, "Brand ").replace(/^emailIdentity\./, "email ").replace(/^growth\./, "growth ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function mayRequestInterfaceAction(value) {
  const message = String(value || "").toLowerCase();
  const subject = /\b(email|e-mail|newsletter|invitation|message|messaggio|campaign|campagna|copy|caption|subject|body|link|url|logo|brand|profile|positioning|manifesto|audience|sender|address|asset|video|image|name|description|segmentation|voice|guardrails?|notes?|issues?|colors?|palette|typography|photography|goal|conversion|analytics|website|demo|headline|preview|signature|cta|button)\b/i.test(message);
  const instruction = /\b(update|change|replace|rewrite|revise|fix|correct|edit|add|remove|use|save|create|make|set|move|swap|improve|redo|apply|start)\b/i.test(message);
  const rejection = /\b(wrong|awful|bad|terrible|shit|bullshit|useless|stupid|confusing|nothing happens|does not work|doesn't work|did not|didn't|don['’]t like|do not like|cazzo|merda|schifo)\b/i.test(message);
  return subject && (instruction || rejection);
}

function isInvitationEditRequest(value) {
  const message = String(value || "").toLowerCase();
  const invitation = /\b(invitation|invite|invito|prospect email|recipient preview)\b/i.test(message)
    || (/\b(demo|project|subscribe|subscription)\b/i.test(message) && /\b(email|message|copy|subject)\b/i.test(message));
  const correction = /\b(update|change|replace|rewrite|revise|fix|correct|edit|improve|redo|should|want|prefer|ask|don['’]t like|do not like|not subscribe|instead)\b/i.test(message);
  return invitation && correction;
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
