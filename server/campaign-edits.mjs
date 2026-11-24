import { getPool } from "./db.mjs";
import { replaceCampaignLinks } from "./email-content.mjs";

export function editableCampaignRunId(runId, uiContext = {}) {
  const id = String(runId || "").trim().slice(0, 200);
  if (!id) return "";
  const page = String(uiContext?.page || "");
  const section = String(uiContext?.campaignSection || "");
  const selectedRunId = String(uiContext?.selectedRunId || "").trim().slice(0, 200);
  if (page === "campaigns") return section === "newsletter" ? "" : id;
  return selectedRunId === id ? id : "";
}

export async function getCampaignActionContext(userId, projectId, runId, env = process.env) {
  if (!runId) return null;
  const result = await getPool(env).query(
    "SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1",
    [userId, projectId, runId],
  );
  const run = result.rows[0]?.data;
  if (!run) return null;
  return {
    id: run.id,
    title: run.title || "Campaign",
    status: run.status || "Draft",
    output: String(run.output || "").slice(0, 30_000),
    experimentPlan: run.experimentPlan && typeof run.experimentPlan === "object" ? run.experimentPlan : null,
    items: (run.campaignPlan?.items || []).slice(0, 30).map((item, index) => ({ index, channel: item.channel, subject: item.subject || "", text: String(item.text || "").slice(0, 4_000), scheduledAt: item.scheduledAt || "" })),
  };
}

export async function updateCampaignText(userId, projectId, runId, findText, replacementText, env = process.env) {
  const needle = String(findText || "");
  const replacement = String(replacementText || "");
  if (!runId || !needle || !replacement || needle === replacement) return null;
  const result = await getPool(env).query(
    "SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1",
    [userId, projectId, runId],
  );
  const run = result.rows[0]?.data;
  if (!run || run.status === "Approved") return null;
  let replaced = 0;
  const replaceExact = (value) => {
    const text = String(value || "");
    if (!text.includes(needle)) return text;
    replaced += text.split(needle).length - 1;
    return text.split(needle).join(replacement);
  };
  const output = replaceExact(run.output);
  const campaignPlan = run.campaignPlan?.items?.length ? {
    ...run.campaignPlan,
    items: run.campaignPlan.items.map((item) => ({ ...item, subject: replaceExact(item?.subject), text: replaceExact(item?.text) })),
  } : run.campaignPlan;
  if (!replaced) return { run, replaced: 0 };
  const updated = { ...run, output, campaignPlan };
  const revision = await persistCampaignRun(userId, projectId, runId, updated, env);
  return { run: updated, replaced, revision };
}

export function appendMarkdownTableColumn(markdown, columnName, defaultValue = "Unknown", tableHint = "") {
  const lines = String(markdown || "").split("\n");
  const requestedName = String(columnName || "").replace(/[|\r\n]+/g, " ").trim().slice(0, 120);
  const requestedValue = String(defaultValue || "Unknown").replace(/[|\r\n]+/g, " ").trim().slice(0, 500) || "Unknown";
  const hint = String(tableHint || "").trim().toLowerCase();
  if (!requestedName) return { text: String(markdown || ""), changed: false, alreadyPresent: false, rowCount: 0 };

  const table = findMarkdownTable(lines, hint);
  if (!table) return { text: String(markdown || ""), changed: false, alreadyPresent: false, rowCount: 0 };
  const headers = markdownCells(lines[table.start]);
  if (headers.some((header) => header.toLowerCase() === requestedName.toLowerCase())) {
    return { text: String(markdown || ""), changed: false, alreadyPresent: true, rowCount: Math.max(0, table.end - table.start - 2) };
  }

  lines[table.start] = appendMarkdownCell(lines[table.start], requestedName);
  lines[table.start + 1] = appendMarkdownCell(lines[table.start + 1], "---");
  for (let index = table.start + 2; index < table.end; index += 1) lines[index] = appendMarkdownCell(lines[index], requestedValue);
  return { text: lines.join("\n"), changed: true, alreadyPresent: false, rowCount: Math.max(0, table.end - table.start - 2) };
}

