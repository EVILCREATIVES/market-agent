import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { generateDeliveryPlan } from "./agent.mjs";
import { getConnectionStatus } from "./connections.mjs";
import { loadStateForUser, getPool } from "./db.mjs";
import { sendGmailMessage } from "./connections.mjs";
import { publishSocialPost } from "./social-connections.mjs";
import { getSocialPublishingOptions } from "./social-connections.mjs";
import { getSocialPostStatus } from "./social-connections.mjs";
import { createShopifyDraft } from "./shopify.mjs";
import { createPublicProjectAssetUrl, listReadyCampaignAssets } from "./assets.mjs";
import { loadUserApiEnv } from "./user-api-credentials.mjs";
import { unresolvedEmailPlaceholders } from "./email-content.mjs";

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
      ORDER BY created_at ASC LIMIT 500`,
    values,
  );
  const jobs = result.rows.map((row, index) => {
    const job = serializeDeliveryJob(row);
    if (!job.payload?.scheduledAt && job.status === "awaiting_approval") job.payload.scheduledAt = normalizeScheduledAt("", index);
    if (job.payload?.sourceAssetId) job.payload.mediaUrl = createPublicProjectAssetUrl(job.payload.sourceAssetId, env);
    return job;
  });
  let coverage = { expected: jobs.length, prepared: jobs.filter((job) => job.status !== "cancelled").length, missing: 0 };
  if (runId) {
    const { state } = await loadStateForUser(userId, env);
    const run = state.runs.find((item) => item.id === runId && item.projectId === projectId);
    const expected = campaignPublicationTarget(run);
    const prepared = jobs.filter((job) => job.status !== "cancelled").length;
    coverage = { expected: Math.max(expected, prepared), prepared, missing: Math.max(0, expected - prepared) };
  }
  return { jobs, coverage };
}

export function prospectInvitationRunId(campaignId) {
  return `optin-${String(campaignId || "").trim().slice(0, 160)}`;
}

export function personalizeInvitationTemplate(template, recipient = {}, signupUrl = "") {
  const firstName = String(recipient?.firstName || "").trim();
  const company = String(recipient?.company || "").trim();
  return String(template || "")
    .replaceAll("{{first_name}}", firstName || "there")
    .replaceAll("{{company}}", company)
    .replaceAll("{{invitation_url}}", String(signupUrl || "").trim())
    .replaceAll("{{signup_url}}", String(signupUrl || "").trim())
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function renderInvitationEmailHtml(workspace = {}, campaign = {}, input = {}) {
  const destination = resolveInvitationDestination(input.invitationUrl, campaign.invitationUrl, workspace?.website, campaign.publicUrl);
  const subject = String(input.subject || campaign.invitationSubject || "Invitation").trim();
  const body = String(input.body || campaign.invitationBody || "").trim();
  const cta = String(input.ctaLabel || campaign.invitationCtaLabel || "Open").trim().slice(0, 100) || "Open";
  const brand = workspace?.brand || {};
  const primary = safeEmailColor(brand.primaryColor, "#6e50d7");
  const background = safeEmailColor(brand.neutralLightColor, "#f6f5f2");
  const text = safeEmailColor(brand.neutralDarkColor, "#202020");
  const name = String(workspace?.name || "Project").trim();
  const logo = invitationLogo(workspace);
  const hero = invitationHero(workspace);
  const identity = workspace?.emailIdentity || {};
  const signature = [identity.senderName, identity.businessDetails, identity.addressPreference === "include" ? identity.physicalAddress : ""].filter(Boolean).map((line) => emailParagraphs(line)).join("<br>");
  const action = destination ? `<div style="margin:4px 0 24px"><p style="margin:0 0 8px"><a href="${escapeEmailAttribute(destination)}" style="display:inline-block;padding:13px 20px;background:${primary};color:#ffffff;text-decoration:none;border-radius:7px;font:700 15px Arial,sans-serif">${escapeEmailHtml(cta)}</a></p><p style="margin:0;font:400 12px/1.5 Arial,sans-serif;color:#777">Or open: <a href="${escapeEmailAttribute(destination)}" style="color:${primary};word-break:break-all">${escapeEmailHtml(destination)}</a></p></div>` : "";
  let actionPlaced = false;
  const content = body.split(/\n{2,}/).map((item) => item.trim()).filter(Boolean).map((item) => {
    if (destination && [destination, "{{invitation_url}}", "{{signup_url}}"].includes(item)) {
      actionPlaced = true;
      return action;
    }
    if (destination && item.includes(destination)) {
      actionPlaced = true;
      const linked = emailParagraphs(item).replaceAll(escapeEmailHtml(destination), `<a href="${escapeEmailAttribute(destination)}" style="color:${primary};word-break:break-all">${escapeEmailHtml(destination)}</a>`);
      return `<p style="margin:0 0 18px;font:400 16px/1.65 Arial,sans-serif;color:${text}">${linked}</p>`;
    }
    return `<p style="margin:0 0 18px;font:400 16px/1.65 Arial,sans-serif;color:${text}">${emailParagraphs(item)}</p>`;
  }).join("");
  const trailingAction = destination && !actionPlaced ? action : "";
  const testBanner = input.test === true ? `<tr><td style="padding:11px 28px;background:#fff3cd;color:#654d03;font:700 12px/1.4 Arial,sans-serif;text-align:center">TEST EMAIL — no prospect received this message</td></tr>` : "";
  const optOut = input.unsubscribeUrl ? `<br><a href="${escapeEmailAttribute(input.unsubscribeUrl)}" style="color:#666">Stop future invitations</a>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeEmailHtml(subject)}</title></head><body style="margin:0;padding:0;background:${background}"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${background};padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden"><tr><td style="height:8px;background:${primary}"></td></tr>${testBanner}<tr><td style="padding:28px 34px 22px">${logo ? `<img src="${escapeEmailAttribute(logo)}" alt="${escapeEmailAttribute(name)}" style="display:block;max-width:190px;max-height:72px;width:auto;height:auto">` : `<div style="font:700 13px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${primary}">${escapeEmailHtml(name)}</div>`}</td></tr>${hero ? `<tr><td><img src="${escapeEmailAttribute(hero.url)}" alt="${escapeEmailAttribute(hero.alt)}" width="640" style="display:block;width:100%;max-width:640px;height:auto;max-height:420px;object-fit:cover"></td></tr>` : ""}<tr><td style="padding:30px 34px 18px"><h1 style="margin:0 0 22px;font:700 30px/1.2 Arial,sans-serif;color:${text}">${escapeEmailHtml(subject)}</h1>${content}${trailingAction}${signature ? `<p style="margin:24px 0 0;font:600 14px/1.55 Arial,sans-serif;color:${text}">${signature}</p>` : ""}</td></tr><tr><td style="padding:20px 34px;background:#f2f1ee;font:400 12px/1.5 Arial,sans-serif;color:#666">This is a direct project invitation, not a newsletter subscription.${optOut}</td></tr></table></td></tr></table></body></html>`;
}

