import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { neon, Pool as NeonPool } from "@neondatabase/serverless";
import { assertExperimentReady, emptySectorExpertise, normalizeSectorExpertise } from "./intelligence.mjs";

const databases = new Map();

export function normalizeDatabaseError(error) {
  const message = String(error?.message || "");
  const quotaExceeded = String(error?.code || "") === "53000" || /account or project has exceeded the quota/i.test(message);
  const connectionUnavailable = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(String(error?.code || ""))
    || /connection terminated unexpectedly|authentication timed out|network socket disconnected|secure tls connection|connection timeout|fetch failed|failed to fetch|socket hang up/i.test(message);
  if (!quotaExceeded && !connectionUnavailable) return error;
  const normalized = new Error(quotaExceeded
    ? "Market Agent’s cloud database has reached its capacity limit. This is a platform-owner issue, not your account. Nothing was sent or published. Try again after database capacity is restored."
    : "Market Agent’s cloud database is temporarily unavailable. This is a platform-owner issue, not your account. Nothing was sent or published. Try again after the database service is restored.");
  normalized.statusCode = 503;
  normalized.code = quotaExceeded ? "DATABASE_CAPACITY_EXCEEDED" : "DATABASE_UNAVAILABLE";
  normalized.cause = error;
  return normalized;
}

function protectTransactionClient(client, transactionPool) {
  const query = client.query.bind(client);
  const release = client.release.bind(client);
  let released = false;
  client.query = (...args) => query(...args).catch((error) => { throw normalizeDatabaseError(error); });
  client.release = () => {
    if (released) return;
    released = true;
    release();
    void transactionPool.end().catch((error) => console.warn("[database] Transaction connection close failed:", normalizeDatabaseError(error).message));
  };
  return client;
}

function createServerlessDatabase(connectionString) {
  // Regular queries use Neon's stateless HTTPS transport. This avoids keeping a
  // TCP pool alive across Vercel function freezes, which caused repeated cold
  // start authentication and connection timeouts in production.
  const sql = neon(connectionString, { fullResults: true });
  return {
    query: (...args) => sql.query(...args).catch((error) => { throw normalizeDatabaseError(error); }),
    applySchema: (statements) => sql.transaction((transaction) => [
      // Cold functions and migrations can modify some of the same tables.
      transaction.query("SELECT pg_advisory_xact_lock(hashtext('market-agent-schema-migrations'))"),
      ...statements.map((statement) => transaction.query(statement)),
    ]).catch((error) => { throw normalizeDatabaseError(error); }),
    connect: async () => {
      // Transactions need a session, so give each transaction its own short-lived
      // WebSocket pool and close it as soon as the caller releases the client.
      const transactionPool = new NeonPool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 15_000,
        idleTimeoutMillis: 1_000,
      });
      transactionPool.on("error", (error) => console.warn("[database] Transaction connection closed:", normalizeDatabaseError(error).message));
      try {
        return protectTransactionClient(await transactionPool.connect(), transactionPool);
      } catch (error) {
        await transactionPool.end().catch(() => undefined);
        throw normalizeDatabaseError(error);
      }
    },
  };
}

