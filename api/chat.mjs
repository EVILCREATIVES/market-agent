import { requireUser } from "../server/auth.mjs";
import { planProjectInterfaceActions, researchPublicLinkedInProfiles, rewriteProspectInvitation, runProjectConversation } from "../server/agent.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";
import { consumeAiUsage } from "../server/billing.mjs";
import { getConnectionStatus } from "../server/connections.mjs";
import { findProjectAssetForInstruction, listProjectAssets, updateProjectAsset } from "../server/assets.mjs";
import { replaceDeliveryMediaFromAsset } from "../server/delivery.mjs";
import { createNewsletterDraft, getNewsletterActionContext, updateLatestNewsletterLink, updateLatestNewsletterLogo, updateNewsletterDraft, updateOptinCampaign } from "../server/newsletters.mjs";
import { addCampaignTableColumn, editableCampaignRunId, getCampaignActionContext, getCampaignPeopleTable, setCampaignTableColumnValues, updateCampaignExperiment, updateCampaignLink, updateCampaignPlanItem, updateCampaignText } from "../server/campaign-edits.mjs";
import { applySectorCorrection } from "../server/intelligence.mjs";
import { loadApprovedBrandForProject } from "../server/db.mjs";
import { archiveProjectConversationDays, getProjectConversationMemory } from "../server/conversation-memory.mjs";
import { waitUntil } from "@vercel/functions";