function invitationLogo(workspace) {
  const variants = Array.isArray(workspace?.brand?.logoVariants) ? workspace.brand.logoVariants : [];
  const selected = variants.find((item) => item?.usage === "email") || variants.find((item) => item?.usage === "primary") || variants[0];
  return safeInvitationImage(selected?.url || workspace?.brand?.logoDataUrl);
}

function invitationHero(workspace) {
  const media = Array.isArray(workspace?.sourceMedia) ? workspace.sourceMedia : [];
  const selected = media.find((item) => item?.kind === "image" && item?.recommendation === "reuse" && !/\b(logo|favicon|icon|wordmark|brand mark)\b/i.test(`${item?.name || ""} ${item?.role || ""}`))
    || media.find((item) => item?.kind === "image" && !/\b(logo|favicon|icon|wordmark|brand mark)\b/i.test(`${item?.name || ""} ${item?.role || ""}`));
  const url = safeInvitationImage(selected?.url);
  return url ? { url, alt: String(selected?.name || selected?.role || "").slice(0, 180) } : null;
}

function safeInvitationImage(value) {
  const source = String(value || "").trim();
  return /^https:\/\/[^\s<>]+$/i.test(source) ? source : "";
}

export function resolveInvitationDestination(...values) {
  for (const value of values) {
    const source = String(value || "").trim();
    if (!source || /[\s<>]/.test(source)) continue;
    const candidate = /^https?:\/\//i.test(source) ? source : `https://${source}`;
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && url.hostname.includes(".") && !url.username && !url.password && url.hostname !== "localhost") return url.toString();
    } catch {
      // Try the next known project destination.
    }
  }
  return "";
}

function safeEmailColor(value, fallback) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function emailParagraphs(value) {
  return escapeEmailHtml(value).replace(/\r?\n/g, "<br>");
}

function escapeEmailHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]);
}