export function getPool(env = process.env) {
  if (!env.DATABASE_URL) {
    const error = new Error("The cloud database is not configured.");
    error.statusCode = 503;
    throw error;
  }

  if (!databases.has(env.DATABASE_URL)) databases.set(env.DATABASE_URL, createServerlessDatabase(env.DATABASE_URL));
  return databases.get(env.DATABASE_URL);
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

export function authoritativeRuns(legacyRuns, normalizedRows, normalizedTableAvailable = true) {
  const source = normalizedTableAvailable
    ? normalizedRows.map((row) => row?.data)
    : legacyRuns;
  const runs = new Map();
  for (const run of source || []) if (run?.id) runs.set(run.id, run);
  return Array.from(runs.values())
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
    .slice(0, 250);
}

export async function loadStateForUser(userId, env = process.env) {
  try {
    return await loadStateForUserOnce(userId, env);
  } catch (error) {
    const normalized = normalizeDatabaseError(error);
    if (normalized?.code !== "DATABASE_UNAVAILABLE") throw normalized;
    await new Promise((resolve) => setTimeout(resolve, 750));
    return loadStateForUserOnce(userId, env);
  }
}

export async function loadProjectForSectorResearch(userId, projectId, env = process.env) {
  const result = await getPool(env).query(
    `SELECT project FROM market_agent_states
       CROSS JOIN LATERAL jsonb_array_elements(state->'projects') AS projects(project)
      WHERE user_id = $1 AND project->>'id' = $2`,
    [userId, projectId],
  );
  const project = result.rows[0]?.project;
  if (!project) throw Object.assign(new Error("This project could not be found. Open a saved project and try again."), { statusCode: 404 });
  return project;
}

export async function saveProjectSectorExpertise(userId, projectId, researched, env = process.env) {
  const database = getPool(env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const project = await loadProjectForSectorResearch(userId, projectId, env);
    const previous = project.sectorExpertise ?? null;
    const expertise = normalizeSectorExpertise(researched, previous);
    const result = await database.query(
      `UPDATE market_agent_states AS workspace
          SET state = jsonb_set(workspace.state, '{projects}', (
                SELECT jsonb_agg(CASE WHEN project->>'id' = $2
                  THEN jsonb_set(project, '{sectorExpertise}', $3::jsonb) ELSE project END ORDER BY ordinal)
                  FROM jsonb_array_elements(workspace.state->'projects') WITH ORDINALITY AS target(project, ordinal)
              )), revision = workspace.revision + 1, updated_at = NOW()
        WHERE workspace.user_id = $1 AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(workspace.state->'projects') AS target(project)
           WHERE project->>'id' = $2 AND COALESCE(project->'sectorExpertise', 'null'::jsonb) = $4::jsonb
        )
        RETURNING revision`,
      [userId, projectId, JSON.stringify(expertise), JSON.stringify(previous)],
    );
    if (result.rows[0]) return { sectorExpertise: expertise, revision: Number(result.rows[0].revision) };
  }
  throw Object.assign(new Error("Sector expertise changed while research was running. Refresh the evidence again to merge the latest changes."), { statusCode: 409 });
}

async function loadStateForUserOnce(userId, env) {
  const database = getPool(env);
  const [result, runRows, scheduleRows, messageRows] = await Promise.all([
    database.query("SELECT state, revision FROM market_agent_states WHERE user_id = $1", [userId]),
    database.query("SELECT data FROM market_agent_runs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 250", [userId])
      .then((value) => ({ rows: value.rows, available: true }))
      .catch(() => ({ rows: [], available: false })),
    database.query("SELECT project_id, data FROM market_agent_schedules WHERE user_id = $1", [userId]).catch(() => ({ rows: [] })),
    database.query(
      `SELECT project_id,data,created_at FROM (
         SELECT project_id,data,created_at,
                ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS message_rank
         FROM market_agent_project_messages WHERE user_id = $1
       ) recent WHERE message_rank <= 80 ORDER BY project_id,created_at ASC`,
      [userId],
    ).catch(() => ({ rows: [] })),
  ]);
  if (!result.rows[0]) return { state: defaultState(), isEmpty: true, revision: 0 };
  const state = normalizeState(result.rows[0].state);
  // Once the normalized campaign table exists, it is the source of truth.
  // Falling back to the JSON state is only for installations that have not
  // run the normalization migration yet. Unioning the two sources would let
  // stale JSON restore a campaign after its normalized row was deleted.
  state.runs = authoritativeRuns(state.runs, runRows.rows, runRows.available);
  for (const row of scheduleRows.rows) state.schedules[row.project_id] = { ...defaultSchedule(), ...(row.data || {}) };
  const messages = new Map();
  for (const row of messageRows.rows) {
    if (!messages.has(row.project_id)) messages.set(row.project_id, []);
    messages.get(row.project_id).push(row.data);
  }
  for (const project of state.projects) if (messages.has(project.id)) project.chatMessages = messages.get(project.id).slice(-80);
  return { state, isEmpty: false, revision: Number(result.rows[0].revision || 0) };
}

export async function saveStateForUser(userId, state, env = process.env, expectedRevision = null) {
  const normalized = normalizeState(state);
  const revision = Number.isInteger(expectedRevision) && expectedRevision >= 0 ? expectedRevision : null;
  const result = await getPool(env).query(
    `INSERT INTO market_agent_states (user_id, state, revision)
     VALUES ($1, $2::jsonb, 1)
     ON CONFLICT (user_id) DO UPDATE
     SET state = EXCLUDED.state, revision = market_agent_states.revision + 1, updated_at = NOW()
     WHERE $3::integer IS NULL OR market_agent_states.revision = $3::integer
     RETURNING state, revision`,
    [userId, JSON.stringify(normalized), revision],
  );
  if (!result.rows[0]) {
    const current = await loadStateForUser(userId, env);
    const error = new Error("This workspace changed in another tab or background task. The newer work was preserved.");
    error.statusCode = 409;
    error.current = current;
    throw error;
  }
  await persistNormalizedState(userId, normalized, env);
  return { state: normalizeState(result.rows[0].state), revision: Number(result.rows[0].revision || 0) };
}

async function persistNormalizedState(userId, state, env) {
  const database = getPool(env);
  const writes = [];
  for (const [projectId, schedule] of Object.entries(state.schedules || {})) writes.push(database.query(
    `INSERT INTO market_agent_schedules (user_id, project_id, data, updated_at) VALUES ($1,$2,$3::jsonb,NOW())
      ON CONFLICT (user_id, project_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [userId, projectId, JSON.stringify(schedule)],
  ));
  for (const project of state.projects || []) for (const message of project.chatMessages || []) if (message?.id) writes.push(database.query(
    `INSERT INTO market_agent_project_messages (user_id, project_id, id, data, created_at)
      VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz) ON CONFLICT (user_id, id) DO UPDATE SET data = EXCLUDED.data`,
    [userId, project.id, message.id, JSON.stringify(message), message.createdAt || new Date().toISOString()],
  ));
  await Promise.all(writes);
}

export async function appendRunForUser(userId, run, env = process.env) {
  const initial = defaultState();
  initial.runs = [run];
  const database = getPool(env);
  await database.query(
    `INSERT INTO market_agent_runs (user_id, id, project_id, data, created_at)
      VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
      ON CONFLICT (user_id, id) DO UPDATE SET data = EXCLUDED.data`,
    [userId, run.id, run.projectId || "project-default", JSON.stringify(run), run.createdAt || new Date().toISOString()],
  );
  let result = await database.query(
    `INSERT INTO market_agent_states (user_id, state)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE
     SET state = jsonb_set(
       market_agent_states.state,
       '{runs}',
       jsonb_build_array($3::jsonb) || COALESCE(market_agent_states.state->'runs', '[]'::jsonb),
       true
     ), revision = market_agent_states.revision + 1, updated_at = NOW()
     RETURNING state, revision`,
    [userId, JSON.stringify(initial), JSON.stringify(run)],
  );
  if (run.sectorExpertise?.items?.length) {
    const currentProject = (Array.isArray(result.rows[0]?.state?.projects) ? result.rows[0].state.projects : [])
      .find((project) => project?.id === (run.projectId || "project-default"));
    const expertise = normalizeSectorExpertise(run.sectorExpertise, currentProject?.sectorExpertise);
    result = await database.query(
      `UPDATE market_agent_states
          SET state = jsonb_set(
            state,
            '{projects}',
            COALESCE(
              (SELECT jsonb_agg(
                CASE WHEN project->>'id' = $2
                  THEN jsonb_set(project, '{sectorExpertise}', $3::jsonb, true)
                  ELSE project
                END
              ) FROM jsonb_array_elements(COALESCE(state->'projects', '[]'::jsonb)) project),
              COALESCE(state->'projects', '[]'::jsonb)
            ),
            true
          ),
          revision = revision + 1,
          updated_at = NOW()
        WHERE user_id = $1
        RETURNING state, revision`,
      [userId, run.projectId || "project-default", JSON.stringify(expertise)],
    );
  }
  return normalizeState(result.rows[0].state);
}

export async function updateRunStatusForUser(userId, runId, status, env = process.env) {
  const id = String(runId || "").trim().slice(0, 200);
  const nextStatus = String(status || "").trim();
  if (!id || !["Draft", "Approved"].includes(nextStatus)) {
    const error = new Error("Choose a campaign and a valid review status.");
    error.statusCode = 400;
    throw error;
  }
  const client = await getPool(env).connect();
  try {
    await client.query("BEGIN");
    const currentRun = await client.query("SELECT data FROM market_agent_runs WHERE user_id = $1 AND id = $2 FOR UPDATE", [userId, id]);
    if (!currentRun.rows[0]?.data) {
      const error = new Error("The campaign could not be found.");
      error.statusCode = 404;
      throw error;
    }
    const now = new Date().toISOString();
    const run = { ...currentRun.rows[0].data, status: nextStatus };
    if (nextStatus === "Approved" && ["campaign", "social", "chat"].includes(String(run.action || ""))) {
      assertExperimentReady(run);
      const currentTracking = run.campaignTracking && typeof run.campaignTracking === "object" ? run.campaignTracking : {};
      run.campaignTracking = {
        status: currentTracking.startedAt ? "active" : "ready",
        campaignId: id,
        campaignName: String(run.title || "Campaign").slice(0, 200),
        approvedAt: currentTracking.approvedAt || now,
        startedAt: currentTracking.startedAt || null,
      };
    } else if (nextStatus === "Draft" && run.campaignTracking && !run.campaignTracking.startedAt) {
      delete run.campaignTracking;
    }
    const updatedRun = await client.query(
      "UPDATE market_agent_runs SET data = $3::jsonb WHERE user_id = $1 AND id = $2 RETURNING data",
      [userId, id, JSON.stringify(run)],
    );
    const updatedState = await client.query(
      `UPDATE market_agent_states SET state = jsonb_set(
         state, '{runs}',
         COALESCE((SELECT jsonb_agg(CASE WHEN item->>'id' = $2 THEN $3::jsonb ELSE item END)
           FROM jsonb_array_elements(COALESCE(state->'runs','[]'::jsonb)) AS item), '[]'::jsonb), true),
         revision = revision + 1, updated_at = NOW()
       WHERE user_id = $1 RETURNING revision`,
      [userId, id, JSON.stringify(updatedRun.rows[0].data)],
    );
    await client.query("COMMIT");
    return { run: updatedRun.rows[0].data, revision: Number(updatedState.rows[0]?.revision || 0) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteRunForUser(userId, runId, env = process.env) {
  const id = String(runId || "").trim().slice(0, 200);
  if (!id) {
    const error = new Error("Choose a campaign to delete.");
    error.statusCode = 400;
    throw error;
  }
  const client = await getPool(env).connect();
  try {
    await client.query("BEGIN");
    const active = await client.query("SELECT COUNT(*)::int AS count FROM market_agent_delivery_jobs WHERE user_id = $1 AND run_id = $2 AND status IN ('running','submitted')", [userId, id]).catch(() => ({ rows: [{ count: 0 }] }));
    if (Number(active.rows[0]?.count || 0) > 0) {
      const error = new Error("This campaign has a publication currently processing. Wait for the platform result before deleting it.");
      error.statusCode = 409;
      throw error;
    }
    await client.query("DELETE FROM market_agent_delivery_jobs WHERE user_id = $1 AND run_id = $2 AND status <> 'complete'", [userId, id]).catch(() => undefined);
    const deleted = await client.query("DELETE FROM market_agent_runs WHERE user_id = $1 AND id = $2 RETURNING id", [userId, id]);
    if (!deleted.rows[0]) {
      const error = new Error("The campaign was already removed.");
      error.statusCode = 404;
      throw error;
    }
    const updated = await client.query(
      `UPDATE market_agent_states SET state = jsonb_set(
         state, '{runs}',
         COALESCE((SELECT jsonb_agg(item) FROM jsonb_array_elements(COALESCE(state->'runs','[]'::jsonb)) AS item WHERE item->>'id' <> $2), '[]'::jsonb),
         true), revision = revision + 1, updated_at = NOW()
       WHERE user_id = $1 RETURNING revision`,
      [userId, id],
    );
    await client.query("COMMIT");
    return { ok: true, id, revision: Number(updated.rows[0]?.revision || 0) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markScheduleRunForUser(userId, projectId, ranAt, env = process.env) {
  const database = getPool(env);
  await database.query(
    `UPDATE market_agent_states
      SET state = jsonb_set(state, ARRAY['schedules', $2, 'lastRunAt'], to_jsonb($3::text), true),
          revision = revision + 1,
          updated_at = NOW()
      WHERE user_id = $1`,
    [userId, projectId, ranAt],
  );
  await database.query(
    `INSERT INTO market_agent_schedules (user_id, project_id, data, updated_at)
      SELECT $1, $2, state->'schedules'->$2, NOW() FROM market_agent_states WHERE user_id = $1
      ON CONFLICT (user_id, project_id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
    [userId, projectId],
  );
}

export async function enforceRunBudget(userId, mode, env = process.env) {
  const { state } = await loadStateForUser(userId, env);
  const today = new Date().toISOString().slice(0, 10);
  const todaysRuns = state.runs.filter((run) => String(run.createdAt || "").slice(0, 10) === today);
  const panelRuns = todaysRuns.filter(isPanelRun);
  if (todaysRuns.length >= 25 || (mode === "panel" && panelRuns.length >= 5)) {
    const error = new Error(mode === "panel" ? "The five-per-day balanced panel limit has been reached." : "The daily agent limit has been reached.");
    error.statusCode = 429;
    throw error;
  }
}

export function isPanelRun(run) {
  return run?.executionMode === "panel" || /(?:panel|three-way strategy review|collaborative review)/i.test(String(run?.model || ""));
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
  const database = getPool(migrationEnv);
  await database.query(`CREATE TABLE IF NOT EXISTS market_agent_schema_migrations (
    filename TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const client = await database.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('market-agent-schema-migrations'))");
    for (const file of files) {
      const sql = await readFile(`${migrationDirectory}/${file}`, "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query("SELECT checksum FROM market_agent_schema_migrations WHERE filename = $1", [file]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Applied migration ${file} was modified. Add a new migration instead.`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO market_agent_schema_migrations (filename, checksum) VALUES ($1, $2)", [file, checksum]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('market-agent-schema-migrations'))").catch(() => undefined);
    client.release();
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
    brand: defaultBrand(),
    reviewSummary: "",
    openQuestions: [],
    questionAnswers: {},
    additionalContextDraft: "",
    sourceWarnings: [],
    protectedFields: [],
    chatMessages: [],
    emailIdentity: defaultEmailIdentity(),
    growth: defaultGrowthPlan(),
    sectorExpertise: emptySectorExpertise(),
    updatedAt: new Date().toISOString(),
  };
}

function defaultSchedule() {
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

function normalizeProject(value, index) {
  const project = value && typeof value === "object" ? value : {};
  const id = project.id || `project-${index + 1}`;
  return {
    ...defaultProject(index === 0 ? "New project" : `Project ${index + 1}`, id),
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
    brand: normalizeBrand(project.brand),
    reviewSummary: typeof project.reviewSummary === "string" ? project.reviewSummary : "",
    openQuestions: Array.isArray(project.openQuestions) ? project.openQuestions : [],
    questionAnswers: project.questionAnswers && typeof project.questionAnswers === "object" ? project.questionAnswers : {},
    additionalContextDraft: typeof project.additionalContextDraft === "string" ? project.additionalContextDraft : "",
    sourceWarnings: Array.isArray(project.sourceWarnings) ? project.sourceWarnings : [],
    protectedFields: Array.isArray(project.protectedFields) ? project.protectedFields.map(String).slice(0, 30) : [],
    chatMessages: Array.isArray(project.chatMessages) ? project.chatMessages.slice(-80) : [],
    emailIdentity: normalizeEmailIdentity(project.emailIdentity),
    growth: normalizeGrowthPlan(project.growth),
    sectorExpertise: normalizeSectorExpertise(project.sectorExpertise),
  };
}

function defaultEmailIdentity() {
  return { senderName: "", businessDetails: "", physicalAddress: "", addressPreference: "ask" };
}

function normalizeEmailIdentity(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    senderName: String(source.senderName || "").trim().slice(0, 160),
    businessDetails: String(source.businessDetails || "").trim().slice(0, 600),
    physicalAddress: String(source.physicalAddress || "").trim().slice(0, 600),
    addressPreference: ["ask", "include", "omit"].includes(source.addressPreference) ? source.addressPreference : "ask",
  };
}

function defaultGrowthPlan() {
  return { objective: "", primaryConversion: "", analyticsEvent: "", selectedBy: "assistant", rationale: "", targetValue: 0, targetPeriodDays: 30 };
}

function normalizeGrowthPlan(value) {
  const source = value && typeof value === "object" ? value : {};
  const objectives = new Set(["visibility", "leads", "sales", "audience", "newsletter"]);
  const conversions = new Set(["contact_form", "demo_request", "newsletter_signup", "purchase", "reply", "custom"]);
  return {
    ...defaultGrowthPlan(),
    ...source,
    objective: objectives.has(String(source.objective || "")) ? String(source.objective) : "",
    primaryConversion: conversions.has(String(source.primaryConversion || "")) ? String(source.primaryConversion) : "",
    analyticsEvent: String(source.analyticsEvent || "").trim().slice(0, 120),
    selectedBy: source.selectedBy === "user" ? "user" : "assistant",
    rationale: String(source.rationale || "").trim().slice(0, 600),
    targetValue: Math.max(0, Number(source.targetValue || 0)),
    targetPeriodDays: [7, 14, 30, 60, 90].includes(Number(source.targetPeriodDays)) ? Number(source.targetPeriodDays) : 30,
  };
}

function normalizeIssueNotes(value, notes) {
  if (value && typeof value === "object") return { high: String(value.high || ""), attention: String(value.attention || ""), context: String(value.context || "") };
  const result = { high: "", attention: "", context: "" };
  for (const section of String(notes || "").split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean)) {
    const normalized = section.toLowerCase();
    const bucket = /\[high relevance\]|must not|do not use|unsupported|unverified|not independent evidence|legal|privacy|consent|compliance|prohibited|false|incorrect|material risk|claim/.test(normalized)
      ? "high"
      : /\[context|no issue|confirmed|verified|approved/.test(normalized) ? "context" : "attention";
    const clean = section.replace(/^\[(?:high relevance|needs attention|context[^\]]*)\]\s*/i, "");
    result[bucket] = [result[bucket], clean].filter(Boolean).join("\n\n");
  }
  return result;
}

