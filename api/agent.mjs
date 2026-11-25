import { createRunRecord, generateSectorExpertise, runMarketingAgent } from "../server/agent.mjs";
import { requireUser } from "../server/auth.mjs";
import { appendRunForUser, enforceRunBudget, loadProjectForSectorResearch, saveProjectSectorExpertise } from "../server/db.mjs";
import { loadUserApiEnv } from "../server/user-api-credentials.mjs";
import { getConnectionStatus } from "../server/connections.mjs";
import { consumeAiUsage } from "../server/billing.mjs";
import { getAgentPerformanceContext, listProjectExperimentLearnings } from "../server/growth.mjs";
import { listReadyCampaignAssets } from "../server/assets.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { userId } = await requireUser(req);
    if (req.body?.action === "sector") return res.status(200).json(await buildSectorExpertiseForUser(userId, req.body?.projectId));
    const userApiEnv = await loadUserApiEnv(userId);
    const mode = req.body?.mode || "single";
    await enforceRunBudget(userId, mode);
    await consumeAiUsage(userId, mode === "panel" ? "panel" : "agent", userApiEnv);
    const projectId = req.body?.projectId || "project-default";
    const savedProject = req.body?.sectorPositionId ? await loadProjectForSectorResearch(userId, projectId) : null;
    const connections = await getConnectionStatus(userId, projectId);
    const performanceContext = await getAgentPerformanceContext(userId, projectId).catch(() => "");
    const libraryMedia = await listReadyCampaignAssets(userId, projectId).catch(() => []);
    const suppliedMedia = Array.isArray(req.body?.workspace?.sourceMedia) ? req.body.workspace.sourceMedia : [];
    const suppliedLibrary = Array.isArray(req.body?.workspace?.contentLibraryAssets) ? req.body.workspace.contentLibraryAssets : [];
    const availableMedia = [...libraryMedia, ...suppliedMedia.filter((item) => !libraryMedia.some((asset) => asset.id === item?.id))];
    const workspace = {
      ...(savedProject || req.body?.workspace || {}),
      performanceContext,
      sourceMedia: availableMedia,
      contentLibraryAssets: [...availableMedia, ...suppliedLibrary.filter((item) => !availableMedia.some((asset) => asset.id === item?.id))],
    };
    const result = await runMarketingAgent({ ...req.body, workspace, connections }, userApiEnv);
    const run = createRunRecord(result, req.body?.action || "chat", req.body?.prompt || "", projectId);
    await appendRunForUser(userId, run);
    return res.status(200).json({ ...result, run });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "Agent run failed." });
  }
}

export async function buildSectorExpertiseForUser(userId, projectId, env = process.env) {
  if (typeof projectId !== "string" || !projectId.trim() || projectId.length > 200) {
    throw Object.assign(new Error("Choose a project before building sector expertise."), { statusCode: 400 });
  }
  const [workspace, userApiEnv] = await Promise.all([
    loadProjectForSectorResearch(userId, projectId, env),
    loadUserApiEnv(userId, env),
  ]);
  const projectContext = [workspace.website, workspace.description, workspace.positioning, workspace.segmentation].some((value) => typeof value === "string" && value.trim());
  if (!projectContext && !workspace.sources?.length && !workspace.materials?.length) {
    throw Object.assign(new Error("Add a website, source, or description in Brand so the research can identify this project’s sector."), { statusCode: 422 });
  }
  await enforceRunBudget(userId, "single", env);
  await consumeAiUsage(userId, "agent", userApiEnv, env);
  const learnings = await listProjectExperimentLearnings(userId, projectId, env).catch(() => []);
  const performanceContext = JSON.stringify(learnings.slice(0, 5).map(({ title, conclusion }) => ({ title, conclusion })));
  const expertise = await generateSectorExpertise({ workspace: { ...workspace, performanceContext }, useWeb: true }, userApiEnv);
  return saveProjectSectorExpertise(userId, projectId, expertise, env);
}
