import { randomUUID } from "node:crypto";
import { getGmailMonitoringAccess, gmailMonitoringApprovalStatus } from "./connections.mjs";
import { getPool } from "./db.mjs";

const GMAIL_MONITORING_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
const PERMANENT_SUPPRESSIONS = new Set(["suppressed", "unsubscribed", "bounced", "replied"]);

let monitorTablesReady = false;

export async function runGmailMonitoringCycle(env = process.env, limit = 10) {
  if (!env.DATABASE_URL || gmailMonitoringApprovalStatus(env) !== "approved") return [];
  await ensureGmailMonitorTables(env);
  const result = await getPool(env).query(
    `SELECT user_id, project_id
       FROM market_agent_connections
      WHERE provider = 'google-gmail'
        AND status = 'connected'
        AND $1 = ANY(scopes)
      ORDER BY updated_at ASC
      LIMIT $2`,
    [GMAIL_MONITORING_SCOPE, Math.max(1, Math.min(25, Number(limit) || 10))],
  );
  const monitored = [];
  for (const row of result.rows) {
    try {
      monitored.push(await monitorMailbox(row.user_id, row.project_id, env));
    } catch (error) {
      const message = String(error?.message || "Gmail monitoring failed.").slice(0, 800);
      await saveMonitorState(row.user_id, row.project_id, { lastError: message }, env).catch(() => {});
      monitored.push({ userId: row.user_id, projectId: row.project_id, status: "failed", events: 0, error: message });
    }
  }
  return monitored;
}

export async function listGmailResponseEvents(userId, projectId, runId = "", env = process.env) {
  if (!env.DATABASE_URL) return [];
  await ensureGmailMonitorTables(env);
  const values = [userId, projectId];
  const runFilter = runId ? " AND jobs.run_id = $3" : "";
  if (runId) values.push(runId);
  const result = await getPool(env).query(
    `SELECT events.email, events.kind, events.subject, events.occurred_at, suppressions.hold_until
       FROM market_agent_email_events events
       JOIN market_agent_delivery_jobs jobs ON jobs.id = events.job_id
       LEFT JOIN market_agent_email_suppressions suppressions
         ON suppressions.user_id = events.user_id
        AND suppressions.project_id = events.project_id
        AND suppressions.email = events.email
      WHERE events.user_id = $1 AND events.project_id = $2${runFilter}
      ORDER BY events.occurred_at DESC
      LIMIT 50`,
    values,
  );
  return result.rows.map((row) => ({
    email: row.email,
    kind: row.kind,
    subject: row.subject || "",
    occurredAt: new Date(row.occurred_at).toISOString(),
    holdUntil: row.hold_until ? new Date(row.hold_until).toISOString() : null,
  }));
}

export function classifyGmailResponse(headers = {}) {
  const normalized = normalizeHeaders(headers);
  const subject = String(normalized.subject || "").trim().slice(0, 500);
  const failedRecipient = extractEmail(normalized["x-failed-recipients"] || "");
  const from = extractEmail(normalized.from || normalized["reply-to"] || "");
  const fromValue = String(normalized.from || "").toLowerCase();
  const bounce = Boolean(failedRecipient)
    || /mailer-daemon|postmaster|mail delivery subsystem/.test(fromValue)
    || /delivery status notification|undeliverable|delivery failure|returned mail|failure notice|mail delivery failed/i.test(subject);
  if (bounce) return { kind: "bounce", email: failedRecipient || from, subject };
  const autoSubmitted = String(normalized["auto-submitted"] || "").toLowerCase();
  const automatic = (autoSubmitted && autoSubmitted !== "no")
    || Boolean(normalized["x-autoreply"] || normalized["x-autorespond"] || normalized["x-auto-response-suppress"])
    || /automatic reply|auto(?:matic)? response|out of office|away from (?:the )?office|vacation reply/i.test(subject);
  if (automatic) return { kind: "auto_reply", email: from, subject };
  return { kind: "human_reply", email: from, subject };
}

