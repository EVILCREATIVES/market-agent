import type { AgentRun, AgentSchedule, AppState, ProductWorkspace } from "./types";

const STORAGE_KEY_PREFIX = "market-agent-state-v2";

export function createDefaultSchedule(): AgentSchedule {
  return {
    enabled: false,
    action: "research",
    prompt: "Create a concise daily market pulse with notable changes, audience signals, and recommended actions.",
    useWeb: true,
    autonomyLevel: "draft",
    trustedChannels: [],
    lastRunAt: null,
  };
}

export function createEmptyProject(name: string = "New project", id: string = crypto.randomUUID()): ProductWorkspace {
  return {
    id,
    name,
    website: "",
    description: "",
    segmentation: "",
    positioning: "",
    manifesto: "",
    audience: "",
    valueProposition: "",
    voice: "",
    guardrails: "",
    notes: "",
    issueNotes: { high: "", attention: "", context: "" },
    acceptedIssueNotes: [],
    sourcePriority: "best-evidence",
    sourceGuidance: "",
    sources: [],
    materials: [],
    sourceMedia: [],
    brand: createDefaultBrand(),
    reviewSummary: "",
    openQuestions: [],
    questionAnswers: {},
    additionalContextDraft: "",
    sourceWarnings: [],
    protectedFields: [],
    chatMessages: [],
    emailIdentity: { senderName: "", businessDetails: "", physicalAddress: "", addressPreference: "ask" },
    growth: createDefaultGrowthPlan(),
    updatedAt: new Date().toISOString(),
  };
}

const defaultProject = createEmptyProject("New project", "project-default");

export const initialState: AppState = {
  projects: [defaultProject],
  activeProjectId: defaultProject.id,
  runs: [],
  schedules: { [defaultProject.id]: createDefaultSchedule() },
};

export function loadState(userId: string): AppState {
  try {
    const value = window.localStorage.getItem(storageKey(userId));
    if (!value) return cloneInitialState();
    return normalizeState(JSON.parse(value));
  } catch {
    return cloneInitialState();
  }
}

export function saveState(state: AppState, userId: string) {
  window.localStorage.setItem(storageKey(userId), JSON.stringify(state));
}

export function mergeCloudState(local: AppState, remote: AppState): AppState {
  const projects = new Map(remote.projects.map((project) => [project.id, project]));
  for (const project of local.projects) {
    const current = projects.get(project.id);
    if (!current) projects.set(project.id, project);
    else {
      const localIsNewer = new Date(project.updatedAt || 0).getTime() >= new Date(current.updatedAt || 0).getTime();
      projects.set(project.id, preserveSavedLogo(localIsNewer ? project : current, localIsNewer ? current : project));
    }
  }
  const schedules = { ...remote.schedules, ...local.schedules };
  for (const [projectId, schedule] of Object.entries(schedules)) {
    const remoteRun = remote.schedules[projectId]?.lastRunAt || "";
    const localRun = local.schedules[projectId]?.lastRunAt || "";
    schedules[projectId] = { ...schedule, lastRunAt: remoteRun > localRun ? remoteRun : localRun || null };
  }
  return normalizeState({
    projects: Array.from(projects.values()),
    activeProjectId: local.activeProjectId || remote.activeProjectId,
    // Campaigns are created, updated, and deleted on the server. Treat the
    // cloud list as authoritative so a stale browser tab cannot resurrect a
    // campaign that another tab already deleted.
    runs: remote.runs.slice(),
    schedules,
  });
}

function preserveSavedLogo(preferred: ProductWorkspace, fallback: ProductWorkspace): ProductWorkspace {
  const preferredHasLogo = Boolean(preferred.brand?.logoDataUrl) || Boolean(preferred.brand?.logoVariants?.length);
  const fallbackHasLogo = Boolean(fallback.brand?.logoDataUrl) || Boolean(fallback.brand?.logoVariants?.length);
  if (preferredHasLogo || !fallbackHasLogo) return preferred;
  return {
    ...preferred,
    brand: {
      ...preferred.brand,
      logoDataUrl: fallback.brand.logoDataUrl || fallback.brand.logoVariants?.[0]?.url || "",
      logoName: fallback.brand.logoName || fallback.brand.logoVariants?.[0]?.name || "Primary logo",
      logoVariants: fallback.brand.logoVariants || [],
    },
  };
}

function storageKey(userId: string) {
  return `${STORAGE_KEY_PREFIX}:${userId}`;
}