function escapeEmailAttribute(value) {
  return escapeEmailHtml(value).replace(/`/g, "&#96;");
}

export async function scheduleProspectInvitations(userId, projectId, campaign, recipients, input = {}, userApiEnv = {}, env = process.env) {
  await ensureDeliveryTable(env);
  if (!channelAllowedForAccess("gmail", userApiEnv)) throw deliveryError("Direct invitation delivery is available after connecting your APIs or activating the managed plan.", 403);
  const connections = await getConnectionStatus(userId, projectId, env);
  if (!connections.gmail?.canSend) throw deliveryError("Connect this project's mailbox and approve sending access before scheduling invitations.", 409);
  if (!campaign?.id || campaign?.status !== "active") throw deliveryError("Activate the invitation before scheduling its email.", 409);
  const signupUrl = String(campaign.publicUrl || "").trim();
  const { state } = await loadStateForUser(userId, env);
  const workspace = state.projects.find((item) => item.id === projectId) || {};
  const invitationUrl = resolveInvitationDestination(input?.invitationUrl, campaign.invitationUrl, workspace.website, signupUrl);
  if (!invitationUrl) throw deliveryError("The invitation needs a public HTTPS destination before it can be scheduled.", 409);
  const subjectTemplate = String(input?.subject || campaign.invitationSubject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
  let bodyTemplate = String(input?.body || campaign.invitationBody || "").trim().slice(0, 20_000);
  if (!subjectTemplate || !bodyTemplate) throw deliveryError("Review the invitation subject and message before scheduling it.", 400);
  if (!bodyTemplate.includes("{{invitation_url}}") && !bodyTemplate.includes("{{signup_url}}") && !bodyTemplate.includes(invitationUrl)) bodyTemplate = `${bodyTemplate}\n\n${String(input?.invitationCtaLabel || campaign.invitationCtaLabel || "Learn more")}: {{invitation_url}}`;
  const requestedStart = new Date(String(input?.startAt || ""));
  if (!Number.isFinite(requestedStart.getTime()) || requestedStart.getTime() < Date.now() + 10 * 60_000) throw deliveryError("Choose an invitation start time at least ten minutes from now.", 400);
  if (requestedStart.getTime() > Date.now() + 370 * 24 * 60 * 60_000) throw deliveryError("Choose an invitation start time within the next year.", 400);
  const intervalMinutes = Math.min(30, Math.max(1, Number.parseInt(input?.intervalMinutes, 10) || 2));
  const unique = new Map();
  for (const recipient of Array.isArray(recipients) ? recipients : []) {
    const email = String(recipient?.email || "").trim().toLowerCase();
    if (/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(email) && !unique.has(email)) unique.set(email, { ...recipient, email });
  }
  if (!unique.size) throw deliveryError("There are no eligible staged prospects to invite.", 409);
  if (unique.size > 1_000) throw deliveryError("Invitation campaigns are limited to 1,000 individual recipients at a time.", 400);
  const runId = prospectInvitationRunId(campaign.id);
  const approvalId = randomUUID();
  const repeatSend = input?.resend === true && input?.repeatConfirmed === true;
  if (repeatSend) {
    const current = await getProspectInvitationStats(userId, projectId, campaign.id, env);
    if (current.scheduled > 0) throw deliveryError("Wait for the currently scheduled invitation batch to finish before approving a repeat send.", 409);
  }
  const client = await getPool(env).connect();
  let inserted = 0;
  try {
    await client.query("BEGIN");
    const suppressionResult = await client.query(
      "SELECT email FROM market_agent_email_suppressions WHERE user_id = $1 AND project_id = $2",
      [userId, projectId],
    );
    const suppressed = new Set(suppressionResult.rows.map((row) => String(row.email || "").toLowerCase()));
    let index = 0;
    for (const recipient of unique.values()) {
      if (suppressed.has(recipient.email)) continue;
      const scheduledAt = new Date(requestedStart.getTime() + index * intervalMinutes * 60_000).toISOString();
      const personalizedSubject = personalizeInvitationTemplate(subjectTemplate, recipient, invitationUrl);
      const personalizedBody = personalizeInvitationTemplate(bodyTemplate, recipient, invitationUrl);
      const payload = {
        recipient: recipient.email,
        recipientName: [recipient.firstName, recipient.lastName].filter(Boolean).join(" "),
        subject: personalizedSubject,
        text: personalizedBody,
        html: renderInvitationEmailHtml(workspace, campaign, { subject: personalizedSubject, body: personalizedBody, invitationUrl, ctaLabel: input?.invitationCtaLabel || campaign.invitationCtaLabel, unsubscribeUrl: "{{unsubscribe_url}}" }),
        scheduledAt,
        campaignApprovalId: approvalId,
        campaignId: campaign.id,
        campaignType: "prospect_invitation",
        signupUrl,
        invitationUrl,
        invitationStrategy: campaign.invitationStrategy || "custom",
        rationale: "One-time invitation to the approved project destination.",
      };
      const idempotencyKey = createHash("sha256").update(`${userId}:${projectId}:${runId}:${repeatSend ? approvalId : "initial"}:${recipient.email}`).digest("hex");
      const result = await client.query(
        `INSERT INTO market_agent_delivery_jobs
          (id,user_id,project_id,run_id,channel,payload,status,idempotency_key,approved_at,next_attempt_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'gmail',$5::jsonb,'scheduled',$6,NOW(),$7::timestamptz,NOW(),NOW())
         ON CONFLICT (user_id,idempotency_key) WHERE idempotency_key <> '' DO NOTHING`,
        [randomUUID(), userId, projectId, runId, JSON.stringify(payload), idempotencyKey, scheduledAt],
      );
      inserted += result.rowCount || 0;
      index += 1;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const summary = await getProspectInvitationStats(userId, projectId, campaign.id, env);
  return { runId, inserted, sender: connections.gmail.accountEmail, intervalMinutes, ...summary };
}

export async function sendProspectInvitationTest(userId, projectId, campaign, input = {}, userApiEnv = {}, env = process.env) {
  if (!channelAllowedForAccess("gmail", userApiEnv)) throw deliveryError("Test delivery is available after connecting your APIs or activating the managed plan.", 403);
  const connections = await getConnectionStatus(userId, projectId, env);
  const recipient = String(connections.gmail?.accountEmail || "").trim().toLowerCase();
  if (!connections.gmail?.canSend || !recipient) throw deliveryError("Connect this project's mailbox before sending a test.", 409);
  const { state } = await loadStateForUser(userId, env);
  const workspace = state.projects.find((item) => item.id === projectId) || {};
  const invitationUrl = resolveInvitationDestination(input?.invitationUrl, campaign?.invitationUrl, workspace.website, campaign?.publicUrl);
  if (!invitationUrl) throw deliveryError("Add a public project or action link before sending the test.", 409);
  const subject = personalizeInvitationTemplate(String(input?.subject || campaign?.invitationSubject || "Invitation test"), { firstName: "Test", company: "Your organization" }, invitationUrl);
  let body = personalizeInvitationTemplate(String(input?.body || campaign?.invitationBody || ""), { firstName: "Test", company: "Your organization" }, invitationUrl);
  if (!body) throw deliveryError("Write the invitation message before sending a test.", 400);
  body = `TEST — This invitation has not been sent to prospects.\n\n${body}`;
  const html = renderInvitationEmailHtml(workspace, campaign, { subject, body: body.replace(/^TEST[^\n]*\n+/i, ""), invitationUrl, ctaLabel: input?.invitationCtaLabel || campaign?.invitationCtaLabel, test: true });
  const result = await sendGmailMessage(userId, projectId, { to: recipient, subject: `[TEST] ${subject}`, body, html }, env);
  return { recipient, sentAt: result.sentAt, externalId: result.externalId };
}

export async function getProspectInvitationStats(userId, projectId, campaignId, env = process.env) {
  await ensureDeliveryTable(env);
  const runId = prospectInvitationRunId(campaignId);
  const result = await getPool(env).query(
    `SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status IN ('scheduled','running','submitted'))::int AS scheduled,
      COUNT(*) FILTER (WHERE status = 'complete')::int AS sent,
      COUNT(*) FILTER (WHERE status IN ('failed','dead_letter'))::int AS failed,
      COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
      MIN(NULLIF(payload->>'scheduledAt','')::timestamptz) AS starts_at,
      MAX(NULLIF(payload->>'scheduledAt','')::timestamptz) AS ends_at
     FROM market_agent_delivery_jobs
     WHERE user_id = $1 AND project_id = $2 AND run_id = $3 AND channel = 'gmail'`,
    [userId, projectId, runId],
  );
  const row = result.rows[0] || {};
  return {
    total: Number(row.total || 0),
    scheduled: Number(row.scheduled || 0),
    sent: Number(row.sent || 0),
    failed: Number(row.failed || 0),
    cancelled: Number(row.cancelled || 0),
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
  };
}

export async function replaceDeliveryMediaFromAsset(userId, projectId, runId, asset, env = process.env) {
  await ensureDeliveryTable(env);
  if (!asset || asset.projectId !== projectId || !["image", "video"].includes(asset.kind) || asset.status !== "ready" || !asset.id) {
    throw deliveryError("The selected Content Library item cannot be used as campaign media.", 400);
  }
  const result = await getPool(env).query(
    `SELECT * FROM market_agent_delivery_jobs
      WHERE user_id = $1 AND project_id = $2 AND run_id = $3 AND status = 'awaiting_approval'
      ORDER BY created_at ASC`,
    [userId, projectId, runId],
  );
  const compatible = asset.kind === "video"
    ? new Set(["instagram", "tiktok", "youtube", "discord"])
    : new Set(["instagram", "tiktok", "linkedin", "x", "discord", "shopify"]);
  let replaced = 0;
  for (const row of result.rows) {
    if (!compatible.has(row.channel)) continue;
    const payload = { ...(row.payload || {}), sourceAssetId: asset.id, mediaUrl: createPublicProjectAssetUrl(asset.id, env), mediaKind: asset.kind };
    await getPool(env).query("UPDATE market_agent_delivery_jobs SET payload = $3::jsonb, updated_at = NOW() WHERE id = $1 AND user_id = $2", [row.id, userId, JSON.stringify(payload)]);
    replaced += 1;
  }
  if (!replaced) throw deliveryError("No unapproved campaign post can use this asset right now.", 409);
  return { asset: { id: asset.id, name: asset.name, kind: asset.kind, summary: asset.summary || "Saved campaign asset", tags: asset.tags || [], routingRationale: `Selected from the Content Library to replace the campaign media.` }, replaced, ...(await listDeliveryJobs(userId, projectId, runId, env)) };
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
  let channels = operationalChannels(connections).filter((channel) => channelAllowedForAccess(channel, userApiEnv));
  if (!channels.length) throw deliveryError("Connect an operational email or social channel first.", 409);
  const requestedScope = requestedDeliveryScope(run, channels);
  channels = requestedScope.channels;
  if (!channels.length) throw deliveryError(requestedScope.explicit
    ? "The channel requested in this campaign is not connected for publishing. Connect it, then prepare actions again."
    : "Connect an operational email or social channel first.", 409);
  const channelContexts = {};
  if (channels.includes("reddit")) {
    try { channelContexts.reddit = await getSocialPublishingOptions(userId, projectId, "reddit", env); }
    catch { channels = channels.filter((channel) => channel !== "reddit"); }
  }
  if (!channels.length) throw deliveryError("The selected community's current rules could not be verified. Nothing was prepared.", 409);
  const libraryMedia = await listReadyCampaignAssets(userId, projectId, env).catch(() => []);
  const savedMedia = Array.isArray(workspace.sourceMedia) ? workspace.sourceMedia : [];
  const deliveryWorkspace = {
    ...workspace,
    sourceMedia: [...libraryMedia, ...savedMedia.filter((item) => !libraryMedia.some((asset) => asset.id === item?.id))],
  };
  const plan = run.campaignPlan?.items?.length
    ? run.campaignPlan
    : await generateDeliveryPlan({ run, workspace: deliveryWorkspace, channels, channelContexts }, userApiEnv);
  const safeItems = normalizeDeliveryItems(plan?.items, channels, deliveryWorkspace, run);
  if (!safeItems.length && channels.includes("instagram")) {
    const hasMedia = campaignMedia(deliveryWorkspace).some((item) => ["image", "video"].includes(item.kind));
    throw deliveryError(hasMedia
      ? "The approved campaign does not contain final Instagram copy that can be queued. Ask the project assistant to prepare the final Instagram caption, approve it, then prepare actions again."
      : "Instagram is connected, but this project has no reusable public campaign image or video. Generate or approve an asset in Content, then prepare actions again.", 409);
  }
  for (let index = 0; index < safeItems.length; index += 1) {
    const item = safeItems[index];
    const idempotencyKey = createHash("sha256").update(`${userId}:${projectId}:${runId}:${index}:${item.channel}`).digest("hex");
    await getPool(env).query(
      `INSERT INTO market_agent_delivery_jobs
        (id, user_id, project_id, run_id, channel, payload, status, idempotency_key, next_attempt_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,'awaiting_approval',$7,NULL,NOW(),NOW())
       ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key <> '' DO NOTHING`,
      [randomUUID(), userId, projectId, runId, item.channel, JSON.stringify(item), idempotencyKey],
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
  if (!["tiktok", "youtube"].includes(row.channel)) throw deliveryError("This delivery item does not need additional publishing settings.", 400);
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
    const storedPayload = row.payload?.sourceAssetId ? { ...row.payload, mediaUrl: createPublicProjectAssetUrl(row.payload.sourceAssetId, env) } : row.payload;
    const payload = row.channel === "tiktok"
      ? prepareTikTokPayload(row.id, mergeTikTokApproval(storedPayload, approval), env)
      : row.channel === "youtube"
        ? mergeYouTubeApproval(storedPayload, approval)
        : storedPayload;
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
  return completeDeliveryExecution(row, userId, env);
}

export async function approveDeliveryCampaign(userId, projectId, runId, items = [], userApiEnv = {}, env = process.env) {
  await ensureDeliveryTable(env);
  const supplied = new Map((Array.isArray(items) ? items : []).map((item) => [String(item?.id || ""), item]));
  const client = await getPool(env).connect();
  const approvalId = randomUUID();
  try {
    await client.query("BEGIN");
    const runResult = await client.query("SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1", [userId, projectId, runId]);
    const expected = campaignPublicationTarget(runResult.rows[0]?.data);
    const preparedResult = await client.query("SELECT COUNT(*)::int AS count FROM market_agent_delivery_jobs WHERE user_id = $1 AND project_id = $2 AND run_id = $3 AND status <> 'cancelled'", [userId, projectId, runId]);
    const prepared = Number(preparedResult.rows[0]?.count || 0);
    if (expected > prepared) throw deliveryError(`Only ${prepared} of ${expected} planned campaign items are executable. Complete the missing copy or assets before approving the full schedule.`, 409);
    const result = await client.query(
      `SELECT * FROM market_agent_delivery_jobs
        WHERE user_id = $1 AND project_id = $2 AND run_id = $3 AND status = 'awaiting_approval'
        ORDER BY created_at ASC FOR UPDATE`,
      [userId, projectId, runId],
    );
    if (!result.rows.length) throw deliveryError("There are no unapproved campaign items to schedule.", 409);
    for (let index = 0; index < result.rows.length; index += 1) {
      const row = result.rows[index];
      if (!channelAllowedForAccess(row.channel, userApiEnv)) throw deliveryError(`${row.channel} is not included in the current access level.`, 403);
      const submitted = supplied.get(row.id) || {};
      const scheduledAt = approvedScheduleDate(submitted.scheduledAt || row.payload?.scheduledAt, index);
      const storedPayload = row.payload?.sourceAssetId ? { ...row.payload, mediaUrl: createPublicProjectAssetUrl(row.payload.sourceAssetId, env) } : row.payload;
      const reviewedPayload = row.channel === "tiktok"
        ? mergeTikTokApproval(storedPayload, submitted.approval || {})
        : row.channel === "youtube"
          ? mergeYouTubeApproval(storedPayload, submitted.approval || {})
          : storedPayload;
      const payload = { ...(reviewedPayload || {}), scheduledAt, campaignApprovalId: approvalId };
      await client.query(
        `UPDATE market_agent_delivery_jobs
          SET status = 'scheduled', payload = $3::jsonb, approved_at = NOW(), error = '', next_attempt_at = $4::timestamptz, updated_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [row.id, userId, JSON.stringify(payload), scheduledAt],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return listDeliveryJobs(userId, projectId, runId, env);
}