export async function ensureGmailMonitorTables(env = process.env) {
  if (monitorTablesReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_email_suppressions (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      email TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'unsubscribed',
      status TEXT NOT NULL DEFAULT 'suppressed',
      hold_until TIMESTAMPTZ,
      source_message_id TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, project_id, email)
    );
    ALTER TABLE market_agent_email_suppressions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'suppressed';
    ALTER TABLE market_agent_email_suppressions ADD COLUMN IF NOT EXISTS hold_until TIMESTAMPTZ;
    ALTER TABLE market_agent_email_suppressions ADD COLUMN IF NOT EXISTS source_message_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_email_suppressions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    CREATE INDEX IF NOT EXISTS market_agent_email_suppressions_active_idx ON market_agent_email_suppressions (user_id, project_id, email, hold_until);
    CREATE TABLE IF NOT EXISTS market_agent_gmail_monitor_state (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL, account_email TEXT NOT NULL DEFAULT '',
      history_id TEXT NOT NULL DEFAULT '', last_checked_at TIMESTAMPTZ, last_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS market_agent_email_events (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
      email TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('bounce','auto_reply','human_reply')),
      provider_message_id TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', occurred_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, project_id, provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS market_agent_email_events_project_idx ON market_agent_email_events (user_id, project_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS market_agent_email_events_job_idx ON market_agent_email_events (job_id, occurred_at DESC);
  `);
  monitorTablesReady = true;
}

async function monitorMailbox(userId, projectId, env) {
  const access = await getGmailMonitoringAccess(userId, projectId, env);
  if (!access) return { userId, projectId, status: "permission_missing", events: 0 };
  const stateResult = await getPool(env).query(
    "SELECT history_id FROM market_agent_gmail_monitor_state WHERE user_id = $1 AND project_id = $2 LIMIT 1",
    [userId, projectId],
  );
  let historyId = String(stateResult.rows[0]?.history_id || "");
  if (!historyId) {
    historyId = await currentHistoryId(access.accessToken);
    await saveMonitorState(userId, projectId, { accountEmail: access.accountEmail, historyId, lastError: "" }, env);
    return { userId, projectId, status: "baseline_created", events: 0 };
  }

  let pageToken = "";
  let latestHistoryId = historyId;
  const messageIds = new Set();
  try {
    for (let page = 0; page < 3; page += 1) {
      const query = new URLSearchParams({ startHistoryId: historyId, historyTypes: "messageAdded", labelId: "INBOX", maxResults: "100" });
      if (pageToken) query.set("pageToken", pageToken);
      const response = await fetchGmailJson(`https://gmail.googleapis.com/gmail/v1/users/me/history?${query}`, access.accessToken);
      latestHistoryId = String(response.historyId || latestHistoryId);
      for (const entry of response.history || []) {
        for (const added of entry.messagesAdded || []) {
          if (added?.message?.id) messageIds.add(String(added.message.id));
          if (messageIds.size >= 50) break;
        }
        if (messageIds.size >= 50) break;
      }
      pageToken = String(response.nextPageToken || "");
      if (!pageToken || messageIds.size >= 50) break;
    }
  } catch (error) {
    if (Number(error?.statusCode) !== 404) throw error;
    latestHistoryId = await currentHistoryId(access.accessToken);
    await saveMonitorState(userId, projectId, { accountEmail: access.accountEmail, historyId: latestHistoryId, lastError: "" }, env);
    return { userId, projectId, status: "baseline_reset", events: 0 };
  }

  let events = 0;
  for (const messageId of messageIds) {
    const query = new URLSearchParams({ format: "metadata" });
    for (const header of ["From", "Reply-To", "Subject", "Auto-Submitted", "X-Autoreply", "X-Autorespond", "X-Auto-Response-Suppress", "X-Failed-Recipients"]) query.append("metadataHeaders", header);
    const message = await fetchGmailJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?${query}`, access.accessToken);
    const headers = Object.fromEntries((message.payload?.headers || []).map((header) => [String(header.name || ""), String(header.value || "")]));
    const response = classifyGmailResponse(headers);
    if (!response.email || response.email === access.accountEmail) continue;
    const occurredAt = new Date(Number(message.internalDate || Date.now()));
    const job = await recentInvitationJob(userId, projectId, response.email, occurredAt, env);
    if (!job) continue;
    const inserted = await getPool(env).query(
      `INSERT INTO market_agent_email_events
        (id,user_id,project_id,job_id,email,kind,provider_message_id,subject,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (user_id,project_id,provider_message_id) DO NOTHING`,
      [randomUUID(), userId, projectId, job.id, response.email, response.kind, messageId, response.subject, occurredAt.toISOString()],
    );
    if (!inserted.rowCount) continue;
    await applyResponseAction(userId, projectId, response, messageId, env);
    events += 1;
  }
  await saveMonitorState(userId, projectId, { accountEmail: access.accountEmail, historyId: latestHistoryId, lastError: "" }, env);
  return { userId, projectId, status: "checked", events };
}

async function recentInvitationJob(userId, projectId, email, occurredAt, env) {
  const result = await getPool(env).query(
    `SELECT id
       FROM market_agent_delivery_jobs
      WHERE user_id = $1 AND project_id = $2 AND channel = 'gmail'
        AND lower(payload->>'recipient') = $3
        AND status IN ('complete','submitted')
        AND completed_at >= $4::timestamptz - INTERVAL '90 days'
        AND completed_at <= $4::timestamptz + INTERVAL '10 minutes'
      ORDER BY completed_at DESC
      LIMIT 1`,
    [userId, projectId, email, occurredAt.toISOString()],
  );
  return result.rows[0] || null;
}

async function applyResponseAction(userId, projectId, response, messageId, env) {
  const current = await getPool(env).query(
    "SELECT status FROM market_agent_email_suppressions WHERE user_id = $1 AND project_id = $2 AND email = $3 LIMIT 1",
    [userId, projectId, response.email],
  );
  const existingStatus = String(current.rows[0]?.status || "");
  let status = response.kind === "bounce" ? "bounced" : response.kind === "auto_reply" ? "paused" : "replied";
  const reason = response.kind === "bounce" ? "delivery failure" : response.kind === "auto_reply" ? "automatic reply" : "recipient replied";
  const shouldPreserve = existingStatus && PERMANENT_SUPPRESSIONS.has(existingStatus)
    && !(existingStatus === "replied" && response.kind === "bounce");
  if (!shouldPreserve) {
    await getPool(env).query(
      `INSERT INTO market_agent_email_suppressions
        (user_id,project_id,email,reason,status,hold_until,source_message_id,updated_at)
       VALUES ($1,$2,$3,$4,$5,CASE WHEN $5 = 'paused' THEN NOW() + INTERVAL '7 days' ELSE NULL END,$6,NOW())
       ON CONFLICT (user_id,project_id,email) DO UPDATE SET
         reason = EXCLUDED.reason, status = EXCLUDED.status, hold_until = EXCLUDED.hold_until,
         source_message_id = EXCLUDED.source_message_id, updated_at = NOW()`,
      [userId, projectId, response.email, reason, status, messageId],
    );
  } else {
    status = existingStatus;
  }
  await getPool(env).query(
    `UPDATE market_agent_delivery_jobs
        SET status = 'cancelled', error = $4, next_attempt_at = NULL, updated_at = NOW()
      WHERE user_id = $1 AND project_id = $2 AND channel = 'gmail'
        AND lower(payload->>'recipient') = $3
        AND status IN ('awaiting_approval','scheduled')`,
    [userId, projectId, response.email, status === "paused" ? "Paused after an automatic reply." : status === "bounced" ? "Cancelled after a delivery failure." : "Cancelled because the recipient replied."],
  );
}

async function currentHistoryId(accessToken) {
  const profile = await fetchGmailJson("https://gmail.googleapis.com/gmail/v1/users/me/profile", accessToken);
  if (!profile.historyId) throw new Error("Gmail did not provide a mailbox history marker.");
  return String(profile.historyId);
}

async function saveMonitorState(userId, projectId, changes, env) {
  await getPool(env).query(
    `INSERT INTO market_agent_gmail_monitor_state
      (user_id,project_id,account_email,history_id,last_checked_at,last_error,updated_at)
     VALUES ($1,$2,$3,$4,NOW(),$5,NOW())
     ON CONFLICT (user_id,project_id) DO UPDATE SET
       account_email = COALESCE(NULLIF(EXCLUDED.account_email,''),market_agent_gmail_monitor_state.account_email),
       history_id = COALESCE(NULLIF(EXCLUDED.history_id,''),market_agent_gmail_monitor_state.history_id),
       last_checked_at = NOW(), last_error = EXCLUDED.last_error, updated_at = NOW()`,
    [userId, projectId, String(changes.accountEmail || ""), String(changes.historyId || ""), String(changes.lastError || "")],
  );
}

async function fetchGmailJson(url, accessToken) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(String(data?.error?.message || `Gmail monitoring failed with status ${response.status}.`).slice(0, 800));
    error.statusCode = response.status;
    throw error;
  }
  return data;
}

function normalizeHeaders(headers) {
  if (Array.isArray(headers)) return Object.fromEntries(headers.map((header) => [String(header?.name || "").toLowerCase(), String(header?.value || "")]));
  return Object.fromEntries(Object.entries(headers || {}).map(([name, value]) => [String(name).toLowerCase(), String(value || "")]));
}

function extractEmail(value) {
  const match = String(value || "").toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0] : "";
}