function normalizeState(value: unknown): AppState {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const legacyWorkspace = source.workspace && typeof source.workspace === "object"
    ? source.workspace as Partial<ProductWorkspace>
    : null;
  const rawProjects = Array.isArray(source.projects)
    ? source.projects as Array<Partial<ProductWorkspace>>
    : legacyWorkspace ? [legacyWorkspace] : [];
  const projects = rawProjects.length
    ? rawProjects.map((project, index) => normalizeProject(project, index))
    : [createEmptyProject("New project", "project-default")];
  const requestedActiveId = typeof source.activeProjectId === "string" ? source.activeProjectId : projects[0].id;
  const activeProjectId = projects.some((project) => project.id === requestedActiveId) ? requestedActiveId : projects[0].id;
  const rawSchedules = source.schedules && typeof source.schedules === "object"
    ? source.schedules as Record<string, Partial<AgentSchedule>>
    : {};
  const legacySchedule = source.schedule && typeof source.schedule === "object"
    ? source.schedule as Partial<AgentSchedule>
    : null;
  const schedules = Object.fromEntries(projects.map((project) => [
    project.id,
    { ...createDefaultSchedule(), ...(rawSchedules[project.id] || (project.id === activeProjectId ? legacySchedule : null) || {}) },
  ]));
  const runs = Array.isArray(source.runs)
    ? (source.runs as Array<Partial<AgentRun>>).map((run) => ({ ...run, projectId: run.projectId || activeProjectId })) as AgentRun[]
    : [];

  return { projects, activeProjectId, runs, schedules };
}

function normalizeProject(project: Partial<ProductWorkspace>, index: number): ProductWorkspace {
  const id = project.id || `project-${index + 1}`;
  return {
    ...createEmptyProject(index === 0 ? "New project" : `Project ${index + 1}`, id),
    ...project,
    id,
    segmentation: typeof project.segmentation === "string" ? project.segmentation : project.audience || "",
    positioning: typeof project.positioning === "string" ? project.positioning : project.valueProposition || "",
    manifesto: typeof project.manifesto === "string" ? project.manifesto : "",
    issueNotes: normalizeIssueNotes(project.issueNotes, project.notes),
    acceptedIssueNotes: Array.isArray(project.acceptedIssueNotes) ? project.acceptedIssueNotes.map(String).slice(0, 100) : [],
    sources: Array.isArray(project.sources) ? project.sources : [],
    materials: Array.isArray(project.materials) ? project.materials : [],
    sourceMedia: Array.isArray(project.sourceMedia) ? project.sourceMedia.slice(0, 40) : [],
    brand: normalizeBrandIdentity(project.brand),
    reviewSummary: typeof project.reviewSummary === "string" ? project.reviewSummary : "",
    openQuestions: Array.isArray(project.openQuestions) ? project.openQuestions : [],
    questionAnswers: project.questionAnswers && typeof project.questionAnswers === "object" ? project.questionAnswers : {},
    sourcePriority: project.sourcePriority === "website" || project.sourcePriority === "deck" ? project.sourcePriority : "best-evidence",
    sourceGuidance: typeof project.sourceGuidance === "string" ? project.sourceGuidance : "",
    additionalContextDraft: typeof project.additionalContextDraft === "string" ? project.additionalContextDraft : "",
    sourceWarnings: Array.isArray(project.sourceWarnings) ? project.sourceWarnings : [],
    protectedFields: Array.isArray(project.protectedFields) ? project.protectedFields.map(String).slice(0, 30) : [],
    chatMessages: Array.isArray(project.chatMessages) ? project.chatMessages.slice(-80) : [],
    emailIdentity: {
      senderName: String(project.emailIdentity?.senderName || "").trim().slice(0, 160),
      businessDetails: String(project.emailIdentity?.businessDetails || "").trim().slice(0, 600),
      physicalAddress: String(project.emailIdentity?.physicalAddress || "").trim().slice(0, 600),
      addressPreference: project.emailIdentity?.addressPreference === "include" || project.emailIdentity?.addressPreference === "omit" ? project.emailIdentity.addressPreference : "ask",
    },
    growth: normalizeGrowthPlan(project.growth),
  };
}

function createDefaultGrowthPlan() {
  return {
    objective: "" as const,
    primaryConversion: "" as const,
    analyticsEvent: "",
    selectedBy: "assistant" as const,
    rationale: "",
    targetValue: 0,
    targetPeriodDays: 30,
  };
}