export async function approveTrustedDeliveryJobs(userId, projectId, runId, trustedChannels = [], userApiEnv = {}, env = process.env) {
  await ensureDeliveryTable(env);
  const allowed = new Set((Array.isArray(trustedChannels) ? trustedChannels : []).filter((channel) => ["linkedin", "instagram", "x", "discord"].includes(channel)));
  if (!allowed.size) return { approved: 0, ...(await listDeliveryJobs(userId, projectId, runId, env)) };
  const rows = await getPool(env).query(
    `SELECT * FROM market_agent_delivery_jobs
      WHERE user_id = $1 AND project_id = $2 AND run_id = $3 AND status = 'awaiting_approval'
      ORDER BY created_at ASC`,
    [userId, projectId, runId],
  );
  let approved = 0;
  for (let index = 0; index < rows.rows.length; index += 1) {
    const row = rows.rows[index];
    if (!allowed.has(row.channel) || !channelAllowedForAccess(row.channel, userApiEnv)) continue;
    const scheduledAt = approvedScheduleDate(row.payload?.scheduledAt, index);
    const payload = { ...(row.payload || {}), scheduledAt, campaignApprovalId: `standing-${runId}` };
    await getPool(env).query(
      `UPDATE market_agent_delivery_jobs SET status = 'scheduled', payload = $3::jsonb,
        approved_at = NOW(), next_attempt_at = $4::timestamptz, error = '', updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = 'awaiting_approval'`,
      [row.id, userId, JSON.stringify(payload), scheduledAt],
    );
    approved += 1;
  }
  return { approved, ...(await listDeliveryJobs(userId, projectId, runId, env)) };
}

