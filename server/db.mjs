import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { attachDatabasePool } from "@vercel/functions";

const { Pool } = pg;
let pool;
let attached = false;

export function getPool(env = process.env) {
  if (!env.DATABASE_URL) {
    const error = new Error("The cloud database is not configured.");
    error.statusCode = 503;
    throw error;
  }

  if (!pool) {
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
  }

  if (env.VERCEL && !attached) {
    attachDatabasePool(pool);
    attached = true;
  }

  return pool;
}

export function defaultState() {
  const project = defaultProject();
  return {
    projects: [project],
    activeProjectId: project.id,
    runs: [],
    schedules: { [project.id]: defaultSchedule() },
  };
}

export async function loadStateForUser(userId, env = process.env) {
  const result = await getPool(env).query(
    "SELECT state FROM market_agent_states WHERE user_id = $1",
    [userId],
  );
  if (!result.rows[0]) return { state: defaultState(), isEmpty: true };
  return { state: normalizeState(result.rows[0].state), isEmpty: false };
}

export async function saveStateForUser(userId, state, env = process.env) {
  const normalized = normalizeState(state);
  await getPool(env).query(
    `INSERT INTO market_agent_states (user_id, state)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
     SET state = EXCLUDED.state, updated_at = NOW()`,
    [userId, JSON.stringify(normalized)],
  );
  return normalized;
}

export async function appendRunForUser(userId, run, env = process.env) {
  const initial = defaultState();
  initial.runs = [run];
  const result = await getPool(env).query(
    `INSERT INTO market_agent_states (user_id, state)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
     SET state = jsonb_set(
       market_agent_states.state,
       '{runs}',
       jsonb_build_array($3::jsonb) || COALESCE(market_agent_states.state->'runs', '[]'::jsonb),
       true
     ), updated_at = NOW()
     RETURNING state`,
    [userId, JSON.stringify(initial), JSON.stringify(run)],
  );
  return normalizeState(result.rows[0].state);
}

export async function enforceRunBudget(userId, mode, env = process.env) {
  const { state } = await loadStateForUser(userId, env);
  const today = new Date().toISOString().slice(0, 10);
  const todaysRuns = state.runs.filter((run) => String(run.createdAt || "").slice(0, 10) === today);
  const panelRuns = todaysRuns.filter((run) => String(run.model || "").includes("panel"));
  if (todaysRuns.length >= 25 || (mode === "panel" && panelRuns.length >= 5)) {
    const error = new Error(mode === "panel" ? "The five-per-day balanced panel limit has been reached." : "The daily agent limit has been reached.");
    error.statusCode = 429;
    throw error;
  }
}

export async function listScheduledStates(env = process.env) {
  const result = await getPool(env).query(
    "SELECT user_id, state FROM market_agent_states",
  );
  return result.rows.flatMap((row) => {
    const state = normalizeState(row.state);
    return state.projects.flatMap((project) => {
      const schedule = state.schedules[project.id];
      return schedule?.enabled ? [{ userId: row.user_id, state, project, schedule }] : [];
    });
  });
}

export async function runMigrations(env = process.env) {
  const migrationDirectory = fileURLToPath(new URL("./migrations/", import.meta.url));
  const files = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  const migrationEnv = { ...env, DATABASE_URL: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL };
  for (const file of files) {
    const sql = await readFile(`${migrationDirectory}/${file}`, "utf8");
    await getPool(migrationEnv).query(sql);
  }
}

function normalizeState(value) {
  const initial = defaultState();
  const source = value && typeof value === "object" ? value : {};
  const legacyWorkspace = source.workspace && typeof source.workspace === "object" ? source.workspace : null;
  const rawProjects = Array.isArray(source.projects) ? source.projects : legacyWorkspace ? [legacyWorkspace] : [];
  const projects = rawProjects.length
    ? rawProjects.map((project, index) => normalizeProject(project, index))
    : initial.projects;
  const requestedActiveId = typeof source.activeProjectId === "string" ? source.activeProjectId : projects[0].id;
  const activeProjectId = projects.some((project) => project.id === requestedActiveId) ? requestedActiveId : projects[0].id;
  const rawSchedules = source.schedules && typeof source.schedules === "object" ? source.schedules : {};
  const legacySchedule = source.schedule && typeof source.schedule === "object" ? source.schedule : null;
  const schedules = Object.fromEntries(projects.map((project) => [
    project.id,
    { ...defaultSchedule(), ...(rawSchedules[project.id] || (project.id === activeProjectId ? legacySchedule : null) || {}) },
  ]));
  return {
    projects,
    activeProjectId,
    runs: Array.isArray(source.runs)
      ? source.runs.slice(0, 250).map((run) => ({ ...run, projectId: run.projectId || activeProjectId }))
      : [],
    schedules,
  };
}

function defaultProject(name = "New project", id = "project-default") {
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
    sources: [],
    materials: [],
    brand: defaultBrand(),
    reviewSummary: "",
    openQuestions: [],
    questionAnswers: {},
    additionalContextDraft: "",
    sourceWarnings: [],
    chatMessages: [],
    updatedAt: new Date().toISOString(),
  };
}

function defaultSchedule() {
  return {
    enabled: false,
    action: "research",
    prompt: "Create a concise daily market pulse with notable changes, audience signals, and recommended actions.",
    useWeb: true,
    lastRunAt: null,
  };
}

function normalizeProject(value, index) {
  const project = value && typeof value === "object" ? value : {};
  const id = project.id || `project-${index + 1}`;
  return {
    ...defaultProject(index === 0 ? "New project" : `Project ${index + 1}`, id),
    ...project,
    id,
    sources: Array.isArray(project.sources) ? project.sources : [],
    materials: Array.isArray(project.materials) ? project.materials : [],
    brand: { ...defaultBrand(), ...(project.brand || {}) },
    reviewSummary: typeof project.reviewSummary === "string" ? project.reviewSummary : "",
    openQuestions: Array.isArray(project.openQuestions) ? project.openQuestions : [],
    questionAnswers: project.questionAnswers && typeof project.questionAnswers === "object" ? project.questionAnswers : {},
    additionalContextDraft: typeof project.additionalContextDraft === "string" ? project.additionalContextDraft : "",
    sourceWarnings: Array.isArray(project.sourceWarnings) ? project.sourceWarnings : [],
    chatMessages: Array.isArray(project.chatMessages) ? project.chatMessages.slice(-80) : [],
  };
}

function defaultBrand() {
  return {
    logoDataUrl: "",
    logoName: "",
    primaryColor: "#222222",
    secondaryColor: "#f4f1e8",
    accentColor: "#4d9a75",
    typography: "",
    imageryStyle: "",
    notes: "",
  };
}