function normalizeGrowthPlan(value: Partial<ProductWorkspace["growth"]> | undefined): ProductWorkspace["growth"] {
  const source = value && typeof value === "object" ? value : {};
  const objectives = new Set(["visibility", "leads", "sales", "audience", "newsletter"]);
  const conversions = new Set(["contact_form", "demo_request", "newsletter_signup", "purchase", "reply", "custom"]);
  return {
    ...createDefaultGrowthPlan(),
    ...source,
    objective: objectives.has(String(source.objective || "")) ? source.objective! : "",
    primaryConversion: conversions.has(String(source.primaryConversion || "")) ? source.primaryConversion! : "",
    analyticsEvent: String(source.analyticsEvent || "").trim().slice(0, 120),
    selectedBy: source.selectedBy === "user" ? "user" : "assistant",
    rationale: String(source.rationale || "").trim().slice(0, 600),
    targetValue: Math.max(0, Number(source.targetValue || 0)),
    targetPeriodDays: [7, 14, 30, 60, 90].includes(Number(source.targetPeriodDays)) ? Number(source.targetPeriodDays) : 30,
  };
}

function normalizeIssueNotes(value: ProductWorkspace["issueNotes"] | undefined, notes: string | undefined) {
  if (value && typeof value === "object") return { high: String(value.high || ""), attention: String(value.attention || ""), context: String(value.context || "") };
  return classifyLegacyNotes(String(notes || ""));
}

function classifyLegacyNotes(notes: string) {
  const result = { high: "", attention: "", context: "" };
  const sections = notes.split(/\n\s*\n/).map((section) => section.trim()).filter(Boolean);
  for (const section of sections) {
    const normalized = section.toLowerCase();
    const bucket = /\[high relevance\]|must not|do not use|unsupported|unverified|not independent evidence|legal|privacy|consent|compliance|prohibited|false|incorrect|material risk|claim/.test(normalized)
      ? "high"
      : /\[context|no issue|confirmed|verified|approved/.test(normalized) ? "context" : "attention";
    const clean = section.replace(/^\[(?:high relevance|needs attention|context[^\]]*)\]\s*/i, "");
    result[bucket] = [result[bucket], clean].filter(Boolean).join("\n\n");
  }
  return result;
}

function createDefaultBrand() {
  return {
    logoDataUrl: "",
    logoName: "",
    logoVariants: [],
    primaryColor: "",
    secondaryColor: "",
    accentColor: "",
    neutralLightColor: "#ffffff",
    neutralDarkColor: "#222222",
    typography: "",
    fontFamilies: [],
    fontSources: [],
    typographySystems: [],
    sourceTypographySystems: [],
    lookAndFeel: "",
    photographyStyle: "",
    imageryStyle: "",
    notes: "",
  };
}

function normalizeBrandIdentity(brand: Partial<ProductWorkspace["brand"]> | undefined): ProductWorkspace["brand"] {
  const merged = { ...createDefaultBrand(), ...(brand || {}) };
  const supplied = Array.isArray(brand?.logoVariants) ? brand.logoVariants : [];
  const variants = supplied.map((variant, index) => ({
    id: String(variant?.id || `logo-${index + 1}`).slice(0, 120),
    name: String(variant?.name || `Logo ${index + 1}`).trim().slice(0, 220),
    url: String(variant?.url || "").trim().slice(0, 2_000_000),
    usage: (["primary", "email", "light", "dark", "icon", "other"] as const).includes(variant?.usage as never) ? variant.usage! : "other" as const,
    createdAt: String(variant?.createdAt || ""),
  })).filter((variant) => /^(?:https:\/\/|data:image\/)/i.test(variant.url)).slice(0, 10);
  if (!variants.length && typeof brand?.logoDataUrl === "string" && /^(?:https:\/\/|data:image\/)/i.test(brand.logoDataUrl)) {
    variants.push({ id: "legacy-primary-logo", name: String(brand.logoName || "Primary logo"), url: brand.logoDataUrl, usage: "primary", createdAt: "" });
  }
  const primaryIndex = variants.findIndex((variant) => variant.usage === "primary");
  if (variants.length && primaryIndex < 0) variants[0] = { ...variants[0], usage: "primary" };
  let primarySeen = false;
  const normalizedVariants = variants.map((variant) => {
    if (variant.usage !== "primary") return variant;
    if (!primarySeen) { primarySeen = true; return variant; }
    return { ...variant, usage: "other" as const };
  });
  const primary = normalizedVariants.find((variant) => variant.usage === "primary") || normalizedVariants[0];
  return {
    ...merged,
    logoDataUrl: primary?.url || "",
    logoName: primary?.name || "",
    logoVariants: normalizedVariants,
    typographySystems: Array.isArray(brand?.typographySystems) ? brand.typographySystems.slice(0, 12) : [],
    sourceTypographySystems: Array.isArray(brand?.sourceTypographySystems) ? brand.sourceTypographySystems.slice(0, 12) : [],
  };
}

function cloneInitialState(): AppState {
  const project = createEmptyProject("New project", "project-default");
  return {
    projects: [project],
    activeProjectId: project.id,
    runs: [],
    schedules: { [project.id]: createDefaultSchedule() },
  };
}
