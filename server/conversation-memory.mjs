import { getPool } from "./db.mjs";

let memoryTablesReady = false;

export async function getProjectConversationMemory(userId, projectId, query = "", timeZone = "UTC", env = process.env) {
  await ensureConversationMemoryTables(env);
  const zone = safeTimeZone(timeZone);
  await rememberProjectTimeZone(userId, projectId, zone, env);
  const [memory, archives, relevant] = await Promise.all([
    getPool(env).query(
      "SELECT pinned_notes, timezone FROM market_agent_project_memory WHERE user_id = $1 AND project_id = $2 LIMIT 1",
      [userId, projectId],
    ),
    getPool(env).query(
      `SELECT local_day, summary, message_count FROM market_agent_conversation_archives
       WHERE user_id = $1 AND project_id = $2 ORDER BY local_day DESC LIMIT 14`,
      [userId, projectId],
    ),
    relevantArchivedMessages(userId, projectId, query, zone, env),
  ]);
  const pinned = Array.isArray(memory.rows[0]?.pinned_notes) ? memory.rows[0].pinned_notes.map(String).filter(Boolean).slice(-50) : [];
  const daily = archives.rows.map((row) => formatDailyArchive(row)).filter(Boolean);
  const sections = [];
  if (pinned.length) sections.push(`PINNED PROJECT NOTES\n${pinned.map((note) => `- ${note}`).join("\n")}`);
  if (daily.length) sections.push(`RECENT DAILY ARCHIVES\n${daily.join("\n")}`);
  if (relevant.length) sections.push(`RELEVANT EARLIER CONVERSATION\n${relevant.map((item) => `- ${item.role === "assistant" ? "Agent" : "User"}: ${compactLine(item.content, 900)}`).join("\n")}`);
  return sections.join("\n\n").slice(0, 18_000);
}

export async function pinProjectConversationNote(userId, projectId, note, timeZone = "UTC", env = process.env) {
  await ensureConversationMemoryTables(env);
  const text = String(note || "").replace(/\s+/g, " ").trim().slice(0, 4_000);
  if (!text) throw memoryError("Choose a message or note to pin.", 400);
  const zone = safeTimeZone(timeZone);
  const current = await getPool(env).query(
    "SELECT pinned_notes FROM market_agent_project_memory WHERE user_id = $1 AND project_id = $2 LIMIT 1",
    [userId, projectId],
  );
  const notes = Array.isArray(current.rows[0]?.pinned_notes) ? current.rows[0].pinned_notes.map(String).filter(Boolean) : [];
  const next = [...notes.filter((item) => item !== text), text].slice(-100);
  await getPool(env).query(
    `INSERT INTO market_agent_project_memory (user_id,project_id,timezone,pinned_notes,updated_at)
     VALUES ($1,$2,$3,$4::jsonb,NOW())
     ON CONFLICT (user_id,project_id) DO UPDATE SET timezone=EXCLUDED.timezone,pinned_notes=EXCLUDED.pinned_notes,updated_at=NOW()`,
    [userId, projectId, zone, JSON.stringify(next)],
  );
  return { pinned: true, note: text, count: next.length };
}

export async function archiveProjectConversationDays(userId, projectId, timeZone = "UTC", env = process.env) {
  await ensureConversationMemoryTables(env);
  const zone = safeTimeZone(timeZone);
  const result = await getPool(env).query(
    `SELECT (created_at AT TIME ZONE $3)::date AS local_day,
            jsonb_agg(data ORDER BY created_at ASC) AS messages,
            COUNT(*)::int AS message_count
     FROM market_agent_project_messages
     WHERE user_id = $1 AND project_id = $2
       AND (created_at AT TIME ZONE $3)::date < (NOW() AT TIME ZONE $3)::date
     GROUP BY (created_at AT TIME ZONE $3)::date
     ORDER BY local_day DESC LIMIT 31`,
    [userId, projectId, zone],
  );
  let archived = 0;
  for (const row of result.rows) {
    const summary = summarizeDay(row.messages);
    const saved = await getPool(env).query(
      `INSERT INTO market_agent_conversation_archives
        (user_id,project_id,local_day,summary,message_count,archived_at,updated_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,NOW(),NOW())
       ON CONFLICT (user_id,project_id,local_day) DO UPDATE SET
         summary=EXCLUDED.summary,message_count=EXCLUDED.message_count,updated_at=NOW()
       WHERE market_agent_conversation_archives.message_count IS DISTINCT FROM EXCLUDED.message_count
       RETURNING local_day`,
      [userId, projectId, row.local_day, JSON.stringify(summary), Number(row.message_count || 0)],
    );
    archived += saved.rowCount || 0;
  }
  return { archived };
}

