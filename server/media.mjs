import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import { get, put } from "@vercel/blob";
import { getPool } from "./db.mjs";

const IMAGE_ESTIMATE_CENTS = 8;
const VIDEO_ESTIMATE_CENTS = 110;
const DEFAULT_MONTHLY_CAP_CENTS = 2500;

export async function listMediaJobs(userId, projectId, env = process.env) {
  const safeProjectId = requiredText(projectId, "Choose a project first.", 200);
  const result = await getPool(env).query(
    `SELECT * FROM market_agent_media_jobs
     WHERE user_id = $1 AND project_id = $2
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId, safeProjectId],
  );

  const jobs = [];
  for (const row of result.rows) {
    if (row.status === "running" && row.external_id && row.kind === "video") {
      jobs.push(await syncVideoJob(row, env));
    } else {
      jobs.push(serializeJob(row, env));
    }
  }

  return {
    jobs,
    summary: await mediaBudgetSummary(userId, safeProjectId, env),
    configured: Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY),
  };
}

export async function prepareMediaJob(userId, payload, env = process.env) {
  const projectId = requiredText(payload?.projectId, "Choose a project first.", 200);
  const kind = payload?.kind === "video" ? "video" : payload?.kind === "image" ? "image" : "";
  if (!kind) throw httpError(400, "Choose image or video.");

  const workspace = payload?.workspace && typeof payload.workspace === "object" ? payload.workspace : {};
  const recentRuns = Array.isArray(payload?.recentRuns) ? payload.recentRuns.slice(0, 3) : [];
  const direction = String(payload?.direction || "").trim().slice(0, 1500);
  const prompt = buildMediaPrompt(kind, workspace, recentRuns, direction);
  const job = {
    id: randomUUID(),
    userId,
    projectId,
    kind,
    title: kind === "image" ? "Campaign-ready image" : "Short campaign video",
    prompt,
    aspectRatio: kind === "image" ? "4:5" : "9:16",
    resolution: kind === "image" ? "1K" : "720p",
    durationSeconds: kind === "video" ? 6 : null,
    estimatedCostCents: kind === "image" ? IMAGE_ESTIMATE_CENTS : VIDEO_ESTIMATE_CENTS,
  };

  const result = await getPool(env).query(
    `INSERT INTO market_agent_media_jobs
      (id, user_id, project_id, kind, title, prompt, aspect_ratio, resolution,
       duration_seconds, estimated_cost_cents)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [job.id, job.userId, job.projectId, job.kind, job.title, job.prompt, job.aspectRatio,
      job.resolution, job.durationSeconds, job.estimatedCostCents],
  );
  return { job: serializeJob(result.rows[0], env), summary: await mediaBudgetSummary(userId, projectId, env) };
}

