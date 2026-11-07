import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { generateDeliveryPlan } from "./agent.mjs";
import { getConnectionStatus } from "./connections.mjs";
import { loadStateForUser, getPool } from "./db.mjs";
import { sendGmailMessage } from "./connections.mjs";
import { publishSocialPost } from "./social-connections.mjs";
import { getSocialPublishingOptions } from "./social-connections.mjs";
import { getSocialPostStatus } from "./social-connections.mjs";

let deliveryTableReady = false;

export async function listDeliveryJobs(userId, projectId, runId = "", env = process.env) {
  await ensureDeliveryTable(env);
  await refreshSubmittedTikTokJobs(userId, projectId, runId, env);
  const values = [userId, projectId];
  const runFilter = runId ? " AND run_id = $3" : "";
  if (runId) values.push(runId);
  const result = await getPool(env).query(
    `SELECT * FROM market_agent_delivery_jobs
      WHERE user_id = $1 AND project_id = $2${runFilter}
      ORDER BY created_at ASC LIMIT 100`,
    values,
  );
  return { jobs: result.rows.map(serializeDeliveryJob) };
}

async function refreshSubmittedTikTokJobs(userId, projectId, runId, env) {
  const values = [userId, projectId];
  const runFilter = runId ? " AND run_id = $3" : "";
  if (runId) values.push(runId);
  const result = await getPool(env).query(
    `SELECT id, project_id, external_id FROM market_agent_delivery_jobs
      WHERE user_id = $1 AND project_id = $2${runFilter}
        AND channel = 'tiktok' AND status = 'submitted'
        AND updated_at < NOW() - INTERVAL '5 seconds'
      ORDER BY updated_at ASC LIMIT 5`,
    values,
  );
  for (const row of result.rows) {
    try {
      const providerResult = await getSocialPostStatus(userId, row.project_id, "tiktok", row.external_id, env);
      if (providerResult.status === "submitted") {
        await getPool(env).query("UPDATE market_agent_delivery_jobs SET result = $3::jsonb, updated_at = NOW() WHERE id = $1 AND user_id = $2", [row.id, userId, JSON.stringify(providerResult)]);
      } else if (providerResult.status === "complete") {
        await getPool(env).query("UPDATE market_agent_delivery_jobs SET status = 'complete', result = $3::jsonb, completed_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2", [row.id, userId, JSON.stringify(providerResult)]);
      } else {
        await getPool(env).query("UPDATE market_agent_delivery_jobs SET status = 'failed', result = $3::jsonb, error = $4, updated_at = NOW() WHERE id = $1 AND user_id = $2", [row.id, userId, JSON.stringify(providerResult), providerResult.failReason ? `TikTok could not publish this item: ${providerResult.failReason}` : "TikTok could not publish this item."]);
      }
    } catch {
      // Keep the job submitted; a later user refresh can retry the provider status check.
    }
  }
}

export async function prepareDeliveryJobs(userId, projectId, runId, userApiEnv, env = process.env) {
  await ensureDeliveryTable(env);
  const existing = await listDeliveryJobs(userId, projectId, runId, env);
  if (existing.jobs.length) return existing;
  const { state } = await loadStateForUser(userId, env);
  const run = state.runs.find((item) => item.id === runId && item.projectId === projectId);
  const workspace = state.projects.find((item) => item.id === projectId);
  if (!run || !workspace) throw deliveryError("The approved project work could not be found.", 404);
  if (run.status !== "Approved") throw deliveryError("Approve the saved work before preparing external actions.", 409);
  const connections = await getConnectionStatus(userId, projectId, env);
  const channels = operationalChannels(connections).filter((channel) => channelAllowedForAccess(channel, userApiEnv));
  if (!channels.length) throw deliveryError("Connect an operational email or social channel first.", 409);
  const plan = await generateDeliveryPlan({ run, workspace, channels }, userApiEnv);
  const safeItems = normalizeDeliveryItems(plan?.items, channels, workspace);
  for (const item of safeItems) {
    await getPool(env).query(
      `INSERT INTO market_agent_delivery_jobs
        (id, user_id, project_id, run_id, channel, payload, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'awaiting_approval',NOW(),NOW())`,
      [randomUUID(), userId, projectId, runId, item.channel, JSON.stringify(item)],
    );
  }
  return listDeliveryJobs(userId, projectId, runId, env);
}

export async function getDeliveryPublishingOptions(userId, id, env = process.env) {
  await ensureDeliveryTable(env);
  const result = await getPool(env).query(
    "SELECT id, project_id, channel, status FROM market_agent_delivery_jobs WHERE id = $1 AND user_id = $2 LIMIT 1",
    [id, userId],
  );
  const row = result.rows[0];
  if (!row) throw deliveryError("The delivery item was not found.", 404);
  if (row.channel !== "tiktok") throw deliveryError("This delivery item does not need additional publishing settings.", 400);
  if (row.status !== "awaiting_approval") throw deliveryError("This delivery item is no longer waiting for approval.", 409);
  return { id: row.id, ...(await getSocialPublishingOptions(userId, row.project_id, row.channel, env)) };
}

