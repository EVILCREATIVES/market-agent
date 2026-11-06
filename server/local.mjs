import http from "node:http";
import { handleUpload } from "@vercel/blob/client";
import { buildProductBrain, createRunRecord, refineProductBrain, runMarketingAgent, runProjectConversation } from "./agent.mjs";
import { approveAssetProposal, cancelAssetProposal, listProjectAssets, registerLinkedAsset, registerUploadedAsset, serveProjectFile } from "./assets.mjs";
import { requireUser } from "./auth.mjs";
import { appendRunForUser, enforceRunBudget, loadStateForUser, saveStateForUser } from "./db.mjs";
import { approveMediaJob, cancelMediaJob, listMediaJobs, prepareMediaJob } from "./media.mjs";
import {
  deleteUserApiCredential,
  getUserApiCredentialStatus,
  loadUserApiEnv,
  saveUserApiCredential,
} from "./user-api-credentials.mjs";

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
      const state = await saveStateForUser(userId, (await readJson(req)).state);
      return json(res, 200, { ok: true, state });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Cloud workspace request failed." });
    }
  }

  if (req.method === "POST" && req.url === "/api/agent") {
    try {
      const { userId } = await requireUser(req);
      const payload = await readJson(req);
      await enforceRunBudget(userId, payload.mode || "single");
      const result = await runMarketingAgent(payload, await loadUserApiEnv(userId));
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
      return json(res, 200, await runProjectConversation(await readJson(req), await loadUserApiEnv(userId)));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "The project assistant could not reply." });
    }
  }

  if (req.method === "POST" && req.url === "/api/onboard") {
    try {
      const { userId } = await requireUser(req);
      return json(res, 200, await buildProductBrain(await readJson(req), await loadUserApiEnv(userId)));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Project onboarding failed." });
    }
  }

  if (req.method === "POST" && req.url === "/api/refine") {
    try {
      const { userId } = await requireUser(req);
      return json(res, 200, await refineProductBrain(await readJson(req), await loadUserApiEnv(userId)));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "The product brain could not be updated." });
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