export function extractMarkdownTableRows(markdown, tableHint = "people") {
  const lines = String(markdown || "").split("\n");
  const table = findMarkdownTable(lines, String(tableHint || "").trim().toLowerCase());
  if (!table) return { found: false, headers: [], rows: [] };
  const headers = markdownCells(lines[table.start]);
  const rows = lines.slice(table.start + 2, table.end).map((line, rowIndex) => {
    const cells = markdownCells(line);
    const values = Object.fromEntries(headers.map((header, index) => [header, cells[index] || ""]));
    return { rowIndex, cells, values };
  });
  return { found: true, headers, rows };
}

export function setMarkdownTableColumnValues(markdown, columnName, rowValues = [], tableHint = "people") {
  const original = String(markdown || "");
  const lines = original.split("\n");
  const requestedName = String(columnName || "").replace(/[|\r\n]+/g, " ").trim().slice(0, 120);
  const hint = String(tableHint || "").trim().toLowerCase();
  const table = findMarkdownTable(lines, hint);
  if (!requestedName || !table) return { text: original, changed: false, tableFound: false, rowCount: 0 };
  const headers = markdownCells(lines[table.start]);
  let columnIndex = headers.findIndex((header) => header.toLowerCase() === requestedName.toLowerCase());
  if (columnIndex < 0) {
    columnIndex = headers.length;
    lines[table.start] = appendMarkdownCell(lines[table.start], requestedName);
    lines[table.start + 1] = appendMarkdownCell(lines[table.start + 1], "---");
  }
  const valueMap = new Map((Array.isArray(rowValues) ? rowValues : []).map((entry, index) => [Number.isInteger(entry?.rowIndex) ? entry.rowIndex : index, sanitizeMarkdownCell(entry?.value)]));
  for (let lineIndex = table.start + 2; lineIndex < table.end; lineIndex += 1) {
    const rowIndex = lineIndex - table.start - 2;
    const cells = markdownCells(lines[lineIndex]);
    while (cells.length <= columnIndex) cells.push("");
    cells[columnIndex] = valueMap.get(rowIndex) || "Not found";
    lines[lineIndex] = `| ${cells.join(" | ")} |`;
  }
  const text = lines.join("\n");
  return { text, changed: text !== original, tableFound: true, rowCount: Math.max(0, table.end - table.start - 2) };
}

export async function getCampaignPeopleTable(userId, projectId, runId, tableHint = "people", env = process.env) {
  if (!runId) throw campaignEditError("There is no active people table to enrich.", 400);
  const result = await getPool(env).query(
    "SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1",
    [userId, projectId, runId],
  );
  const run = result.rows[0]?.data;
  if (!run) throw campaignEditError("The campaign could not be found.", 404);
  const table = extractMarkdownTableRows(run.output, tableHint);
  if (!table.found) throw campaignEditError("No People table was found in the visible record.", 400);
  const peopleHeader = table.headers.find((header) => /\b(people|person|prospects?|contacts?|leads?)\b/i.test(header));
  if (!peopleHeader) throw campaignEditError("The visible table does not contain a People column.", 400);
  const organizationHeader = table.headers.find((header) => /\b(brand|company|organization|account|venue)\b/i.test(header));
  return {
    run,
    headers: table.headers,
    rows: table.rows.map((row) => ({
      rowIndex: row.rowIndex,
      organization: organizationHeader ? row.values[organizationHeader] : "",
      people: row.values[peopleHeader] || "",
      context: Object.entries(row.values).filter(([header]) => header !== peopleHeader).map(([header, value]) => `${header}: ${value}`).join("; "),
    })),
  };
}

