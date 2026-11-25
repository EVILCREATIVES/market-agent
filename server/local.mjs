import http from "node:http";
import { Readable } from "node:stream";
import { handleUpload } from "@vercel/blob/client";
import { buildProductBrain, createRunRecord, readConnectedSourceMetadata, refineProductBrain, runMarketingAgent, runProjectConversation } from "./agent.mjs";
import { approveAssetProposal, cancelAssetProposal, deleteProjectAsset, getProjectAssetPreviewUrl, listProjectAssets, listReadyCampaignAssets, registerLinkedAsset, registerUploadedAsset, serveProjectFile } from "./assets.mjs";
import { requireUser } from "./auth.mjs";
import { appendRunForUser, enforceRunBudget, loadStateForUser, saveStateForUser, updateRunStatusForUser } from "./db.mjs";
import { approveMediaJob, cancelMediaJob, listMediaJobs, prepareMediaJob } from "./media.mjs";
import { cancelManagedSubscription, consumeAiUsage, createManagedSubscription, getManagedSubscriptionStatus } from "./billing.mjs";
import { getModelUsageMeasurement } from "./model-usage.mjs";
import {
  deleteUserApiCredential,
  getUserApiCredentialStatus,
  loadUserApiEnv,
  saveUserApiCredential,
} from "./user-api-credentials.mjs";
import { createNewsletterDraft, deliverNewsletter, getContactImportDetails, getNewsletterDashboard, getSubscriberDetails, importContactList, registerSubscriber, stageContactImport, updateLatestNewsletterLogo, updateNewsletterDraft, updateNewsletterSettings } from "./newsletters.mjs";
import { getAgentPerformanceContext } from "./growth.mjs";
import { getConnectionStatus } from "./connections.mjs";
import { createBrandLogoAccessUrl, getBrandLogo } from "./brand-logos.mjs";
import { archiveProjectConversationDays, getProjectConversationMemory, pinProjectConversationNote } from "./conversation-memory.mjs";
import { buildSectorExpertiseForUser } from "../api/agent.mjs";