export async function executeDeliveryJob(userId, id, userApiEnv, approval = {}, env = process.env) {
  await ensureDeliveryTable(env);
  const pool = getPool(env);
  const client = await pool.connect();
  let row;
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM market_agent_delivery_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE", [id, userId]);
    row = result.rows[0];
    if (!row) throw deliveryError("The delivery item was not found.", 404);
    if (!channelAllowedForAccess(row.channel, userApiEnv)) {
      throw deliveryError("This delivery channel is not included in the current access level.", 403);
    }
    if (row.status !== "awaiting_approval") throw deliveryError("This delivery item is no longer waiting for approval.", 409);
    const payload = row.channel === "tiktok" ? prepareTikTokPayload(row.id, mergeTikTokApproval(row.payload, approval), env) : row.payload;
    const claimed = await client.query(
      "UPDATE market_agent_delivery_jobs SET status = 'running', payload = $3::jsonb, approved_at = NOW(), updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING *",
      [id, userId, JSON.stringify(payload || {})],
    );
    row = claimed.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  try {
    const payload = row.payload || {};
    const result = row.channel === "gmail"
      ? await sendGmailMessage(userId, row.project_id, { to: payload.recipient, subject: payload.subject, body: payload.text }, env)
      : await publishSocialPost(userId, row.project_id, row.channel, payload, env);
    const status = result.status === "processing" ? "submitted" : "complete";
    const updated = await getPool(env).query(
      `UPDATE market_agent_delivery_jobs
          SET status = $3, external_id = $4, result = $5::jsonb, error = '', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, status, String(result.externalId || ""), JSON.stringify(result)],
    );
    return { job: serializeDeliveryJob(updated.rows[0]) };
  } catch (error) {
    const updated = await getPool(env).query(
      `UPDATE market_agent_delivery_jobs SET status = 'failed', error = $3, updated_at = NOW()
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, safeError(error)],
    );
    return { job: serializeDeliveryJob(updated.rows[0]) };
  }
}

export async function readDeliveryMedia(token, env = process.env) {
  await ensureDeliveryTable(env);
  const parsed = verifyDeliveryMediaToken(token, env);
  const result = await getPool(env).query(
    `SELECT payload FROM market_agent_delivery_jobs
      WHERE id = $1 AND status IN ('running','submitted','complete') LIMIT 1`,
    [parsed.id],
  );
  const payload = result.rows[0]?.payload || {};
  const mediaUrl = validExternalMediaUrl(payload.sourceMediaUrl);
  if (!mediaUrl) throw deliveryError("This media link is no longer available.", 404);
  return { mediaUrl, mediaKind: payload.mediaKind === "video" ? "video" : "image" };
}

export async function cancelDeliveryJob(userId, id, env = process.env) {
  await ensureDeliveryTable(env);
  const result = await getPool(env).query(
    `UPDATE market_agent_delivery_jobs SET status = 'cancelled', updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status = 'awaiting_approval' RETURNING *`,
    [id, userId],
  );
  if (!result.rows[0]) throw deliveryError("Only an unapproved delivery item can be cancelled.", 409);
  return { job: serializeDeliveryJob(result.rows[0]) };
}

function operationalChannels(connections) {
  const channels = [];
  if (connections.gmail?.connected && connections.gmail.canSend) channels.push("gmail");
  for (const provider of ["linkedin", "instagram", "tiktok", "x"]) if (connections[provider]?.connected && connections[provider].canPublish) channels.push(provider);
  return channels;
}

function channelAllowedForAccess(channel, accessEnv) {
  const mode = String(accessEnv?.MARKET_AGENT_ACCESS_MODE || "expired");
  if (mode === "byok" || mode === "managed") return true;
  return mode === "trial" && channel === "linkedin";
}