export const config = { maxDuration: 120 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    const userApiEnv = await loadUserApiEnv(userId);
    const projectId = String(req.body?.projectId || req.body?.workspace?.id || "project-default");
    const message = String(req.body?.message || "");
    const timeZone = String(req.body?.timeZone || "UTC");
    const [connections, library, conversationMemory, creativeBrand] = await Promise.all([
      getConnectionStatus(userId, projectId),
      listProjectAssets(userId, projectId, userApiEnv).catch(() => ({ assets: [] })),
      getProjectConversationMemory(userId, projectId, message, timeZone).catch(() => ""),
      loadApprovedBrandForProject(userId, projectId),
    ]);
    const rememberedWorkspace = { ...(req.body?.workspace || {}), creativeBrand, conversationMemory };
    waitUntil(archiveProjectConversationDays(userId, projectId, timeZone).catch(() => undefined));
    const runId = String(req.body?.activeRunId || req.body?.activeCampaignRunId || "").slice(0, 200);
    const campaignRunId = String(req.body?.activeCampaignRunId || "").slice(0, 200);
    let assetAction = null;
    let newsletterAction = null;
    let newsletterLogoAction = null;
    let campaignAction = null;
    let aiUsageConsumed = false;
    const uiContext = req.body?.uiContext && typeof req.body.uiContext === "object" ? req.body.uiContext : {};
    const editableRunId = editableCampaignRunId(runId, uiContext);
    const requestedTableColumn = campaignTableColumnRequest(message);
    const requestedLinkedInEnrichment = linkedInEnrichmentRequest(message) || Boolean(requestedTableColumn?.enrich);
    if (editableRunId && requestedLinkedInEnrichment) {
      await consumeAiUsage(userId, "chat", userApiEnv);
      aiUsageConsumed = true;
      campaignAction = await enrichCampaignLinkedInTable(userId, projectId, editableRunId, userApiEnv);
    } else if (editableRunId && requestedTableColumn) {
      campaignAction = await addCampaignTableColumn(userId, projectId, editableRunId, requestedTableColumn.columnName, requestedTableColumn.defaultValue, requestedTableColumn.tableHint);
    }
    if (campaignRunId && isCampaignAssetReplacement(message)) {
      const asset = await findProjectAssetForInstruction(userId, projectId, message, userApiEnv);
      if (asset) assetAction = await replaceDeliveryMediaFromAsset(userId, projectId, campaignRunId, asset, userApiEnv);
    }
    const requestedNewsletterUrl = newsletterLinkUpdate(message);
    if (requestedNewsletterUrl) {
      campaignAction = await updateCampaignLink(userId, projectId, campaignRunId, requestedNewsletterUrl).catch(() => null);
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
      campaignAction?.enrichment ? `Public profile research verified ${campaignAction.profilesVerified} LinkedIn ${campaignAction.profilesVerified === 1 ? "profile" : "profiles"}; ${campaignAction.peopleNotFound} could not be verified and ${campaignAction.peopleAmbiguous} need review. The links were saved in the visible People table.` : "",
      requestedTableColumn && campaignAction?.tableFound ? campaignAction.alreadyPresent ? `The active campaign already has a “${campaignAction.columnName}” column.` : `A “${campaignAction.columnName}” column was added to ${campaignAction.rowsUpdated} rows in the active campaign.` : "",
    ].filter(Boolean);
    const completedContext = completedActions.length ? `${message}\n\nCOMPLETED APP ACTION\n${completedActions.join("\n")} Tell the user the action is complete. Never say that you cannot save it or that the user must edit the campaign manually.` : message;
    if ((newsletterAction || newsletterLogoAction || campaignAction?.replaced || campaignAction?.enrichment || (requestedTableColumn && campaignAction?.tableFound)) && !assetAction) {
      const changed = [campaignAction?.replaced ? "the active campaign" : "", campaignAction?.enrichment ? `the People table with ${campaignAction.profilesVerified} verified LinkedIn ${campaignAction.profilesVerified === 1 ? "profile" : "profiles"}` : "", requestedTableColumn && campaignAction?.tableFound && !campaignAction?.enrichment ? campaignAction.alreadyPresent ? `the existing “${campaignAction.columnName}” campaign column` : `the campaign table with a “${campaignAction.columnName}” column` : "", newsletterAction ? "the newsletter link and preview" : "", newsletterLogoAction ? `the newsletter logo to “${newsletterLogoAction.logo.name}”` : ""].filter(Boolean).join(" and ");
      return res.status(200).json({
        reply: `Updated ${changed}.${campaignAction?.enrichment ? ` ${campaignAction.peopleNotFound} ${campaignAction.peopleNotFound === 1 ? "person was" : "people were"} marked Not found; ${campaignAction.peopleAmbiguous} need review.` : ""}${campaignAction?.targetUrl || newsletterAction?.requestedUrl ? ` The primary link is ${campaignAction?.targetUrl || newsletterAction?.requestedUrl}.` : ""} Nothing was sent or scheduled.`,
        createdAt: new Date().toISOString(),
        newsletterAction,
        newsletterLogoAction,
        campaignAction,
        assetAction: null,
      });
    }
    if (!aiUsageConsumed) await consumeAiUsage(userId, "chat", userApiEnv);
    const contextualDraftEdit = isContextualDraftEditRequest(message);
    if (mayRequestInterfaceAction(message) || isInvitationEditRequest(message) || contextualDraftEdit) {
      const campaignRunIdForContext = editableRunId;
      const [newsletterContext, campaignContext] = await Promise.all([
        getNewsletterActionContext(userId, projectId, { newsletterId: uiContext.selectedNewsletterId }).catch(() => ({ newsletter: null, invitation: null })),
        getCampaignActionContext(userId, projectId, campaignRunIdForContext).catch(() => null),
      ]);
      const actionWorkspace = { ...rememberedWorkspace, contentLibraryAssets: libraryContext };
      let plan;
      const recentConversationText = Array.isArray(req.body?.history) ? req.body.history.slice(-8).map((item) => String(item?.content || "")).join("\n") : "";
      if (shouldRewriteSavedInvitation({
        hasInvitation: Boolean(newsletterContext.invitation),
        message,
        contextualDraftEdit,
        editableRunId,
        uiContext,
        recentConversationText,
      })) {
        const revision = await rewriteProspectInvitation({ workspace: actionWorkspace, invitation: newsletterContext.invitation, message }, userApiEnv);
        plan = {
          summary: "Update the saved prospect invitation.",
          actions: [{ type: "update_invitation", targetId: newsletterContext.invitation.id, subject: revision.invitationSubject, body: revision.invitationBody, ctaLabel: revision.invitationCtaLabel, url: revision.invitationUrl, strategy: revision.invitationStrategy, experiment: revision.experiment }],
        };
      } else {
        plan = await planProjectInterfaceActions({
          userId,
          projectId,
          accessMode: userApiEnv.MARKET_AGENT_ACCESS_MODE,
          message,
          workspace: actionWorkspace,
          uiContext,
          editable: {
            uiContext,
            recentConversation: Array.isArray(req.body?.history) ? req.body.history.slice(-12).map((item) => ({ role: item?.role, content: String(item?.content || "").slice(0, 4_000) })) : [],
            newsletter: newsletterContext.newsletter,
            invitation: newsletterContext.invitation,
            campaign: campaignContext,
          },
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
      if (action.type === "correct_sector_evidence") {
        const category = String(action.category || "");
        const statement = String(action.body || action.value || "").trim();
        if (!category || !statement) throw new Error("The sector correction needs a category and a complete corrected fact.");
        workspaceUpdate.sectorExpertise = applySectorCorrection(workspaceUpdate.sectorExpertise || workspace.sectorExpertise, {
          id: String(action.targetId || ""),
          category,
          statement,
          sourceTitle: "User correction",
        });
        results.push({ type: action.type, status: "completed", detail: "Saved the correction as verified Sector Expertise; future research cannot overwrite it." });
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
          experiment: action.experiment,
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
          sections: action.sections,
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
        continue;
      }
      if (action.type === "update_campaign_item") {
        const targetId = String(action.targetId || runId || "");
        if (!targetId) throw new Error("There is no active campaign draft to edit.");
        const changes = {};
        if (String(action.subject || "").trim()) changes.subject = action.subject;
        if (String(action.body || "").trim()) changes.text = action.body;
        if (String(action.scheduledAt || "").trim()) changes.scheduledAt = action.scheduledAt;
        if (!Object.keys(changes).length) throw new Error("The instruction did not contain a concrete post change.");
        campaignAction = await updateCampaignPlanItem(userId, projectId, targetId, action.itemIndex, changes);
        results.push({ type: action.type, status: "completed", detail: `Updated campaign item ${Number(action.itemIndex) + 1}; its visual preview and publishing payload now match.` });
        continue;
      }
      if (action.type === "update_experiment") {
        const targetId = String(action.targetId || runId || "");
        if (!targetId) throw new Error("There is no active campaign experiment to edit.");
        campaignAction = await updateCampaignExperiment(userId, projectId, targetId, action.field, action.value);
        results.push({ type: action.type, status: "completed", detail: `Updated the experiment ${friendlyField(action.field)} and reopened it for review.` });
        continue;
      }
      if (action.type === "add_campaign_table_column") {
        const targetId = String(action.targetId || runId || "");
        if (!targetId) throw new Error("There is no active campaign table to edit.");
        const columnName = String(action.name || "").trim();
        if (!columnName) throw new Error("Choose a name for the campaign table column.");
        campaignAction = await addCampaignTableColumn(userId, projectId, targetId, columnName, action.value || "Unknown", action.reason || "");
        if (!campaignAction.tableFound) throw new Error("No editable table was found in the active campaign.");
        results.push({ type: action.type, status: "completed", detail: campaignAction.alreadyPresent ? `The campaign already has a “${columnName}” column.` : `Added “${columnName}” to ${campaignAction.rowsUpdated} campaign rows.` });
        continue;
      }
      if (action.type === "enrich_linkedin_profiles") {
        const targetId = String(action.targetId || runId || "");
        if (!targetId) throw new Error("There is no active People table to enrich.");
        campaignAction = await enrichCampaignLinkedInTable(userId, projectId, targetId, userApiEnv);
        results.push({ type: action.type, status: "completed", detail: `Researched the People table and saved ${campaignAction.profilesVerified} verified LinkedIn ${campaignAction.profilesVerified === 1 ? "profile" : "profiles"}; ${campaignAction.peopleNotFound} were not found and ${campaignAction.peopleAmbiguous} need review.` });
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
  return Object.fromEntries(Object.entries(value).filter(([, item]) => {
    if (Array.isArray(item)) return item.length > 0;
    if (item && typeof item === "object") return Object.keys(item).length > 0;
    return String(item || "").trim();
  }));
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
  const subject = /\b(email|e-mail|newsletter|invitation|message|messaggio|campaign|campagna|experiment|hypothesis|cohort|evidence|sector|industry|buyers?|objections?|competitors?|procurement|copy|caption|subject|body|link|url|logo|brand|profile|positioning|manifesto|audience|sender|address|asset|video|image|name|description|segmentation|voice|guardrails?|notes?|issues?|colors?|palette|typography|photography|goal|conversion|analytics|website|demo|headline|preview|signature|cta|button|table|column|row|people|prospects?|leads?|contacts?|linkedin)\b/i.test(message);
  const instruction = /\b(update|change|replace|rewrite|revise|fix|correct|edit|add|remove|use|save|create|make|set|move|swap|improve|redo|apply|start)\b/i.test(message);
  const rejection = /\b(wrong|awful|bad|terrible|shit|bullshit|useless|stupid|confusing|nothing happens|does not work|doesn't work|did not|didn't|don['’]t like|do not like|cazzo|merda|schifo)\b/i.test(message);
  return subject && (instruction || rejection);
}

export function isContextualDraftEditRequest(value) {
  const message = String(value || "").trim();
  if (!message) return false;
  const correction = /^(?:no\b|not\b|instead\b)|\b(?:i\s+(?:want|prefer|think)|should|must|use|make|put|keep|change|replace|rewrite|update|fix|correct|add|remove|rename|attach|upload|enable|disable|first\s+step|second\s+step|third\s+step)\b/i.test(message);
  const orderedDirection = /(?:^|\s)(?:step\s*)?[1-9][.)]?\s+/i.test(message);
  const questionOnly = /^(?:what|why|how|when|where|who|does|do|did|can|could|is|are|will|would)\b/i.test(message) && /\?\s*$/.test(message);
  return (correction || orderedDirection) && !questionOnly;
}

export function campaignTableColumnRequest(value) {
  const message = String(value || "").toLowerCase();
  const addColumn = /\b(add|create|insert|include|make)\b/i.test(message) && /\bcolumn\b/i.test(message);
  const people = /\b(people|person|prospects?|leads?|contacts?)\b/i.test(message);
  if (addColumn && people && /\blinkedin\b/i.test(message)) {
    return { columnName: "LinkedIn connection", defaultValue: "Not found", tableHint: "people", enrich: true };
  }
  return null;
}

export function linkedInEnrichmentRequest(value) {
  const message = String(value || "").toLowerCase();
  const discovery = /\b(search|find|look\s*up|research|verify|enrich|populate|fill|empty|add)\b/i.test(message);
  const people = /\b(people|person|prospects?|leads?|contacts?|profiles?|list|links?)\b/i.test(message);
  const online = /\b(linkedin|online|profile|links?)\b/i.test(message);
  return discovery && people && online;
}

async function enrichCampaignLinkedInTable(userId, projectId, runId, env) {
  const table = await getCampaignPeopleTable(userId, projectId, runId, "people", env);
  const research = await researchPublicLinkedInProfiles({ rows: table.rows }, env);
  const saved = await setCampaignTableColumnValues(userId, projectId, runId, "LinkedIn connection", research.rowValues, "people", research.sources, env);
  return {
    ...saved,
    enrichment: true,
    profilesVerified: research.profilesVerified,
    peopleNotFound: research.peopleNotFound,
    peopleAmbiguous: research.peopleAmbiguous,
  };
}

function isInvitationEditRequest(value) {
  const message = String(value || "").toLowerCase();
  const invitation = /\b(invitation|invite|invito|prospect email|recipient preview)\b/i.test(message)
    || (/\b(demo|project|subscribe|subscription)\b/i.test(message) && /\b(email|message|copy|subject)\b/i.test(message));
  const correction = /\b(update|change|replace|rewrite|revise|fix|correct|edit|improve|redo|should|want|prefer|ask|don['’]t like|do not like|not subscribe|instead)\b/i.test(message);
  return invitation && correction;
}

export function shouldRewriteSavedInvitation({ hasInvitation, message, contextualDraftEdit, editableRunId, uiContext = {}, recentConversationText = "" }) {
  if (!hasInvitation) return false;
  const page = String(uiContext?.page || "");
  const editingInvitation = page === "campaigns"
    && uiContext?.campaignSection === "newsletter"
    && uiContext?.campaignEmailMode === "invitation";
  const explicitInvitation = isInvitationEditRequest(message);
  const recentInvitationContext = /\b(invitation|invite new people|recipient preview|prospect email)\b/i.test(String(recentConversationText || ""));

  // The record currently open in Agent is the primary editing target. Remembered
  // Campaigns state must never redirect a short correction away from that proposal.
  if (page === "agent" && editableRunId) {
    return explicitInvitation && /\b(saved|campaigns?|newsletter)\b/i.test(String(message || ""));
  }
  if (editingInvitation) return explicitInvitation || (contextualDraftEdit && recentInvitationContext);
  return explicitInvitation;
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