export async function pauseDeliveryCampaign(userId, projectId, runId, env = process.env) {
  await ensureDeliveryTable(env);
  const result = await getPool(env).query(
    `UPDATE market_agent_delivery_jobs
      SET status = 'awaiting_approval', approved_at = NULL,
          payload = CASE WHEN channel = 'tiktok'
            THEN (payload - 'campaignApprovalId') || '{"privacyLevel":"","musicConsent":false}'::jsonb
            ELSE payload - 'campaignApprovalId' END,
          updated_at = NOW()
      WHERE user_id = $1 AND project_id = $2 AND run_id = $3 AND status = 'scheduled'
      RETURNING id`,
    [userId, projectId, runId],
  );
  if (!result.rowCount) throw deliveryError("This campaign has no future scheduled items to pause.", 409);
  return listDeliveryJobs(userId, projectId, runId, env);
}

export async function runScheduledDeliveryJobs(env = process.env, limit = 10) {
  await ensureDeliveryTable(env);
  const due = await getPool(env).query(
    `WITH candidates AS (
      SELECT id FROM market_agent_delivery_jobs
      WHERE status = 'scheduled'
        AND COALESCE(next_attempt_at, NULLIF(payload->>'scheduledAt', '')::timestamptz) <= NOW()
      ORDER BY COALESCE(next_attempt_at, NULLIF(payload->>'scheduledAt', '')::timestamptz) ASC
      FOR UPDATE SKIP LOCKED
      LIMIT $1
    )
    UPDATE market_agent_delivery_jobs jobs
      SET status = 'running', attempt_count = attempt_count + 1, updated_at = NOW()
    FROM candidates
    WHERE jobs.id = candidates.id
    RETURNING jobs.*`,
    [Math.max(1, Math.min(25, Number(limit) || 10))],
  );
  const results = [];
  for (const row of due.rows) {
    try {
      const userApiEnv = await loadUserApiEnv(row.user_id);
      if (!channelAllowedForAccess(row.channel, userApiEnv)) throw deliveryError("This delivery channel is no longer included in the current access level.", 403);
      const result = await completeDeliveryExecution(row, row.user_id, env);
      results.push({ id: row.id, userId: row.user_id, status: result.job.status, error: result.job.error || "" });
    } catch (error) {
      const errorMessage = safeError(error);
      const failed = await recordDeliveryFailure(row, errorMessage, env);
      results.push({ id: row.id, userId: row.user_id, status: failed.status, error: errorMessage });
    }
  }
  return results;
}

async function completeDeliveryExecution(row, userId, env) {
  try {
    let payload = row.payload?.sourceAssetId ? { ...row.payload, mediaUrl: createPublicProjectAssetUrl(row.payload.sourceAssetId, env) } : (row.payload || {});
    if (row.channel === "tiktok") payload = prepareTikTokPayload(row.id, payload, env);
    if (row.channel === "gmail") {
      const suppressed = await getPool(env).query("SELECT 1 FROM market_agent_email_suppressions WHERE user_id = $1 AND project_id = $2 AND email = $3 LIMIT 1", [userId, row.project_id, String(payload.recipient || "").toLowerCase()]);
      if (suppressed.rows[0]) throw deliveryError("This recipient previously opted out and is suppressed.", 409);
      const optOutUrl = createEmailOptOutUrl(row.id, env);
      payload = {
        ...payload,
        text: `${String(payload.text || "").trim()}\n\nStop future emails from this sender: ${optOutUrl}`,
        html: String(payload.html || "").replaceAll("{{unsubscribe_url}}", optOutUrl),
      };
    }
    const result = row.channel === "gmail"
      ? await sendGmailMessage(userId, row.project_id, { to: payload.recipient, subject: payload.subject, body: payload.text, html: payload.html, unsubscribeUrl: createEmailOptOutUrl(row.id, env) }, env)
      : row.channel === "shopify"
        ? await createShopifyDraft(userId, row.project_id, payload, env)
        : await publishSocialPost(userId, row.project_id, row.channel, payload, env);
    const status = result.status === "processing" ? "submitted" : "complete";
    const updated = await getPool(env).query(
      `UPDATE market_agent_delivery_jobs
          SET status = $3, external_id = $4, result = $5::jsonb, error = '', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND user_id = $2 RETURNING *`,
      [row.id, userId, status, String(result.externalId || ""), JSON.stringify(result)],
    );
    return { job: serializeDeliveryJob(updated.rows[0]) };
  } catch (error) {
    const failed = await recordDeliveryFailure(row, safeError(error), env);
    return { job: serializeDeliveryJob(failed) };
  }
}

function createEmailOptOutUrl(id, env) {
  const origin = String(env.APP_BASE_URL || "").replace(/\/$/, "");
  if (!/^https:\/\//i.test(origin)) throw deliveryError("The public app address is not configured for email opt-out links.", 503);
  const signature = createHmac("sha256", deliveryMediaSecret(env)).update(`email-opt-out:${id}`).digest("base64url");
  return `${origin}/api/email-opt-out?token=${encodeURIComponent(`${id}.${signature}`)}`;
}

export async function recordEmailOptOut(token, env = process.env) {
  const split = String(token || "").lastIndexOf(".");
  const id = split > 0 ? String(token).slice(0, split) : "";
  const signature = split > 0 ? String(token).slice(split + 1) : "";
  if (!id || !signature) throw deliveryError("This opt-out link is invalid.", 400);
  const expected = createHmac("sha256", deliveryMediaSecret(env)).update(`email-opt-out:${id}`).digest("base64url");
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length || !timingSafeEqual(receivedBuffer, expectedBuffer)) throw deliveryError("This opt-out link is invalid.", 403);
  const result = await getPool(env).query("SELECT user_id, project_id, payload->>'recipient' AS email FROM market_agent_delivery_jobs WHERE id = $1 AND channel = 'gmail' LIMIT 1", [id]);
  const row = result.rows[0];
  if (!row?.email) throw deliveryError("This opt-out link is no longer available.", 404);
  await getPool(env).query(
    `INSERT INTO market_agent_email_suppressions (user_id, project_id, email, reason)
      VALUES ($1,$2,$3,'recipient opt-out') ON CONFLICT (user_id, project_id, email) DO NOTHING`,
    [row.user_id, row.project_id, String(row.email).toLowerCase()],
  );
  return { ok: true };
}