const port = Number(process.env.PORT || 8787);

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request is too large.");
  }
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || "/", `http://localhost:${port}`);
  if (requestUrl.pathname === "/api/brand-logo" && req.method === "GET") {
    try {
      const result = await getBrandLogo(requestUrl.searchParams.get("token"), req.headers["if-none-match"] || "");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (result.blob?.etag) res.setHeader("ETag", result.blob.etag);
      if (result.statusCode === 304) return res.writeHead(304).end();
      res.setHeader("Content-Type", result.blob.contentType);
      return Readable.fromWeb(result.stream).pipe(res);
    } catch (error) { return json(res, error.statusCode || 500, { error: error.message || "The logo could not be read." }); }
  }
  if (requestUrl.pathname === "/api/brand-logo" && req.method === "POST") {
    try {
      const { userId } = await requireUser(req);
      const payload = await readJson(req);
      const projectId = String(payload?.projectId || "").trim().slice(0, 200);
      if (!projectId || !payload?.pathname) return json(res, 400, { error: "Project and logo upload are required." });
      const origin = process.env.APP_BASE_URL || `http://localhost:${port}`;
      return json(res, 200, { url: createBrandLogoAccessUrl({ userId, projectId, pathname: payload.pathname, origin }) });
    } catch (error) { return json(res, error.statusCode || 500, { error: error.message || "The logo link could not be created." }); }
  }
  if (req.method === "GET" && req.url === "/api/health") {
    return json(res, 200, {
      ok: true,
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      authConfigured: Boolean(process.env.NEON_AUTH_BASE_URL),
      analyticsConfigured: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.CONNECTION_ENCRYPTION_KEY),
      runtime: "Secure cloud runtime",
      persistence: "cloud-postgres",
    });
  }

  if (["GET", "POST", "DELETE"].includes(req.method) && req.url?.startsWith("/api/api-credentials")) {
    try {
      const { userId } = await requireUser(req);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === "GET") return json(res, 200, await getUserApiCredentialStatus(userId));
      const payload = await readJson(req);
      if (req.method === "POST") return json(res, 200, await saveUserApiCredential(userId, payload.provider, payload.apiKey));
      return json(res, 200, await deleteUserApiCredential(userId, url.searchParams.get("provider") || payload.provider));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "API connection failed." });
    }
  }

  if (["GET", "POST"].includes(req.method) && req.url === "/api/billing") {
    try {
      const { userId } = await requireUser(req);
      if (req.method === "GET") {
        const [status, utilityMeasurement] = await Promise.all([
          getManagedSubscriptionStatus(userId),
          getModelUsageMeasurement(userId),
        ]);
        return json(res, 200, { ...status, utilityMeasurement });
      }
      const payload = await readJson(req);
      if (payload.action === "cancel") return json(res, 200, await cancelManagedSubscription(userId));
      return json(res, 200, await createManagedSubscription(userId, `http://127.0.0.1:${port}`));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Billing request failed." });
    }
  }

  if (req.method === "POST" && req.url === "/api/asset-upload") {
    try {
      const { userId } = await requireUser(req);
      const body = await readJson(req);
      const result = await handleUpload({
        request: req,
        body,
        onBeforeGenerateToken: async (pathname, clientPayload) => {
          const payload = JSON.parse(clientPayload || "{}");
          const projectId = String(payload.projectId || "").trim().slice(0, 200);
          if (!projectId || !pathname.startsWith(`market-agent-assets/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}/`)) throw new Error("The upload destination is invalid.");
          return { maximumSizeInBytes: 150 * 1024 * 1024, addRandomSuffix: true, allowOverwrite: false, tokenPayload: JSON.stringify({ userId, projectId }) };
        },
      });
      return json(res, 200, result);
    } catch (error) {
      return json(res, error.statusCode || 400, { error: error.message || "Asset upload could not start." });
    }
  }

  if (["GET", "POST"].includes(req.method) && req.url === "/api/state") {
    try {
      const { userId } = await requireUser(req);
      if (req.method === "GET") return json(res, 200, await loadStateForUser(userId));
      const payload = await readJson(req);
      if (payload.action === "update-run-status") return json(res, 200, await updateRunStatusForUser(userId, payload.runId, payload.status));
      const saved = await saveStateForUser(userId, payload.state, process.env, payload.baseRevision);
      return json(res, 200, { ok: true, ...saved });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Cloud workspace request failed.", ...(error.current || {}) });
    }
  }

  if (req.method === "POST" && req.url === "/api/agent") {
    try {
      const { userId } = await requireUser(req);
      const payload = await readJson(req);
      if (payload.action === "sector") return json(res, 200, await buildSectorExpertiseForUser(userId, payload.projectId));
      const mode = payload.mode || "single";
      const userApiEnv = await loadUserApiEnv(userId);
      await enforceRunBudget(userId, mode);
      await consumeAiUsage(userId, mode === "panel" ? "panel" : "agent", userApiEnv);
      const projectId = payload.projectId || "project-default";
      const [connections, performanceContext, libraryMedia] = await Promise.all([
        getConnectionStatus(userId, projectId),
        getAgentPerformanceContext(userId, projectId).catch(() => ""),
        listReadyCampaignAssets(userId, projectId).catch(() => []),
      ]);
      const suppliedMedia = Array.isArray(payload.workspace?.sourceMedia) ? payload.workspace.sourceMedia : [];
      const suppliedLibrary = Array.isArray(payload.workspace?.contentLibraryAssets) ? payload.workspace.contentLibraryAssets : [];
      const availableMedia = [...libraryMedia, ...suppliedMedia.filter((item) => !libraryMedia.some((asset) => asset.id === item?.id))];
      const workspace = {
        ...(payload.workspace || {}),
        performanceContext,
        sourceMedia: availableMedia,
        contentLibraryAssets: [...availableMedia, ...suppliedLibrary.filter((item) => !availableMedia.some((asset) => asset.id === item?.id))],
      };
      const result = await runMarketingAgent({ ...payload, workspace, connections }, userApiEnv);
      const run = createRunRecord(result, payload.action || "chat", payload.prompt || "", payload.projectId || "project-default");
      await appendRunForUser(userId, run);
      return json(res, 200, { ...result, run });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Agent run failed." });
    }
  }

  if (req.method === "POST" && req.url === "/api/chat") {
    try {
      const { userId } = await requireUser(req);
      const payload = await readJson(req);
      const message = String(payload?.message || "");
      if (/\b(update|change|replace|set|use|swap|correct|fix)\b/i.test(message) && /\b(newsletter|email|campaign)\b/i.test(message) && /\b(logo|wordmark|brand mark)\b/i.test(message)) {
        const newsletterLogoAction = await updateLatestNewsletterLogo(userId, String(payload?.projectId || payload?.workspace?.id || "project-default"), message);
        return json(res, 200, { reply: `Updated the newsletter logo to “${newsletterLogoAction.logo.name}”. Nothing was sent or scheduled.`, createdAt: new Date().toISOString(), newsletterLogoAction });
      }
      const userApiEnv = await loadUserApiEnv(userId);
      await consumeAiUsage(userId, "chat", userApiEnv);
      const projectId = String(payload?.projectId || payload?.workspace?.id || "project-default");
      const conversationMemory = await getProjectConversationMemory(userId, projectId, payload?.message, payload?.timeZone).catch(() => "");
      void archiveProjectConversationDays(userId, projectId, payload?.timeZone).catch(() => undefined);
      return json(res, 200, await runProjectConversation({ ...payload, workspace: { ...(payload?.workspace || {}), conversationMemory } }, userApiEnv));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "The project assistant could not reply." });
    }
  }

  if (req.method === "POST" && req.url === "/api/memory") {
    try {
      const { userId } = await requireUser(req);
      const payload = await readJson(req);
      if (payload?.action !== "pin") return json(res, 400, { error: "Unsupported memory action." });
      return json(res, 200, await pinProjectConversationNote(userId, String(payload?.projectId || ""), payload?.note, payload?.timeZone));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "The project note could not be saved." });
    }
  }

  if (req.method === "POST" && req.url === "/api/onboard") {
    try {
      const { userId } = await requireUser(req);
      const userApiEnv = await loadUserApiEnv(userId);
      await consumeAiUsage(userId, "workspace", userApiEnv);
      return json(res, 200, await buildProductBrain(await readJson(req), userApiEnv));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Project onboarding failed." });
    }
  }

  if (req.method === "POST" && req.url === "/api/source-metadata") {
    try {
      await requireUser(req);
      const payload = await readJson(req);
      const links = Array.isArray(payload.links) ? payload.links.map(String).slice(0, 15) : [];
      return json(res, 200, { sources: await readConnectedSourceMetadata(links) });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Source details could not be read." });
    }
  }

  if (["GET", "POST"].includes(req.method) && req.url?.startsWith("/api/newsletters")) {
    try {
      const { userId } = await requireUser(req);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      const payload = req.method === "POST" ? await readJson(req) : {};
      const projectId = String(url.searchParams.get("projectId") || payload.projectId || "project-default").trim().slice(0, 200);
      if (req.method === "GET") return json(res, 200, await getNewsletterDashboard(userId, projectId));
      const userApiEnv = await loadUserApiEnv(userId);
      if (payload.action === "stage-contact-import") {
        const staged = await stageContactImport(userId, projectId, payload);
        let draft = null;
        let draftError = "";
        if (payload.createDraft) {
          try { ({ draft } = await createNewsletterDraft(userId, projectId, payload.direction, userApiEnv)); }
          catch (error) { draftError = String(error?.message || "The newsletter draft could not be created."); }
        }
        return json(res, 200, { ...staged, draft, draftError });
      }
      if (payload.action === "import-contact-list") return json(res, 200, await importContactList(userId, projectId, payload));
      if (payload.action === "contact-import-details") return json(res, 200, await getContactImportDetails(userId, projectId, payload));
      if (payload.action === "subscriber-details") return json(res, 200, await getSubscriberDetails(userId, projectId, payload));
      if (payload.action === "update-welcome-settings") return json(res, 200, await updateNewsletterSettings(userId, projectId, payload));
      if (payload.action === "register-subscriber") return json(res, 200, await registerSubscriber(userId, projectId, payload));
      if (payload.action === "create-draft") return json(res, 200, await createNewsletterDraft(userId, projectId, payload.direction, userApiEnv));
      if (payload.action === "update-draft") return json(res, 200, await updateNewsletterDraft(userId, projectId, String(payload.id || ""), payload.changes || {}));
      if (["send", "schedule"].includes(payload.action)) return json(res, 200, await deliverNewsletter(userId, projectId, String(payload.id || ""), payload.action, payload.scheduleTime));
      return json(res, 400, { error: "Choose a newsletter action." });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Newsletter action failed.", draft: error.newsletter || undefined });
    }
  }

  if (req.method === "POST" && req.url === "/api/refine") {
    try {
      const { userId } = await requireUser(req);
      const userApiEnv = await loadUserApiEnv(userId);
      await consumeAiUsage(userId, "workspace", userApiEnv);
      return json(res, 200, await refineProductBrain(await readJson(req), userApiEnv));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "The Brand could not be updated." });
    }
  }

  if (req.method === "GET" && req.url?.startsWith("/api/media")) {
    try {
      const { userId } = await requireUser(req);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      return json(res, 200, await listMediaJobs(userId, url.searchParams.get("projectId"), await loadUserApiEnv(userId)));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Media request failed." });
    }
  }

  if (req.method === "POST" && req.url === "/api/media") {
    try {
      const { userId } = await requireUser(req);
      const payload = await readJson(req);
      const userApiEnv = await loadUserApiEnv(userId);
      if (payload.action !== "cancel-proposal") await consumeAiUsage(userId, "workspace", userApiEnv);
      if (payload.action === "prepare") return json(res, 200, await prepareMediaJob(userId, payload, userApiEnv));
      if (payload.action === "approve") return json(res, 200, await approveMediaJob(userId, payload, userApiEnv));
      if (payload.action === "cancel") return json(res, 200, await cancelMediaJob(userId, payload));
      return json(res, 400, { error: "Unknown media action." });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Media request failed." });
    }
  }

  if (req.url?.startsWith("/api/assets")) {
    try {
      const { userId } = await requireUser(req);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (req.method === "GET") return json(res, 200, await listProjectAssets(userId, url.searchParams.get("projectId")));
      if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });
      const payload = await readJson(req);
      const userApiEnv = await loadUserApiEnv(userId);
      if (payload.action === "register-upload") return json(res, 200, await registerUploadedAsset(userId, payload, userApiEnv));
      if (payload.action === "add-link") return json(res, 200, await registerLinkedAsset(userId, payload, userApiEnv));
      if (payload.action === "approve-proposal") return json(res, 200, await approveAssetProposal(userId, payload, userApiEnv));
      if (payload.action === "cancel-proposal") return json(res, 200, await cancelAssetProposal(userId, payload, userApiEnv));
      if (payload.action === "delete-asset") return json(res, 200, await deleteProjectAsset(userId, payload, userApiEnv));
      return json(res, 400, { error: "Unknown asset action." });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Project asset request failed." });
    }
  }

  if (req.method === "GET" && req.url?.startsWith("/api/project-asset")) {
    try {
      const { userId } = await requireUser(req);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      req.query = Object.fromEntries(url.searchParams.entries());
      if (req.query.mode === "preview-url") return json(res, 200, await getProjectAssetPreviewUrl(userId, req.query.id));
      return await serveProjectFile(userId, req, res);
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "File could not be downloaded." });
    }
  }

  return json(res, 404, { error: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Market Agent API ready at http://127.0.0.1:${port}`);
});
