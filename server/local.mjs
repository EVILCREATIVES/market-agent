import http from "node:http";
import { buildProductBrain, createRunRecord, refineProductBrain, runMarketingAgent } from "./agent.mjs";
import { requireUser } from "./auth.mjs";
import { appendRunForUser, enforceRunBudget, loadStateForUser, saveStateForUser } from "./db.mjs";
import { approveMediaJob, cancelMediaJob, listMediaJobs, prepareMediaJob } from "./media.mjs";

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
    const providers = {
      openAI: Boolean(process.env.OPENAI_API_KEY),
      gemini: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
      claude: Boolean(process.env.ANTHROPIC_API_KEY),
    };
    return json(res, 200, {
      ok: true,
      agentConfigured: providers.openAI && providers.gemini && providers.claude,
      providers,
      databaseConfigured: Boolean(process.env.DATABASE_URL),
      authConfigured: Boolean(process.env.NEON_AUTH_BASE_URL),
      analyticsConfigured: Boolean(process.env.GA_PROPERTY_ID),
      mediaConfigured: providers.gemini,
      model: "Balanced analysis",
      runtime: "Secure cloud runtime",
      persistence: "cloud-postgres",
    });
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
      const result = await runMarketingAgent(payload);
      const run = createRunRecord(result, payload.action || "chat", payload.prompt || "", payload.projectId || "project-default");
      await appendRunForUser(userId, run);
      return json(res, 200, { ...result, run });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Agent run failed." });
    }
  }

  if (req.method === "POST" && req.url === "/api/onboard") {
    try {
      await requireUser(req);
      return json(res, 200, await buildProductBrain(await readJson(req)));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Project onboarding failed." });
    }
  }

  if (req.method === "POST" && req.url === "/api/refine") {
    try {
      await requireUser(req);
      return json(res, 200, await refineProductBrain(await readJson(req)));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "The product brain could not be updated." });
    }
  }

  if (req.method === "GET" && req.url?.startsWith("/api/media")) {
    try {
      const { userId } = await requireUser(req);
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      return json(res, 200, await listMediaJobs(userId, url.searchParams.get("projectId")));
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Media request failed." });
    }
  }

  if (req.method === "POST" && req.url === "/api/media") {
    try {
      const { userId } = await requireUser(req);
      const payload = await readJson(req);
      if (payload.action === "prepare") return json(res, 200, await prepareMediaJob(userId, payload));
      if (payload.action === "approve") return json(res, 200, await approveMediaJob(userId, payload));
      if (payload.action === "cancel") return json(res, 200, await cancelMediaJob(userId, payload));
      return json(res, 400, { error: "Unknown media action." });
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.message || "Media request failed." });
    }
  }

  return json(res, 404, { error: "Not found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Market Agent API ready at http://127.0.0.1:${port}`);
});