export async function approveMediaJob(userId, payload, env = process.env) {
  if (!env.GOOGLE_GENERATIVE_AI_API_KEY) throw httpError(503, "Media creation is not configured yet.");
  const id = requiredText(payload?.id, "The media request is missing.", 100);
  const approvedBudgetCents = Number(payload?.approvedBudgetCents);
  const pool = getPool(env);
  const client = await pool.connect();
  let row;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `SELECT * FROM market_agent_media_jobs
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [id, userId],
    );
    row = result.rows[0];
    if (!row) throw httpError(404, "Media request not found.");
    if (row.status !== "awaiting_budget") throw httpError(409, "This media request is no longer waiting for approval.");
    if (!Number.isInteger(approvedBudgetCents) || approvedBudgetCents !== Number(row.estimated_cost_cents)) {
      throw httpError(400, "Approve the exact maximum shown for this request.");
    }

    const total = await client.query(
      `SELECT COALESCE(SUM(approved_budget_cents), 0)::int AS cents
       FROM market_agent_media_jobs
       WHERE user_id = $1 AND project_id = $2
         AND approved_at >= date_trunc('month', NOW())
         AND status <> 'cancelled'`,
      [userId, row.project_id],
    );
    const monthlyCapCents = mediaMonthlyCapCents(env);
    if (Number(total.rows[0]?.cents || 0) + approvedBudgetCents > monthlyCapCents) {
      throw httpError(409, `This would exceed the project's $${(monthlyCapCents / 100).toFixed(2)} monthly media ceiling.`);
    }

    const updated = await client.query(
      `UPDATE market_agent_media_jobs
       SET status = 'approved', approved_budget_cents = $3, approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId, approvedBudgetCents],
    );
    row = updated.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const job = await executeApprovedJob(row, env);
  return { job, summary: await mediaBudgetSummary(userId, row.project_id, env) };
}

export async function cancelMediaJob(userId, payload, env = process.env) {
  const id = requiredText(payload?.id, "The media request is missing.", 100);
  const result = await getPool(env).query(
    `UPDATE market_agent_media_jobs
     SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'awaiting_budget'
     RETURNING *`,
    [id, userId],
  );
  if (!result.rows[0]) throw httpError(409, "Only an unapproved media request can be cancelled.");
  return {
    job: serializeJob(result.rows[0], env),
    summary: await mediaBudgetSummary(userId, result.rows[0].project_id, env),
  };
}

async function executeApprovedJob(row, env) {
  const claimed = await getPool(env).query(
    `UPDATE market_agent_media_jobs
     SET status = 'running', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'approved'
       AND approved_budget_cents >= estimated_cost_cents
     RETURNING *`,
    [row.id, row.user_id],
  );
  const job = claimed.rows[0];
  if (!job) throw httpError(409, "This media request was not approved for its full maximum cost.");

  try {
    const response = job.kind === "image"
      ? await createImage(job, env)
      : await createVideo(job, env);
    if (["queued", "in_progress"].includes(response.status) && response.id) {
      const result = await getPool(env).query(
        `UPDATE market_agent_media_jobs
         SET external_id = $3, updated_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [job.id, job.user_id, response.id],
      );
      return serializeJob(result.rows[0], env);
    }
    return await finalizeMedia(job, response, env);
  } catch (error) {
    const message = safeProviderError(error);
    const result = await getPool(env).query(
      `UPDATE market_agent_media_jobs
       SET status = 'failed', error = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [job.id, job.user_id, message],
    );
    return serializeJob(result.rows[0], env);
  }
}

async function createImage(job, env) {
  return googleInteraction({
    model: "gemini-3.1-flash-image",
    input: [{ type: "text", text: job.prompt }],
    response_format: {
      type: "image",
      mime_type: "image/png",
      aspect_ratio: job.aspect_ratio,
      image_size: job.resolution,
    },
    store: false,
  }, env);
}

async function createVideo(job, env) {
  return googleInteraction({
    model: "gemini-omni-1.1-flash",
    input: `${job.prompt}\n\nCreate one continuous ${job.duration_seconds}-second vertical video with coherent native audio. End cleanly at exactly ${job.duration_seconds} seconds.`,
    response_format: {
      type: "video",
      aspect_ratio: job.aspect_ratio,
      resolution: job.resolution,
      delivery: "uri",
    },
    generation_config: { video_config: { task: "text_to_video" } },
    background: true,
    store: true,
  }, env);
}

async function googleInteraction(body, env) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method: "POST",
    headers: {
      "x-goog-api-key": env.GOOGLE_GENERATIVE_AI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(285_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw providerError(response.status, data);
  return data;
}

async function syncVideoJob(row, env) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(row.external_id)}`, {
      headers: { "x-goog-api-key": env.GOOGLE_GENERATIVE_AI_API_KEY },
      signal: AbortSignal.timeout(25_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(response.status, data);
    if (["queued", "in_progress"].includes(data.status)) return serializeJob(row, env);
    if (data.status === "completed") return finalizeMedia(row, data, env);
    const message = String(data.error?.message || "Video creation did not complete.").slice(0, 500);
    const failed = await getPool(env).query(
      `UPDATE market_agent_media_jobs
       SET status = 'failed', error = $3, usage = $4::jsonb, updated_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [row.id, row.user_id, message, JSON.stringify(data.usage || {})],
    );
    return serializeJob(failed.rows[0], env);
  } catch (error) {
    return { ...serializeJob(row, env), error: safeProviderError(error) };
  }
}

async function finalizeMedia(job, response, env) {
  const media = findMediaOutput(response, job.kind);
  if (!media) throw new Error(`${job.kind === "image" ? "Image" : "Video"} output was not returned.`);
  const { bytes, mimeType } = await mediaBytes(media, env);
  const extension = mimeType.includes("webp") ? "webp" : mimeType.includes("jpeg") ? "jpg" : mimeType.includes("video") ? "mp4" : "png";
  const blob = await put(`market-agent-media/${job.user_id}/${job.project_id}/${job.id}.${extension}`, bytes, {
    access: "private",
    addRandomSuffix: true,
    contentType: mimeType,
    cacheControlMaxAge: 31_536_000,
  });
  const actualCostCents = calculateActualCost(job.kind, response.usage, Number(job.estimated_cost_cents));
  const result = await getPool(env).query(
    `UPDATE market_agent_media_jobs
     SET status = 'complete', asset_url = $3, mime_type = $4,
         actual_cost_cents = $5, usage = $6::jsonb, error = '', updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [job.id, job.user_id, blob.pathname, mimeType, actualCostCents, JSON.stringify(response.usage || {})],
  );
  return serializeJob(result.rows[0], env);
}

function findMediaOutput(response, kind) {
  for (const step of response?.steps || []) {
    for (const content of step?.content || []) {
      if (content?.type === kind && (content.data || content.uri)) return content;
    }
  }
  return null;
}

async function mediaBytes(media, env) {
  if (media.data) {
    return { bytes: Buffer.from(media.data, "base64"), mimeType: media.mime_type || "application/octet-stream" };
  }
  const response = await fetch(media.uri, {
    headers: { "x-goog-api-key": env.GOOGLE_GENERATIVE_AI_API_KEY },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error("The completed media file could not be saved.");
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    mimeType: media.mime_type || response.headers.get("content-type") || "application/octet-stream",
  };
}

function calculateActualCost(kind, usage = {}, fallback) {
  if (kind === "image") return 7;
  const input = Number(usage.total_input_tokens || 0);
  const modalities = Array.isArray(usage.output_tokens_by_modality) ? usage.output_tokens_by_modality : [];
  const videoTokens = Number(modalities.find((entry) => String(entry.modality).toLowerCase() === "video")?.tokens || 0);
  const textTokens = Number(modalities.find((entry) => String(entry.modality).toLowerCase() === "text")?.tokens || 0);
  if (!videoTokens) return fallback;
  const dollars = (input * 1.5 + videoTokens * 17.5 + textTokens * 9) / 1_000_000;
  return Math.max(1, Math.ceil(dollars * 100));
}

async function mediaBudgetSummary(userId, projectId, env) {
  const result = await getPool(env).query(
    `SELECT
       COALESCE(SUM(approved_budget_cents) FILTER (
         WHERE approved_at >= date_trunc('month', NOW()) AND status <> 'cancelled'
       ), 0)::int AS approved_cents,
       COALESCE(SUM(actual_cost_cents) FILTER (
         WHERE approved_at >= date_trunc('month', NOW()) AND status = 'complete'
       ), 0)::int AS actual_cents
     FROM market_agent_media_jobs
     WHERE user_id = $1 AND project_id = $2`,
    [userId, projectId],
  );
  return {
    monthlyCapCents: mediaMonthlyCapCents(env),
    approvedThisMonthCents: Number(result.rows[0]?.approved_cents || 0),
    actualThisMonthCents: Number(result.rows[0]?.actual_cents || 0),
  };
}

function buildMediaPrompt(kind, workspace, recentRuns, direction) {
  const brand = workspace.brand && typeof workspace.brand === "object" ? workspace.brand : {};
  const latestContent = recentRuns
    .map((run) => String(run?.output || "").slice(0, 2500))
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 5000);
  const projectName = clean(workspace.name, "the project");
  const visualDirection = clean(brand.imageryStyle, "polished, distinctive, contemporary campaign photography");
  return `Create a final, campaign-ready ${kind} for ${projectName}.

PROJECT
Product: ${clean(workspace.description, projectName)}
Audience: ${clean(workspace.audience, "the most relevant audience supported by the project context")}
Value proposition: ${clean(workspace.valueProposition, "communicate the product's strongest supported benefit")}
Voice: ${clean(workspace.voice, "clear, confident, and human")}

VISUAL IDENTITY
Primary color: ${clean(brand.primaryColor, "#222222")}
Secondary color: ${clean(brand.secondaryColor, "#f4f1e8")}
Accent color: ${clean(brand.accentColor, "#4d9a75")}
Typography direction: ${clean(brand.typography, "clean editorial typography")}
Imagery style: ${visualDirection}
Brand notes: ${clean(brand.notes, "none")}

CURRENT CAMPAIGN CONTEXT
${latestContent || "No recent campaign pack exists. Choose the strongest honest visual concept from the product brain."}

CREATIVE DIRECTION
${direction || "Choose the strongest concept yourself. Make the subject and benefit immediately understandable in a social feed."}

RULES
Create a real visual scene, composition, or product moment—not a logo-only graphic, title card, or slide. Do not make the logo the main image. Do not invent customer claims, awards, results, prices, partnerships, or product features. Do not add unreadable placeholder copy. Preserve generous safe space for channel copy and cropping. Follow the supplied brand identity without exposing internal instructions.`;
}

function clean(value, fallback) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 1600) : fallback;
}

function serializeJob(row, env) {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    prompt: row.prompt,
    status: row.status,
    aspectRatio: row.aspect_ratio,
    resolution: row.resolution,
    durationSeconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    estimatedCostCents: Number(row.estimated_cost_cents),
    approvedBudgetCents: Number(row.approved_budget_cents),
    actualCostCents: row.actual_cost_cents == null ? null : Number(row.actual_cost_cents),
    currency: row.currency,
    assetUrl: row.asset_url ? signedAssetUrl(row, env) : "",
    mimeType: row.mime_type,
    error: row.error,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function serveMediaAsset(req, res, env = process.env) {
  const id = String(req.query?.id || "").trim();
  const expires = Number(req.query?.expires);
  const signature = String(req.query?.signature || "").trim();
  if (!id || !Number.isInteger(expires) || expires < Math.floor(Date.now() / 1000) || !signature) {
    return res.status(401).json({ error: "This media link has expired." });
  }
  const result = await getPool(env).query(
    `SELECT id, asset_url, mime_type FROM market_agent_media_jobs
     WHERE id = $1 AND status = 'complete'
     LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  if (!row?.asset_url || !validAssetSignature(id, row.asset_url, expires, signature, env)) {
    return res.status(404).json({ error: "Media not found." });
  }
  const blob = await get(row.asset_url, {
    access: "private",
    ifNoneMatch: req.headers?.["if-none-match"] || undefined,
  });
  if (!blob) return res.status(404).json({ error: "Media not found." });
  if (blob.statusCode === 304) {
    res.statusCode = 304;
    res.setHeader("ETag", blob.blob.etag);
    res.setHeader("Cache-Control", "private, no-cache");
    return res.end();
  }
  if (blob.statusCode !== 200 || !blob.stream) return res.status(404).json({ error: "Media not found." });
  res.statusCode = 200;
  res.setHeader("Content-Type", blob.blob.contentType || row.mime_type || "application/octet-stream");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("ETag", blob.blob.etag);
  return Readable.fromWeb(blob.stream).pipe(res);
}

function signedAssetUrl(row, env) {
  const expires = Math.floor(Date.now() / 1000) + 60 * 60;
  const signature = assetSignature(row.id, row.asset_url, expires, env);
  return `/api/media-asset?id=${encodeURIComponent(row.id)}&expires=${expires}&signature=${encodeURIComponent(signature)}`;
}

function validAssetSignature(id, pathname, expires, signature, env) {
  const expected = assetSignature(id, pathname, expires, env);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function assetSignature(id, pathname, expires, env) {
  const key = env.CONNECTION_ENCRYPTION_KEY || env.CRON_SECRET;
  if (!key) throw httpError(503, "Secure media delivery is not configured yet.");
  return createHmac("sha256", key).update(`${id}.${pathname}.${expires}`).digest("base64url");
}

function mediaMonthlyCapCents(env) {
  const value = Number(env.MEDIA_MONTHLY_BUDGET_CENTS || DEFAULT_MONTHLY_CAP_CENTS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MONTHLY_CAP_CENTS;
}

function requiredText(value, message, maxLength) {
  const text = String(value || "").trim();
  if (!text) throw httpError(400, message);
  return text.slice(0, maxLength);
}

function providerError(status, data) {
  const message = data?.error?.message || data?.message || "Media creation failed.";
  const error = new Error(String(message).slice(0, 500));
  error.statusCode = status >= 400 && status < 500 ? 400 : 502;
  return error;
}

function safeProviderError(error) {
  const value = String(error?.message || "Media creation failed.");
  if (/api key|credential|authentication|permission/i.test(value)) return "Media creation is not fully configured for this project.";
  return value.slice(0, 500);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