function normalizeDeliveryItems(values, channels, workspace) {
  if (!Array.isArray(values)) return [];
  const allowedMedia = new Set((workspace.sourceMedia || []).map((item) => item?.url).filter((url) => /^https:\/\//i.test(String(url || ""))));
  const items = [];
  for (const value of values) {
    const channel = String(value?.channel || "");
    if (!channels.includes(channel)) continue;
    const text = String(value?.text || "").trim().slice(0, channel === "x" ? 280 : channel === "linkedin" ? 3000 : channel === "gmail" ? 100_000 : 2200);
    if (!text) continue;
    const requestedMediaKind = value?.mediaKind === "video" ? "video" : "image";
    const channelAcceptsMedia = channel === "instagram" || channel === "tiktok" || (channel === "linkedin" && requestedMediaKind === "image");
    const mediaUrl = channelAcceptsMedia && allowedMedia.has(value?.mediaUrl) ? String(value.mediaUrl) : "";
    if ((channel === "instagram" || channel === "tiktok") && !mediaUrl) continue;
    const recipient = channel === "gmail" ? validRecipientList(value?.recipient) : "";
    if (channel === "gmail" && !recipient) continue;
    const subject = channel === "gmail" ? String(value?.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300) : "";
    if (channel === "gmail" && !subject) continue;
    items.push({
      channel,
      recipient,
      subject,
      text,
      mediaUrl,
      mediaKind: mediaUrl ? requestedMediaKind : "",
      privacyLevel: channel === "tiktok" ? "SELF_ONLY" : "",
      aiGenerated: Boolean(value?.aiGenerated),
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      brandOrganicToggle: channel === "tiktok",
      brandContentToggle: false,
      rationale: String(value?.rationale || "Prepared from the approved run.").trim().slice(0, 1000),
    });
    if (items.length >= 12) break;
  }
  return items;
}

function mergeTikTokApproval(payload, approval) {
  const privacyLevel = String(approval?.privacyLevel || payload?.privacyLevel || "").trim();
  if (!/^(PUBLIC_TO_EVERYONE|MUTUAL_FOLLOW_FRIENDS|FOLLOWER_OF_CREATOR|SELF_ONLY)$/.test(privacyLevel)) {
    throw deliveryError("Choose an available TikTok visibility option before publishing.", 400);
  }
  return {
    ...(payload || {}),
    privacyLevel,
    disableComment: Boolean(approval?.disableComment),
    disableDuet: Boolean(approval?.disableDuet),
    disableStitch: Boolean(approval?.disableStitch),
    brandOrganicToggle: approval?.brandOrganicToggle !== false,
    brandContentToggle: Boolean(approval?.brandContentToggle),
  };
}

function prepareTikTokPayload(id, payload, env) {
  if (payload?.mediaKind !== "image") return payload;
  const sourceMediaUrl = validExternalMediaUrl(payload.mediaUrl);
  if (!sourceMediaUrl) throw deliveryError("The approved TikTok image is not a public HTTPS asset.", 400);
  const origin = String(env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!/^https:\/\//i.test(origin)) throw deliveryError("The public app address is not configured for TikTok photo delivery.", 503);
  const expiresAt = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
  const unsigned = `${expiresAt}.${id}`;
  const signature = createHmac("sha256", deliveryMediaSecret(env)).update(unsigned).digest("base64url");
  return { ...payload, sourceMediaUrl, mediaUrl: `${origin}/api/delivery-media?token=${encodeURIComponent(`${unsigned}.${signature}`)}` };
}

function verifyDeliveryMediaToken(value, env) {
  const [expiresValue, id, signature] = String(value || "").split(".");
  const expiresAt = Number(expiresValue);
  if (!expiresAt || expiresAt < Math.floor(Date.now() / 1000) || !id || !signature) throw deliveryError("This media link expired.", 410);
  const expected = createHmac("sha256", deliveryMediaSecret(env)).update(`${expiresValue}.${id}`).digest("base64url");
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length || !timingSafeEqual(receivedBuffer, expectedBuffer)) throw deliveryError("This media link is invalid.", 403);
  return { id, expiresAt };
}

function deliveryMediaSecret(env) {
  const secret = String(env.CONNECTION_ENCRYPTION_KEY || "");
  if (secret.length < 32) throw deliveryError("Secure media delivery is not configured.", 503);
  return secret;
}

function validExternalMediaUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return "";
    const match = host.match(/^172\.(\d{1,3})\./);
    if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function validRecipientList(value) {
  const result = [];
  for (const item of String(value || "").split(/[;,\n]+/)) {
    const email = item.trim().toLowerCase();
    if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) && !result.includes(email)) result.push(email);
    if (result.length >= 50) break;
  }
  return result.join(", ");
}

async function ensureDeliveryTable(env) {
  if (deliveryTableReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_delivery_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('gmail','linkedin','instagram','tiktok','x')),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('awaiting_approval','running','submitted','complete','failed','cancelled')),
      external_id TEXT NOT NULL DEFAULT '', result JSONB NOT NULL DEFAULT '{}'::jsonb, error TEXT NOT NULL DEFAULT '',
      approved_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS market_agent_delivery_jobs_user_project_run_idx ON market_agent_delivery_jobs (user_id, project_id, run_id, created_at DESC);
  `);
  deliveryTableReady = true;
}

function serializeDeliveryJob(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    channel: row.channel,
    payload: row.payload || {},
    status: row.status,
    externalId: row.external_id || "",
    result: row.result || {},
    error: row.error || "",
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function safeError(error) {
  return String(error?.message || "The external action failed.").slice(0, 1200);
}

function deliveryError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