export async function setCampaignTableColumnValues(userId, projectId, runId, columnName, rowValues, tableHint = "people", sources = [], env = process.env) {
  const result = await getPool(env).query(
    "SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1",
    [userId, projectId, runId],
  );
  const run = result.rows[0]?.data;
  if (!run) throw campaignEditError("The campaign could not be found.", 404);
  const update = setMarkdownTableColumnValues(run.output, columnName, rowValues, tableHint);
  if (!update.tableFound) throw campaignEditError("No editable People table was found in the visible record.", 400);
  if (!update.changed) return { run, revision: 0, columnName, rowsUpdated: update.rowCount, tableFound: true };
  const mergedSources = [...(Array.isArray(run.sources) ? run.sources : []), ...(Array.isArray(sources) ? sources : [])]
    .filter((source, index, all) => source?.url && all.findIndex((candidate) => candidate?.url === source.url) === index)
    .slice(0, 100);
  const updated = { ...run, output: update.text, sources: mergedSources };
  const revision = await persistCampaignRun(userId, projectId, runId, updated, env);
  return { run: updated, revision, columnName, rowsUpdated: update.rowCount, tableFound: true };
}

export async function addCampaignTableColumn(userId, projectId, runId, columnName, defaultValue = "Unknown", tableHint = "", env = process.env) {
  if (!runId) throw campaignEditError("There is no active campaign table to edit.", 400);
  const result = await getPool(env).query(
    "SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1",
    [userId, projectId, runId],
  );
  const run = result.rows[0]?.data;
  if (!run) throw campaignEditError("The campaign could not be found.", 404);
  const update = appendMarkdownTableColumn(run.output, columnName, defaultValue, tableHint);
  if (!update.changed) return { run, revision: 0, columnName: String(columnName || "").trim(), rowsUpdated: update.rowCount, alreadyPresent: update.alreadyPresent, tableFound: update.alreadyPresent };
  const updated = { ...run, output: update.text };
  const revision = await persistCampaignRun(userId, projectId, runId, updated, env);
  return { run: updated, revision, columnName: String(columnName || "").trim(), rowsUpdated: update.rowCount, alreadyPresent: false, tableFound: true };
}

function isMarkdownTableLine(line) {
  const value = String(line || "").trim();
  return value.startsWith("|") && value.endsWith("|") && value.slice(1, -1).includes("|");
}

function isMarkdownSeparatorLine(line) {
  const cells = markdownCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function markdownCells(line) {
  return String(line || "").trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function appendMarkdownCell(line, value) {
  const text = String(line || "").trimEnd();
  return text.endsWith("|") ? `${text.slice(0, -1).trimEnd()} | ${value} |` : `${text} | ${value}`;
}

function findMarkdownTable(lines, hint = "") {
  const tables = [];
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!isMarkdownTableLine(lines[index]) || !isMarkdownSeparatorLine(lines[index + 1])) continue;
    let end = index + 2;
    while (end < lines.length && isMarkdownTableLine(lines[end])) end += 1;
    const context = lines.slice(Math.max(0, index - 8), end).join(" ").toLowerCase();
    tables.push({ start: index, end, context });
    index = end - 1;
  }
  if (!tables.length) return null;
  return hint ? tables.find((candidate) => candidate.context.includes(hint)) || tables[0] : tables[0];
}

function sanitizeMarkdownCell(value) {
  return String(value || "Not found").replace(/[|\r\n]+/g, " ").trim().slice(0, 2_000) || "Not found";
}

