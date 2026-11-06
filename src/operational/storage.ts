import type { AgentRun, AgentSchedule, AppState, ProductWorkspace } from "./types";

const STORAGE_KEY_PREFIX = "market-agent-state-v2";

export function createDefaultSchedule(): AgentSchedule {
  return {
    enabled: false,
    action: "research",
    prompt: "Create a concise daily market pulse with notable changes, audience signals, and recommended actions.",
    useWeb: true,
    lastRunAt: null,
  };
}

export function createEmptyProject(name: string = "New project", id: string = crypto.randomUUID()): ProductWorkspace {
  return {
    id,
    name,
    website: "",
    description: "",
    audience: "",
    valueProposition: "",
    voice: "",
    guardrails: "",
    notes: "",
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
    sources: Array.isArray(project.sources) ? project.sources : [],
    materials: Array.isArray(project.materials) ? project.materials : [],
    sourceMedia: Array.isArray(project.sourceMedia) ? project.sourceMedia.slice(0, 40) : [],
    brand: { ...createDefaultBrand(), ...(project.brand || {}) },
    reviewSummary: typeof project.reviewSummary === "string" ? project.reviewSummary : "",
    openQuestions: Array.isArray(project.openQuestions) ? project.openQuestions : [],
    questionAnswers: project.questionAnswers && typeof project.questionAnswers === "object" ? project.questionAnswers : {},
    sourcePriority: project.sourcePriority === "website" || project.sourcePriority === "deck" ? project.sourcePriority : "best-evidence",
    sourceGuidance: typeof project.sourceGuidance === "string" ? project.sourceGuidance : "",
    additionalContextDraft: typeof project.additionalContextDraft === "string" ? project.additionalContextDraft : "",
    sourceWarnings: Array.isArray(project.sourceWarnings) ? project.sourceWarnings : [],
    protectedFields: Array.isArray(project.protectedFields) ? project.protectedFields.map(String).slice(0, 30) : [],
    chatMessages: Array.isArray(project.chatMessages) ? project.chatMessages.slice(-80) : [],
  };
}

function createDefaultBrand() {
  return {
    logoDataUrl: "",
    logoName: "",
    primaryColor: "#7856ff",
    secondaryColor: "#4d9a75",
    accentColor: "#f2a65a",
    neutralLightColor: "#ffffff",
    neutralDarkColor: "#222222",
    typography: "",
    imageryStyle: "",
    notes: "",
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