function defaultBrand() {
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

function normalizeBrand(value) {
  const source = value && typeof value === "object" ? value : {};
  const supplied = Array.isArray(source.logoVariants) ? source.logoVariants : [];
  const variants = supplied.map((variant, index) => ({
    id: String(variant?.id || `logo-${index + 1}`).slice(0, 120),
    name: String(variant?.name || `Logo ${index + 1}`).trim().slice(0, 220),
    url: String(variant?.url || "").trim().slice(0, 2_000_000),
    usage: ["primary", "email", "light", "dark", "icon", "other"].includes(variant?.usage) ? variant.usage : "other",
    createdAt: String(variant?.createdAt || ""),
  })).filter((variant) => /^(?:https:\/\/|data:image\/)/i.test(variant.url)).slice(0, 10);
  if (!variants.length && /^(?:https:\/\/|data:image\/)/i.test(String(source.logoDataUrl || ""))) variants.push({ id: "legacy-primary-logo", name: String(source.logoName || "Primary logo"), url: source.logoDataUrl, usage: "primary", createdAt: "" });
  if (variants.length && !variants.some((variant) => variant.usage === "primary")) variants[0].usage = "primary";
  let primarySeen = false;
  const normalizedVariants = variants.map((variant) => {
    if (variant.usage !== "primary") return variant;
    if (!primarySeen) { primarySeen = true; return variant; }
    return { ...variant, usage: "other" };
  });
  const primary = normalizedVariants.find((variant) => variant.usage === "primary") || normalizedVariants[0];
  return {
    ...defaultBrand(),
    ...source,
    logoDataUrl: primary?.url || "",
    logoName: primary?.name || "",
    logoVariants: normalizedVariants,
    typographySystems: Array.isArray(source.typographySystems) ? source.typographySystems.slice(0, 12) : [],
    sourceTypographySystems: Array.isArray(source.sourceTypographySystems) ? source.sourceTypographySystems.slice(0, 12) : [],
  };
}