async function recordDeliveryFailure(row, message, env) {
  const attempts = Number(row.attempt_count || 0);
  const maximum = Math.max(1, Number(row.max_attempts || 5));
  const retryable = Boolean(row.payload?.campaignApprovalId) && attempts < maximum;
  const delayMinutes = retryDelayMinutes(attempts);
  const result = await getPool(env).query(
    `UPDATE market_agent_delivery_jobs
      SET status = $3,
          error = $4,
          next_attempt_at = CASE WHEN $3 = 'scheduled' THEN NOW() + ($5 || ' minutes')::interval ELSE NULL END,
          dead_lettered_at = CASE WHEN $3 = 'dead_letter' THEN NOW() ELSE NULL END,
          updated_at = NOW()
      WHERE id = $1 AND user_id = $2 RETURNING *`,
    [row.id, row.user_id, retryable ? "scheduled" : attempts >= maximum ? "dead_letter" : "failed", message, String(delayMinutes)],
  );
  return result.rows[0];
}

export function retryDelayMinutes(attempts) {
  return Math.min(360, Math.max(2, 2 ** Math.max(1, Number(attempts || 0))));
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

export async function retryDeliveryJob(userId, id, env = process.env) {
  await ensureDeliveryTable(env);
  const result = await getPool(env).query(
    `UPDATE market_agent_delivery_jobs
      SET status = 'awaiting_approval', error = '', result = '{}'::jsonb, approved_at = NULL,
          attempt_count = 0, next_attempt_at = NULL, dead_lettered_at = NULL, updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND status IN ('failed','dead_letter') AND COALESCE(external_id, '') = ''
      RETURNING *`,
    [id, userId],
  );
  if (!result.rows[0]) throw deliveryError("Only a failed or exhausted item without a platform receipt can be retried safely.", 409);
  return { job: serializeDeliveryJob(result.rows[0]) };
}

function operationalChannels(connections) {
  const channels = [];
  if (connections.gmail?.connected && connections.gmail.canSend) channels.push("gmail");
  if (connections.shopify?.connected && connections.shopify.canManage) channels.push("shopify");
  for (const provider of ["linkedin", "instagram", "tiktok", "youtube", "x", "discord", "reddit"]) if (connections[provider]?.connected && connections[provider].canPublish) channels.push(provider);
  return channels;
}

function requestedDeliveryScope(run, availableChannels) {
  const direction = String(run?.prompt || "").toLowerCase();
  if (/\b(all (?:connected )?channels|all social|multichannel|multi-channel|cross-channel|omnichannel)\b/i.test(direction)) return { channels: availableChannels, explicit: true };
  const patterns = {
    gmail: /\b(email|gmail|mail outreach|cold email)\b/i,
    linkedin: /\blinked\s*in\b/i,
    instagram: /\b(instagram|insta\b|ig\b)\b/i,
    tiktok: /\btik\s*tok\b/i,
    youtube: /\byou\s*tube|shorts?\b/i,
    x: /(?:^|\s)(?:x|twitter)(?:\s|$)/i,
    discord: /\bdiscord\b/i,
    reddit: /\breddit\b/i,
    shopify: /\bshopify|product draft|store draft\b/i,
  };
  const requested = Object.entries(patterns).filter(([, pattern]) => pattern.test(direction)).map(([channel]) => channel);
  if (!requested.length) return { channels: availableChannels, explicit: false };
  return { channels: availableChannels.filter((channel) => requested.includes(channel)), explicit: true };
}

function channelAllowedForAccess(channel, accessEnv) {
  const mode = String(accessEnv?.MARKET_AGENT_ACCESS_MODE || "expired");
  if (channel === "x") return mode === "managed";
  if (mode === "byok" || mode === "managed") return true;
  return mode === "trial" && channel === "linkedin";
}

export function campaignPublicationTarget(run) {
  if (!run || typeof run !== "object") return 0;
  const planCount = Array.isArray(run.campaignPlan?.items) ? run.campaignPlan.items.length : 0;
  const text = `${String(run.prompt || "")}\n${String(run.output || "")}`;
  const numberedDays = [...text.matchAll(/^###\s+(?:\d+\s*[·.-]\s*)?Day\s+\d+/gim)].length;
  const explicitPosts = [...text.matchAll(/\b(\d{1,2})\s+(?:posts?|publications?|captions?)\b/gi)].map((match) => Number(match[1] || 0));
  const weekly = text.match(/\b(\d{1,2}|one|two|three|four|five|six|seven)\s+posts?\s+(?:per|a|each)\s+week\b/i);
  const weeks = text.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[-\s]+week\b/i);
  const cadenceCount = weekly && weeks ? wordNumber(weekly[1]) * wordNumber(weeks[1]) : 0;
  return Math.min(45, Math.max(planCount, numberedDays, cadenceCount, ...explicitPosts, 0));
}

function wordNumber(value) {
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const normalized = String(value || "").toLowerCase();
  return Number(normalized) || words[normalized] || 0;
}

function normalizeDeliveryItems(values, channels, workspace, run = {}) {
  const candidates = campaignMedia(workspace);
  const allowedMedia = new Map(candidates.map((item) => [item.url, item]));
  const items = [];
  for (const value of Array.isArray(values) ? values : []) {
    const channel = String(value?.channel || "");
    if (!channels.includes(channel)) continue;
    const textLimit = channel === "x" ? 280 : channel === "linkedin" ? 3000 : channel === "gmail" ? 100_000 : channel === "shopify" ? 50_000 : channel === "discord" ? 2000 : channel === "reddit" ? 40_000 : channel === "youtube" ? 5000 : 2200;
    const rawText = String(value?.text || "").trim();
    if (!rawText) continue;
    const rawSubject = String(value?.subject || "");
    if (channel === "gmail" && unresolvedEmailPlaceholders(rawSubject, rawText).length) continue;
    const tracked = applyCampaignTracking(rawText, workspace, run, channel, items.length);
    const text = tracked.text.slice(0, textLimit).trim();
    if (!text) continue;
    let requestedMediaKind = value?.mediaKind === "video" ? "video" : "image";
    const channelAcceptsMedia = channel === "instagram" || channel === "tiktok" || channel === "discord" || channel === "shopify" || (channel === "youtube" && requestedMediaKind === "video") || (["linkedin", "x"].includes(channel) && requestedMediaKind === "image");
    const requestedAssetId = String(value?.sourceAssetId || "");
    let selectedMedia = channelAcceptsMedia && requestedAssetId
      ? candidates.find((item) => String(item.sourceAssetId || item.id || "") === requestedAssetId)
      : allowedMedia.get(String(value?.mediaUrl || ""));
    let mediaUrl = selectedMedia?.url || "";
    if (selectedMedia?.kind) requestedMediaKind = selectedMedia.kind;
    if (!mediaUrl && ["instagram", "tiktok", "youtube"].includes(channel)) {
      const fallback = candidates.find((item) => channel === "youtube" ? item.kind === "video" : item.kind === requestedMediaKind) || (channel === "youtube" ? null : candidates[0]);
      if (fallback) { selectedMedia = fallback; mediaUrl = fallback.url; requestedMediaKind = fallback.kind; }
    }
    if (["instagram", "tiktok", "youtube"].includes(channel) && !mediaUrl) continue;
    const recipient = channel === "gmail" ? validApprovedRecipient(value?.recipient, run) : "";
    if (channel === "gmail" && !recipient) continue;
    const subject = ["gmail", "reddit", "youtube", "shopify"].includes(channel) ? rawSubject.replace(/[\r\n]+/g, " ").trim().slice(0, channel === "youtube" ? 100 : channel === "shopify" ? 255 : 300) : "";
    if (["gmail", "reddit", "youtube", "shopify"].includes(channel) && !subject) continue;
    items.push({
      channel,
      recipient,
      subject,
      text,
      mediaUrl,
      sourceAssetId: mediaUrl ? String(selectedMedia?.sourceAssetId || selectedMedia?.id || "") : "",
      mediaKind: mediaUrl ? requestedMediaKind : "",
      privacyLevel: channel === "tiktok" ? "" : channel === "youtube" ? "private" : "",
      aiGenerated: Boolean(value?.aiGenerated),
      madeForKids: false,
      disableComment: channel === "tiktok",
      disableDuet: channel === "tiktok",
      disableStitch: channel === "tiktok",
      commercialContentToggle: false,
      brandOrganicToggle: false,
      brandContentToggle: false,
      musicConsent: false,
      scheduledAt: normalizeScheduledAt(value?.scheduledAt, items.length),
      tracking: tracked.tracking,
      rationale: String(value?.rationale || "Prepared from the approved run.").trim().slice(0, 1000),
    });
    if (items.length >= 45) break;
  }
  if (!items.length && channels.includes("instagram")) {
    const media = candidates[0];
    const text = approvedChannelCopy(run, "instagram", 2200);
    if (media && text) items.push({
      channel: "instagram",
      recipient: "",
      subject: "",
      text,
      mediaUrl: media.url,
      sourceAssetId: String(media.sourceAssetId || media.id || ""),
      mediaKind: media.kind,
      privacyLevel: "",
      aiGenerated: false,
      madeForKids: false,
      disableComment: false,
      disableDuet: false,
      disableStitch: false,
      commercialContentToggle: false,
      brandOrganicToggle: false,
      brandContentToggle: false,
      musicConsent: false,
      scheduledAt: normalizeScheduledAt("", 0),
      rationale: `Prepared from the approved Instagram campaign using the project asset “${String(media.name || "Campaign media").slice(0, 120)}”.`,
    });
  }
  return items;
}

function applyCampaignTracking(text, workspace, run, channel, index) {
  const website = validExternalMediaUrl(workspace?.website);
  const clickable = ["gmail", "linkedin", "x", "discord", "reddit", "youtube"].includes(channel);
  if (!website || !clickable) return { text, tracking: null };
  const target = new URL(website);
  const campaignId = String(run?.id || "market-agent").slice(0, 120);
  const campaignName = trackingSlug(run?.title || workspace?.name || "market-agent-campaign");
  target.searchParams.set("utm_id", campaignId);
  target.searchParams.set("utm_source", channel);
  target.searchParams.set("utm_medium", channel === "gmail" ? "email" : "organic_social");
  target.searchParams.set("utm_campaign", campaignName);
  target.searchParams.set("utm_content", `item-${index + 1}`);
  const trackedUrl = target.toString();
  let replaced = false;
  let result = text.replace(/https?:\/\/[^\s<>()\]]+/gi, (candidate) => {
    try {
      const clean = candidate.replace(/[.,;:!?]+$/, "");
      const parsed = new URL(clean);
      if (parsed.hostname.replace(/^www\./, "") !== target.hostname.replace(/^www\./, "")) return candidate;
      replaced = true;
      const suffix = candidate.slice(clean.length);
      return `${trackedUrl}${suffix}`;
    } catch {
      return candidate;
    }
  });
  const objective = String(workspace?.growth?.objective || inferTrackingObjective(workspace));
  if (!replaced && objective && objective !== "visibility") result = `${result}\n\n${trackedUrl}`;
  return {
    text: result,
    tracking: { url: trackedUrl, campaignId, campaignName, source: channel, medium: channel === "gmail" ? "email" : "organic_social", content: `item-${index + 1}` },
  };
}

function inferTrackingObjective(workspace) {
  const context = [workspace?.name, workspace?.description, workspace?.segmentation, workspace?.positioning, workspace?.audience, workspace?.valueProposition].filter(Boolean).join(" ").toLowerCase();
  if (/\b(shop|store|e-?commerce|retail|purchase|checkout)\b/.test(context)) return "sales";
  if (/\b(newsletter|publication|subscriber|mailing list)\b/.test(context)) return "newsletter";
  if (/\b(demo|saas|software|platform|agency|studio|consult|service|b2b|venue|operator|client)\b/.test(context)) return "leads";
  if (/\b(community|creator|followers|audience growth)\b/.test(context)) return "audience";
  return "visibility";
}

function trackingSlug(value) {
  return String(value || "campaign").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "campaign";
}

function campaignMedia(workspace) {
  const values = Array.isArray(workspace?.sourceMedia) ? workspace.sourceMedia : [];
  return values
    .filter((item) => item && ["image", "video"].includes(item.kind) && validExternalMediaUrl(item.url))
    .filter((item) => !/\b(logo|favicon|app icon|brand mark|wordmark)\b/i.test(`${item.name || ""} ${item.role || ""} ${Array.isArray(item.tags) ? item.tags.join(" ") : ""}`))
    .map((item) => ({ ...item, url: validExternalMediaUrl(item.url) }))
    .sort((left, right) => mediaRank(right) - mediaRank(left));
}

function mediaRank(item) {
  const recommendation = item?.recommendation === "reuse" ? 4 : item?.recommendation === "adapt" ? 2 : 0;
  const role = /\b(hero|campaign|editorial|photograph|social|product|work|portfolio)\b/i.test(`${item?.name || ""} ${item?.role || ""}`) ? 3 : 0;
  return recommendation + role + (item?.kind === "video" ? 1 : 0);
}

function approvedChannelCopy(run, channel, limit) {
  const output = String(run?.output || "").replace(/\r/g, "");
  const heading = new RegExp(`(?:^|\\n)(?:#{1,6}\\s*)?(?:\\*\\*)?${channel}(?:\\s+(?:post|caption|copy))?(?:\\*\\*)?\\s*[:—-]?\\s*\\n`, "i");
  const match = heading.exec(output);
  let source = match ? output.slice(match.index + match[0].length) : output;
  if (match) source = source.split(/\n(?=#{1,6}\s|\*\*[A-Z][^\n]{1,80}\*\*\s*$)/)[0];
  const cleaned = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*]\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned || /^\|.+\|$/m.test(cleaned.slice(0, 500))) return "";
  return cleaned.slice(0, limit).trim();
}

function mergeYouTubeApproval(payload, approval) {
  const privacyLevel = String(approval?.privacyLevel || payload?.privacyLevel || "private").trim();
  if (!["private", "unlisted", "public"].includes(privacyLevel)) throw deliveryError("Choose a YouTube visibility option before publishing.", 400);
  return { ...(payload || {}), privacyLevel, madeForKids: Boolean(approval?.madeForKids) };
}

function mergeTikTokApproval(payload, approval) {
  const privacyLevel = String(approval?.privacyLevel || "").trim();
  if (!/^(PUBLIC_TO_EVERYONE|MUTUAL_FOLLOW_FRIENDS|FOLLOWER_OF_CREATOR|SELF_ONLY)$/.test(privacyLevel)) {
    throw deliveryError("Choose an available TikTok visibility option before publishing.", 400);
  }
  const commercialContentToggle = Boolean(approval?.commercialContentToggle);
  const brandOrganicToggle = commercialContentToggle && Boolean(approval?.brandOrganicToggle);
  const brandContentToggle = commercialContentToggle && Boolean(approval?.brandContentToggle);
  if (commercialContentToggle && !brandOrganicToggle && !brandContentToggle) {
    throw deliveryError("Choose whether the TikTok post promotes your brand, another brand, or both.", 400);
  }
  if (!approval?.musicConsent) throw deliveryError("Confirm TikTok's music-use terms before approving this post.", 400);
  return {
    ...(payload || {}),
    privacyLevel,
    disableComment: Boolean(approval?.disableComment),
    disableDuet: Boolean(approval?.disableDuet),
    disableStitch: Boolean(approval?.disableStitch),
    commercialContentToggle,
    brandOrganicToggle,
    brandContentToggle,
    musicConsent: true,
  };
}

function normalizeScheduledAt(value, index = 0) {
  const parsed = new Date(String(value || ""));
  const minimum = Date.now() + 15 * 60_000;
  if (Number.isFinite(parsed.getTime()) && parsed.getTime() >= minimum && parsed.getTime() < Date.now() + 370 * 24 * 60 * 60_000) return parsed.toISOString();
  const fallback = new Date();
  fallback.setUTCDate(fallback.getUTCDate() + 1 + Math.floor(index / 2) * 2);
  fallback.setUTCHours(12, (index % 2) * 15, 0, 0);
  return fallback.toISOString();
}

function approvedScheduleDate(value, index = 0) {
  const scheduledAt = normalizeScheduledAt(value, index);
  if (new Date(scheduledAt).getTime() < Date.now() + 10 * 60_000) {
    throw deliveryError("Choose a campaign time at least ten minutes from now.", 400);
  }
  return scheduledAt;
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

export function validApprovedRecipient(value, run = {}) {
  const supplied = String(value || "").trim().toLowerCase();
  if (!/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(supplied)) return "";
  const approved = new Set(`${String(run?.prompt || "")}\n${String(run?.output || "")}`.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []);
  return approved.has(supplied) ? supplied : "";
}

async function ensureDeliveryTable(env) {
  if (deliveryTableReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_delivery_jobs (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('gmail','linkedin','instagram','tiktok','youtube','x','discord','reddit','shopify')),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('awaiting_approval','scheduled','running','submitted','complete','failed','cancelled')),
      external_id TEXT NOT NULL DEFAULT '', result JSONB NOT NULL DEFAULT '{}'::jsonb, error TEXT NOT NULL DEFAULT '',
      approved_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
      idempotency_key TEXT NOT NULL DEFAULT '', attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5, next_attempt_at TIMESTAMPTZ, dead_lettered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS market_agent_delivery_jobs_user_project_run_idx ON market_agent_delivery_jobs (user_id, project_id, run_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS market_agent_delivery_jobs_scheduled_idx ON market_agent_delivery_jobs (status);
    ALTER TABLE market_agent_delivery_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_delivery_jobs ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE market_agent_delivery_jobs ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 5;
    ALTER TABLE market_agent_delivery_jobs ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
    ALTER TABLE market_agent_delivery_jobs ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;
    CREATE UNIQUE INDEX IF NOT EXISTS market_agent_delivery_jobs_idempotency_uidx ON market_agent_delivery_jobs (user_id, idempotency_key) WHERE idempotency_key <> '';
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'market_agent_delivery_jobs'::regclass
          AND conname = 'market_agent_delivery_jobs_channel_check'
          AND pg_get_constraintdef(oid) NOT LIKE '%shopify%'
      ) THEN
        ALTER TABLE market_agent_delivery_jobs DROP CONSTRAINT market_agent_delivery_jobs_channel_check;
        ALTER TABLE market_agent_delivery_jobs ADD CONSTRAINT market_agent_delivery_jobs_channel_check
          CHECK (channel IN ('gmail','linkedin','instagram','tiktok','youtube','x','discord','reddit','shopify'));
      END IF;
    END $$;
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'market_agent_delivery_jobs'::regclass
          AND conname = 'market_agent_delivery_jobs_status_check'
          AND pg_get_constraintdef(oid) NOT LIKE '%dead_letter%'
      ) THEN
        ALTER TABLE market_agent_delivery_jobs DROP CONSTRAINT market_agent_delivery_jobs_status_check;
        ALTER TABLE market_agent_delivery_jobs ADD CONSTRAINT market_agent_delivery_jobs_status_check
          CHECK (status IN ('awaiting_approval','scheduled','running','submitted','complete','failed','dead_letter','cancelled'));
      END IF;
    END $$;
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
    attemptCount: Number(row.attempt_count || 0),
    maxAttempts: Number(row.max_attempts || 5),
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at).toISOString() : null,
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