export async function archiveCompletedConversationDays(env = process.env, limit = 50) {
  await ensureConversationMemoryTables(env);
  const projects = await getPool(env).query(
    `SELECT user_id,project_id,timezone FROM market_agent_project_memory
     ORDER BY updated_at ASC LIMIT $1`,
    [Math.max(1, Math.min(200, Number(limit) || 50))],
  );
  const results = [];
  for (const row of projects.rows) {
    const result = await archiveProjectConversationDays(row.user_id, row.project_id, row.timezone, env).catch((error) => ({ error: String(error?.message || "Archive failed") }));
    results.push({ userId: row.user_id, projectId: row.project_id, ...result });
  }
  return results;
}

async function relevantArchivedMessages(userId, projectId, query, timeZone, env) {
  const search = String(query || "").trim().slice(0, 2_000);
  if (search.length < 3) return [];
  const terms = [...new Set((search.toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter((term) => !memoryStopWords.has(term)).slice(0, 16))];
  if (!terms.length) return [];
  const tsQuery = terms.map((term) => `${term}:*`).join(" | ");
  try {
    const result = await getPool(env).query(
      `SELECT data,created_at,
              ts_rank(to_tsvector('simple',COALESCE(data->>'content','')),to_tsquery('simple',$4)) AS rank
       FROM market_agent_project_messages
       WHERE user_id=$1 AND project_id=$2
         AND (created_at AT TIME ZONE $3)::date < (NOW() AT TIME ZONE $3)::date
         AND to_tsvector('simple',COALESCE(data->>'content','')) @@ to_tsquery('simple',$4)
       ORDER BY rank DESC,created_at DESC LIMIT 10`,
      [userId, projectId, timeZone, tsQuery],
    );
    return result.rows.map((row) => ({ role: row.data?.role, content: row.data?.content, createdAt: row.created_at })).filter((item) => item.content);
  } catch {
    return [];
  }
}

const memoryStopWords = new Set(["the", "and", "for", "with", "this", "that", "from", "have", "has", "was", "were", "what", "when", "where", "which", "should", "could", "would", "please", "agent", "assistant", "change", "update", "make", "about", "into", "your", "you", "not", "but", "its", "our"]);

async function rememberProjectTimeZone(userId, projectId, timeZone, env) {
  await getPool(env).query(
    `INSERT INTO market_agent_project_memory (user_id,project_id,timezone,pinned_notes,updated_at)
     VALUES ($1,$2,$3,'[]'::jsonb,NOW())
     ON CONFLICT (user_id,project_id) DO UPDATE SET timezone=EXCLUDED.timezone,updated_at=NOW()`,
    [userId, projectId, timeZone],
  );
}

function summarizeDay(messages) {
  const values = Array.isArray(messages) ? messages : [];
  const userNotes = values.filter((item) => item?.role === "user").map((item) => compactLine(item?.content, 700)).filter(Boolean);
  const agentResults = values.filter((item) => item?.role === "assistant" && /\b(done|updated|saved|created|connected|prepared|fixed|deployed|scheduled|published|sent|removed|changed)\b/i.test(String(item?.content || ""))).map((item) => compactLine(item?.content, 700)).filter(Boolean);
  return {
    userNotes: unique(userNotes).slice(-16),
    agentResults: unique(agentResults).slice(-10),
  };
}

function formatDailyArchive(row) {
  const summary = row?.summary && typeof row.summary === "object" ? row.summary : {};
  const userNotes = Array.isArray(summary.userNotes) ? summary.userNotes : [];
  const agentResults = Array.isArray(summary.agentResults) ? summary.agentResults : [];
  const details = [...userNotes.map((item) => `user: ${item}`), ...agentResults.map((item) => `result: ${item}`)].slice(0, 8);
  return details.length ? `- ${String(row.local_day).slice(0, 10)} (${Number(row.message_count || 0)} messages): ${details.join(" | ")}` : "";
}

function compactLine(value, limit) {
  return String(value || "").replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function unique(values) {
  return [...new Set(values)];
}

function safeTimeZone(value) {
  const zone = String(value || "UTC").trim().slice(0, 100);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return "UTC";
  }
}

async function ensureConversationMemoryTables(env) {
  if (memoryTablesReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_project_memory (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC',
      pinned_notes JSONB NOT NULL DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id,project_id)
    );
    CREATE TABLE IF NOT EXISTS market_agent_conversation_archives (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL, local_day DATE NOT NULL,
      summary JSONB NOT NULL DEFAULT '{}'::jsonb, message_count INTEGER NOT NULL DEFAULT 0,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id,project_id,local_day)
    );
    CREATE INDEX IF NOT EXISTS market_agent_conversation_archives_project_day_idx
      ON market_agent_conversation_archives (user_id,project_id,local_day DESC);
  `);
  memoryTablesReady = true;
}

function memoryError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