export async function updateCampaignLink(userId, projectId, runId, targetUrl, env = process.env) {
  if (!runId) return null;
  const result = await getPool(env).query(
    "SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1",
    [userId, projectId, runId],
  );
  const run = result.rows[0]?.data;
  if (!run) return null;

  const outputUpdate = replaceCampaignLinks(run.output, targetUrl);
  let itemReplacements = 0;
  const campaignPlan = run.campaignPlan?.items?.length ? {
    ...run.campaignPlan,
    items: run.campaignPlan.items.map((item) => {
      const textUpdate = replaceCampaignLinks(item?.text, targetUrl);
      itemReplacements += textUpdate.replaced;
      return { ...item, text: textUpdate.text };
    }),
  } : run.campaignPlan;
  const replaced = outputUpdate.replaced + itemReplacements;
  if (!replaced) return { run, targetUrl: normalizeTarget(targetUrl), replaced: 0 };
  const updated = { ...run, output: outputUpdate.text, campaignPlan };
  const revision = await persistCampaignRun(userId, projectId, runId, updated, env);
  return { run: updated, targetUrl: normalizeTarget(targetUrl), replaced, revision };
}

export async function updateCampaignPlanItem(userId, projectId, runId, itemIndex, changes = {}, env = process.env) {
  const index = Number(itemIndex);
  if (!runId || !Number.isInteger(index) || index < 0) throw campaignEditError("Choose a campaign item to edit.", 400);
  const database = getPool(env);
  const result = await database.query(
    "SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1",
    [userId, projectId, runId],
  );
  const run = result.rows[0]?.data;
  const items = Array.isArray(run?.campaignPlan?.items) ? run.campaignPlan.items : [];
  if (!run || !items[index]) throw campaignEditError("The campaign item is no longer available.", 404);
  const original = items[index];
  const next = { ...original };
  if (Object.prototype.hasOwnProperty.call(changes, "subject")) next.subject = String(changes.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  if (Object.prototype.hasOwnProperty.call(changes, "text")) next.text = String(changes.text || "").trim().slice(0, 8_000);
  if (Object.prototype.hasOwnProperty.call(changes, "scheduledAt")) {
    const scheduledAt = new Date(String(changes.scheduledAt || ""));
    if (!Number.isFinite(scheduledAt.getTime())) throw campaignEditError("Choose a valid publication date.", 400);
    next.scheduledAt = scheduledAt.toISOString();
  }
  if (!next.text && !next.subject) throw campaignEditError("The post needs copy before it can be saved.", 400);
  if (JSON.stringify(next) === JSON.stringify(original)) return { run, revision: 0, job: null };

  const jobsResult = await database.query(
    "SELECT * FROM market_agent_delivery_jobs WHERE user_id = $1 AND project_id = $2 AND run_id = $3 ORDER BY created_at ASC",
    [userId, projectId, runId],
  ).catch(() => ({ rows: [] }));
  const job = jobsResult.rows.find((row) => row.channel === original.channel && (row.payload?.text === original.text || (original.subject && row.payload?.subject === original.subject))) || jobsResult.rows[index];
  if (job && ["running", "submitted", "complete"].includes(job.status)) throw campaignEditError("This post has already been sent to the platform and cannot be changed.", 409);

  let output = String(run.output || "");
  if (original.subject) output = output.replace(String(original.subject), next.subject || String(original.subject));
  if (original.text) output = output.replace(String(original.text), next.text || String(original.text));
  const updated = {
    ...run,
    status: run.status === "Approved" ? "Draft" : run.status,
    output,
    campaignPlan: { ...run.campaignPlan, items: items.map((item, itemPosition) => itemPosition === index ? next : item) },
  };
  const revision = await persistCampaignRun(userId, projectId, runId, updated, env);
  let updatedJob = null;
  if (job) {
    const payload = { ...(job.payload || {}), subject: next.subject, text: next.text, scheduledAt: next.scheduledAt };
    const savedJob = await database.query(
      `UPDATE market_agent_delivery_jobs
          SET payload = $3::jsonb,
              status = CASE WHEN status = 'scheduled' THEN 'awaiting_approval' ELSE status END,
              approved_at = CASE WHEN status = 'scheduled' THEN NULL ELSE approved_at END,
              next_attempt_at = CASE WHEN status = 'scheduled' THEN NULL ELSE next_attempt_at END,
              error = '', updated_at = NOW()
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [job.id, userId, JSON.stringify(payload)],
    );
    updatedJob = savedJob.rows[0] || null;
  }
  return { run: updated, revision, job: updatedJob };
}

export async function updateCampaignExperiment(userId, projectId, runId, field, rawValue, env = process.env) {
  const key = String(field || "").replace(/^experiment\./, "");
  const allowed = ["hypothesis", "audienceSegment", "variant", "businessOutcome", "minimumEvidence", "stopRule", "reviseRule", "continueRule", "cohortSize", "whyAudience", "whyIdea", "whyNow", "evidenceRationale", "learningGoal"];
  if (!runId || !allowed.includes(key)) throw campaignEditError("Choose an editable experiment field.", 400);
  const database = getPool(env);
  const [runResult, jobsResult] = await Promise.all([
    database.query("SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1", [userId, projectId, runId]),
    database.query("SELECT id, status FROM market_agent_delivery_jobs WHERE user_id = $1 AND project_id = $2 AND run_id = $3", [userId, projectId, runId]).catch(() => ({ rows: [] })),
  ]);
  const run = runResult.rows[0]?.data;
  if (!run) throw campaignEditError("The campaign could not be found.", 404);
  if (jobsResult.rows.some((job) => ["running", "submitted", "complete"].includes(job.status))) throw campaignEditError("This experiment has already started. Preserve its evidence and create a revised experiment instead.", 409);
  const value = key === "cohortSize" ? Math.round(Number(rawValue)) : String(rawValue || "").trim().slice(0, 4_000);
  if (key === "cohortSize" && (!Number.isFinite(value) || value < 20 || value > 30)) throw campaignEditError("The initial experiment cohort must contain 20–30 prospects.", 400);
  if (key !== "cohortSize" && !value) throw campaignEditError("The experiment field cannot be empty.", 400);
  const updated = {
    ...run,
    status: run.status === "Approved" ? "Draft" : run.status,
    experimentPlan: { ...(run.experimentPlan || {}), [key]: value },
    learningConclusion: null,
  };
  const revision = await persistCampaignRun(userId, projectId, runId, updated, env);
  await database.query(
    `UPDATE market_agent_delivery_jobs
        SET status = CASE WHEN status = 'scheduled' THEN 'awaiting_approval' ELSE status END,
            approved_at = CASE WHEN status = 'scheduled' THEN NULL ELSE approved_at END,
            next_attempt_at = CASE WHEN status = 'scheduled' THEN NULL ELSE next_attempt_at END,
            error = CASE WHEN status = 'scheduled' THEN 'Experiment changed; approve the revised campaign.' ELSE error END,
            updated_at = NOW()
      WHERE user_id = $1 AND project_id = $2 AND run_id = $3 AND status IN ('scheduled','awaiting_approval')`,
    [userId, projectId, runId],
  ).catch(() => undefined);
  return { run: updated, revision, field: key };
}

async function persistCampaignRun(userId, projectId, runId, updated, env) {
  const database = getPool(env);
  await database.query(
    "UPDATE market_agent_runs SET data = $4::jsonb WHERE user_id = $1 AND project_id = $2 AND id = $3",
    [userId, projectId, runId, JSON.stringify(updated)],
  );
  const stateResult = await database.query(
    `UPDATE market_agent_states SET state = jsonb_set(
       state, '{runs}',
       COALESCE((SELECT jsonb_agg(CASE WHEN item->>'id' = $2 THEN $3::jsonb ELSE item END)
         FROM jsonb_array_elements(COALESCE(state->'runs','[]'::jsonb)) AS item), '[]'::jsonb), true),
       revision = revision + 1, updated_at = NOW()
     WHERE user_id = $1 RETURNING revision`,
    [userId, runId, JSON.stringify(updated)],
  );
  return Number(stateResult.rows[0]?.revision || 0);
}

function normalizeTarget(value) {
  const raw = String(value || "").trim();
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString(); }
  catch { return raw; }
}

function campaignEditError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
