import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { generateNewsletterDraft } from "./agent.mjs";
import { getPool, loadStateForUser } from "./db.mjs";

let tablesReady = false;

export function mailchimpConnectorConfigured(env = process.env) {
  return Boolean(env.MAILCHIMP_CLIENT_ID && env.MAILCHIMP_CLIENT_SECRET && env.CONNECTION_ENCRYPTION_KEY);
}

export async function getMailchimpConnectionStatus(userId, projectId = "project-default", env = process.env) {
  const configured = mailchimpConnectorConfigured(env);
  if (!configured || !env.DATABASE_URL) return emptyStatus(configured);
  await ensureTables(env);
  const row = await readConnectionRow(userId, projectId, env);
  if (!row || row.status !== "connected") return emptyStatus(configured);
  let credentials;
  try {
    credentials = decryptCredentials(row.encrypted_credentials, env);
  } catch {
    return { ...emptyStatus(configured), connected: true, accountLabel: row.account_label || row.account_email || "Mailchimp account", connectedAt: row.connected_at || row.updated_at || null };
  }
  let audiences = Array.isArray(credentials.audiences) ? credentials.audiences : [];
  try {
    audiences = await fetchAudiences(credentials);
    credentials.audiences = audiences;
    if (credentials.audienceId && !audiences.some((item) => item.id === credentials.audienceId)) {
      credentials.audienceId = "";
      credentials.audienceName = "";
    }
    if (!credentials.audienceId && audiences.length === 1) {
      credentials.audienceId = audiences[0].id;
      credentials.audienceName = audiences[0].name;
    }
    await saveCredentials(userId, projectId, credentials, env);
  } catch {
    // Keep the last known audience list if Mailchimp is temporarily unavailable.
  }
  const selected = audiences.find((item) => item.id === credentials.audienceId);
  return {
    configured,
    connected: true,
    accountLabel: row.account_label || row.account_email || "Mailchimp account",
    accountEmail: row.account_email || "",
    audiences,
    audienceId: credentials.audienceId || "",
    audienceName: selected?.name || credentials.audienceName || "",
    connectedAt: row.connected_at || row.updated_at || null,
    canManage: Boolean(credentials.accessToken && credentials.serverPrefix && credentials.audienceId),
  };
}

export async function createMailchimpAuthorizationUrl({ userId, projectId, origin }, env = process.env) {
  requireConfigured(env);
  const redirectUri = `${normalizeOrigin(origin)}/api/mailchimp-callback`;
  const state = await new EncryptJWT({
    u: String(userId),
    j: String(projectId || "project-default"),
    r: redirectUri,
    n: randomBytes(18).toString("base64url"),
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .encrypt(connectionKey(env));
  const authorizationUrl = new URL("https://login.mailchimp.com/oauth2/authorize");
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: env.MAILCHIMP_CLIENT_ID,
    redirect_uri: redirectUri,
    state,
  }).toString();
  return authorizationUrl.toString();
}

export async function finishMailchimpAuthorization({ code, state }, env = process.env) {
  requireConfigured(env);
  if (!code || !state) throw newsletterError("Mailchimp did not return a complete authorization response.", 400);
  let payload;
  try {
    ({ payload } = await jwtDecrypt(state, connectionKey(env), { clockTolerance: 5 }));
  } catch {
    throw newsletterError("The Mailchimp connection request expired. Start the connection again.", 400);
  }
  const userId = String(payload.u || "");
  const projectId = String(payload.j || "project-default");
  const redirectUri = String(payload.r || "");
  if (!userId || !/^https?:\/\//i.test(redirectUri)) throw newsletterError("The Mailchimp connection request is invalid.", 400);

  const tokenResponse = await fetch("https://login.mailchimp.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.MAILCHIMP_CLIENT_ID,
      client_secret: env.MAILCHIMP_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code: String(code),
    }),
  });
  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.access_token) throw newsletterError(providerMessage(tokens, "Mailchimp could not finish authorization."), 400);

  const metadataResponse = await fetch("https://login.mailchimp.com/oauth2/metadata", {
    headers: { Authorization: `OAuth ${tokens.access_token}` },
  });
  const metadata = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok || (!metadata.dc && !metadata.api_endpoint)) throw newsletterError(providerMessage(metadata, "Mailchimp account details could not be read."), 400);
  const serverPrefix = String(metadata.dc || serverPrefixFromEndpoint(metadata.api_endpoint));
  const credentials = { accessToken: tokens.access_token, serverPrefix, audienceId: "", audienceName: "", audiences: [] };
  credentials.audiences = await fetchAudiences(credentials);
  if (credentials.audiences.length === 1) {
    credentials.audienceId = credentials.audiences[0].id;
    credentials.audienceName = credentials.audiences[0].name;
  }
  const accountEmail = String(metadata.login?.email || metadata.login?.login_name || "").toLowerCase();
  const accountLabel = String(metadata.accountname || metadata.login?.login_name || accountEmail || "Mailchimp account").slice(0, 320);
  await ensureTables(env);
  await getPool(env).query(
    `INSERT INTO market_agent_connections
      (user_id, project_id, provider, account_id, account_label, account_email, encrypted_credentials, scopes, status, connected_at, updated_at)
     VALUES ($1,$2,'mailchimp',$3,$4,$5,$6,ARRAY['audiences','campaigns','reports']::TEXT[],'connected',NOW(),NOW())
     ON CONFLICT (user_id, project_id, provider) DO UPDATE SET
       account_id = EXCLUDED.account_id, account_label = EXCLUDED.account_label, account_email = EXCLUDED.account_email,
       encrypted_credentials = EXCLUDED.encrypted_credentials, scopes = EXCLUDED.scopes, status = 'connected', connected_at = NOW(), updated_at = NOW()`,
    [userId, projectId, String(metadata.account_id || metadata.user_id || ""), accountLabel, accountEmail, encryptCredentials(credentials, env)],
  );
  return { userId, projectId, accountLabel, redirectUri, needsAudience: credentials.audiences.length !== 1 };
}

export async function selectMailchimpAudience(userId, projectId, audienceId, env = process.env) {
  const row = await requireConnection(userId, projectId, env);
  const credentials = decryptCredentials(row.encrypted_credentials, env);
  const audiences = await fetchAudiences(credentials);
  const selected = audiences.find((item) => item.id === String(audienceId || ""));
  if (!selected) throw newsletterError("Choose an audience that belongs to the connected Mailchimp account.", 400);
  credentials.audiences = audiences;
  credentials.audienceId = selected.id;
  credentials.audienceName = selected.name;
  await saveCredentials(userId, projectId, credentials, env);
  return getMailchimpConnectionStatus(userId, projectId, env);
}

export async function disconnectMailchimp(userId, projectId, env = process.env) {
  await ensureTables(env);
  await getPool(env).query(
    "DELETE FROM market_agent_connections WHERE user_id = $1 AND project_id = $2 AND provider = 'mailchimp'",
    [userId, projectId],
  );
}

export async function getNewsletterDashboard(userId, projectId, env = process.env) {
  await ensureTables(env);
  const { credentials } = await connectionCredentials(userId, projectId, env);
  const audienceId = requireAudience(credentials);
  const [audience, members, campaigns, local] = await Promise.all([
    mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}?fields=id,name,stats.member_count,stats.unsubscribe_count,stats.cleaned_count,stats.open_rate,stats.click_rate`),
    mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}/members?count=25&sort_field=timestamp_opt&sort_dir=DESC&fields=members.id,members.email_address,members.status,members.merge_fields,members.timestamp_opt,total_items`),
    mailchimpRequest(credentials, `/campaigns?list_id=${encodeURIComponent(audienceId)}&count=25&sort_field=create_time&sort_dir=DESC`),
    getPool(env).query("SELECT * FROM market_agent_newsletters WHERE user_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 40", [userId, projectId]),
  ]);
  const remoteCampaigns = await Promise.all((campaigns.campaigns || []).slice(0, 25).map(async (campaign) => {
    let report = null;
    if (campaign.status === "sent") {
      try { report = await mailchimpRequest(credentials, `/reports/${encodeURIComponent(campaign.id)}`); } catch { report = null; }
    }
    return serializeRemoteCampaign(campaign, report);
  }));
  return {
    audience: {
      id: String(audience.id || audienceId),
      name: String(audience.name || credentials.audienceName || "Audience"),
      memberCount: Number(audience.stats?.member_count || members.total_items || 0),
      unsubscribeCount: Number(audience.stats?.unsubscribe_count || 0),
      cleanedCount: Number(audience.stats?.cleaned_count || 0),
      openRate: Number(audience.stats?.open_rate || 0),
      clickRate: Number(audience.stats?.click_rate || 0),
    },
    members: (members.members || []).map(serializeMember),
    campaigns: remoteCampaigns,
    drafts: local.rows.map(serializeDraft),
    fetchedAt: new Date().toISOString(),
  };
}

export async function registerSubscriber(userId, projectId, input, env = process.env) {
  if (input?.consentConfirmed !== true) throw newsletterError("Confirm that this person requested the newsletter before registering them.", 400);
  const email = String(input?.email || "").trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw newsletterError("Enter a valid subscriber email address.", 400);
  const { credentials } = await connectionCredentials(userId, projectId, env);
  const audienceId = requireAudience(credentials);
  const memberId = createHash("md5").update(email).digest("hex");
  const member = await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}/members/${memberId}`, {
    method: "PUT",
    body: {
      email_address: email,
      status_if_new: "pending",
      merge_fields: {
        FNAME: cleanText(input?.firstName, 100),
        LNAME: cleanText(input?.lastName, 100),
      },
      tags: ["Market Agent"],
    },
  });
  return { member: serializeMember(member), message: member.status === "pending" ? "Confirmation email requested. The subscriber is not active until they confirm." : "Subscriber record updated without changing their consent status." };
}

export async function createNewsletterDraft(userId, projectId, direction, userApiEnv, env = process.env) {
  await ensureTables(env);
  const { credentials } = await connectionCredentials(userId, projectId, env);
  requireAudience(credentials);
  const { state } = await loadStateForUser(userId, env);
  const workspace = state.projects.find((item) => item.id === projectId);
  if (!workspace) throw newsletterError("The project could not be found.", 404);
  const approvedWork = state.runs.filter((run) => run.projectId === projectId && run.status === "Approved").slice(0, 5);
  const generated = await generateNewsletterDraft({ workspace, direction, approvedWork }, userApiEnv);
  const draft = normalizeDraft(generated, workspace);
  const html = renderNewsletterHtml(draft, workspace);
  const id = randomUUID();
  const result = await getPool(env).query(
    `INSERT INTO market_agent_newsletters (id,user_id,project_id,direction,draft,html,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,'draft',NOW(),NOW()) RETURNING *`,
    [id, userId, projectId, cleanText(direction, 12_000), JSON.stringify(draft), html],
  );
  return { draft: serializeDraft(result.rows[0]) };
}

export async function updateNewsletterDraft(userId, projectId, id, changes, env = process.env) {
  await ensureTables(env);
  const current = await getPool(env).query("SELECT * FROM market_agent_newsletters WHERE id = $1 AND user_id = $2 AND project_id = $3", [id, userId, projectId]);
  const row = current.rows[0];
  if (!row) throw newsletterError("The newsletter draft was not found.", 404);
  if (!['draft', 'failed'].includes(row.status)) throw newsletterError("A sent or scheduled newsletter can no longer be edited.", 409);
  const { state } = await loadStateForUser(userId, env);
  const workspace = state.projects.find((item) => item.id === projectId);
  const draft = normalizeDraft({ ...row.draft, ...changes }, workspace || {});
  const html = renderNewsletterHtml(draft, workspace || {});
  const result = await getPool(env).query(
    "UPDATE market_agent_newsletters SET draft = $4::jsonb, html = $5, status = 'draft', error = '', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND project_id = $3 RETURNING *",
    [id, userId, projectId, JSON.stringify(draft), html],
  );
  return { draft: serializeDraft(result.rows[0]) };
}

export async function deliverNewsletter(userId, projectId, id, mode, scheduleTime, env = process.env) {
  await ensureTables(env);
  const claim = await getPool(env).query(
    `UPDATE market_agent_newsletters SET status = 'preparing', error = '', approved_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND project_id = $3 AND status IN ('draft','failed') RETURNING *`,
    [id, userId, projectId],
  );
  const row = claim.rows[0];
  if (!row) throw newsletterError("This newsletter is no longer waiting for approval.", 409);
  try {
    const { row: connection, credentials } = await connectionCredentials(userId, projectId, env);
    const audienceId = requireAudience(credentials);
    const list = await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}`);
    const defaults = list.campaign_defaults || {};
    const replyTo = String(defaults.from_email || connection.account_email || "").trim();
    const fromName = String(defaults.from_name || connection.account_label || "").trim();
    if (!replyTo || !fromName) throw newsletterError("The selected Mailchimp audience needs a verified sender name and reply-to email before Market Agent can send.", 409);
    let campaignId = row.external_id || "";
    let campaign;
    if (!campaignId) {
      campaign = await mailchimpRequest(credentials, "/campaigns", {
        method: "POST",
        body: {
          type: "regular",
          recipients: { list_id: audienceId },
          settings: {
            subject_line: row.draft.subject,
            preview_text: row.draft.previewText,
            title: `Market Agent · ${row.draft.subject}`.slice(0, 255),
            from_name: fromName,
            reply_to: replyTo,
            auto_footer: true,
          },
          tracking: { opens: true, html_clicks: true, text_clicks: true },
        },
      });
      campaignId = String(campaign.id || "");
      if (!campaignId) throw newsletterError("Mailchimp did not create the campaign.", 502);
      await getPool(env).query("UPDATE market_agent_newsletters SET external_id = $4, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND project_id = $3", [id, userId, projectId, campaignId]);
    }
    await mailchimpRequest(credentials, `/campaigns/${encodeURIComponent(campaignId)}/content`, { method: "PUT", body: { html: row.html } });
    const checklist = await mailchimpRequest(credentials, `/campaigns/${encodeURIComponent(campaignId)}/send-checklist`);
    if (!checklist.is_ready) {
      const blocking = (checklist.items || []).filter((item) => item.type !== "success").map((item) => item.details || item.heading).filter(Boolean).slice(0, 4).join(" ");
      throw newsletterError(blocking || "Mailchimp's send checklist needs attention before this campaign can be sent.", 409);
    }
    let status;
    let scheduledFor = null;
    if (mode === "schedule") {
      scheduledFor = validScheduleTime(scheduleTime);
      await mailchimpRequest(credentials, `/campaigns/${encodeURIComponent(campaignId)}/actions/schedule`, { method: "POST", body: { schedule_time: scheduledFor } });
      status = "scheduled";
    } else {
      await mailchimpRequest(credentials, `/campaigns/${encodeURIComponent(campaignId)}/actions/send`, { method: "POST", expectEmpty: true });
      status = "sent";
    }
    const updated = await getPool(env).query(
      `UPDATE market_agent_newsletters SET status = $4, scheduled_for = $5, sent_at = CASE WHEN $4 = 'sent' THEN NOW() ELSE sent_at END,
       error = '', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND project_id = $3 RETURNING *`,
      [id, userId, projectId, status, scheduledFor],
    );
    return { draft: serializeDraft(updated.rows[0]) };
  } catch (error) {
    const updated = await getPool(env).query(
      "UPDATE market_agent_newsletters SET status = 'failed', error = $4, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND project_id = $3 RETURNING *",
      [id, userId, projectId, String(error?.message || "Mailchimp could not complete the approved action.").slice(0, 1200)],
    );
    if (updated.rows[0]) error.newsletter = serializeDraft(updated.rows[0]);
    throw error;
  }
}

async function connectionCredentials(userId, projectId, env) {
  const row = await requireConnection(userId, projectId, env);
  const credentials = decryptCredentials(row.encrypted_credentials, env);
  if (!credentials.accessToken || !credentials.serverPrefix) throw newsletterError("Reconnect Mailchimp to restore access.", 401);
  return { row, credentials };
}

async function requireConnection(userId, projectId, env) {
  await ensureTables(env);
  const row = await readConnectionRow(userId, projectId, env);
  if (!row || row.status !== "connected") throw newsletterError("Connect Mailchimp to this project first.", 409);
  return row;
}

async function readConnectionRow(userId, projectId, env) {
  const result = await getPool(env).query(
    "SELECT * FROM market_agent_connections WHERE user_id = $1 AND project_id = $2 AND provider = 'mailchimp' LIMIT 1",
    [userId, projectId],
  );
  return result.rows[0] || null;
}

async function fetchAudiences(credentials) {
  const data = await mailchimpRequest(credentials, "/lists?count=100&fields=lists.id,lists.name,lists.stats.member_count,total_items");
  return (data.lists || []).map((item) => ({ id: String(item.id || ""), name: String(item.name || "Audience"), memberCount: Number(item.stats?.member_count || 0) })).filter((item) => item.id);
}

async function mailchimpRequest(credentials, path, options = {}) {
  const url = `https://${credentials.serverPrefix}.api.mailchimp.com/3.0${path}`;
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.ok && (options.expectEmpty || response.status === 204)) return {};
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw newsletterError(providerMessage(data, "Mailchimp could not complete the request."), response.status === 401 ? 401 : response.status === 400 ? 400 : 502);
  return data;
}

async function saveCredentials(userId, projectId, credentials, env) {
  await getPool(env).query(
    "UPDATE market_agent_connections SET encrypted_credentials = $3, updated_at = NOW() WHERE user_id = $1 AND project_id = $2 AND provider = 'mailchimp'",
    [userId, projectId, encryptCredentials(credentials, env)],
  );
}

async function ensureTables(env) {
  if (tablesReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_connections (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'project-default', provider TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '', account_label TEXT NOT NULL DEFAULT '', account_email TEXT NOT NULL DEFAULT '',
      encrypted_credentials TEXT NOT NULL, scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], status TEXT NOT NULL DEFAULT 'connected',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, project_id, provider)
    );
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_label TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_email TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_connections DROP CONSTRAINT IF EXISTS market_agent_connections_pkey;
    CREATE UNIQUE INDEX IF NOT EXISTS market_agent_connections_user_project_provider_uidx ON market_agent_connections (user_id, project_id, provider);
    CREATE TABLE IF NOT EXISTS market_agent_newsletters (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, direction TEXT NOT NULL DEFAULT '',
      draft JSONB NOT NULL DEFAULT '{}'::jsonb, html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','preparing','scheduled','sent','failed')),
      external_id TEXT NOT NULL DEFAULT '', archive_url TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      approved_at TIMESTAMPTZ, scheduled_for TIMESTAMPTZ, sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS market_agent_newsletters_user_project_idx ON market_agent_newsletters (user_id, project_id, created_at DESC);
  `);
  tablesReady = true;
}

function normalizeDraft(value, workspace) {
  const safeUrl = safeCtaUrl(value?.ctaUrl, workspace);
  return {
    subject: cleanHeader(value?.subject, 100) || `An update from ${cleanHeader(workspace?.name, 70) || "our team"}`,
    previewText: cleanHeader(value?.previewText, 150),
    headline: cleanText(value?.headline, 180),
    introduction: cleanText(value?.introduction, 2_000),
    sections: (Array.isArray(value?.sections) ? value.sections : []).slice(0, 4).map((section) => ({ heading: cleanText(section?.heading, 180), body: cleanText(section?.body, 3_000) })).filter((section) => section.heading || section.body),
    ctaLabel: safeUrl ? cleanHeader(value?.ctaLabel, 80) || "Learn more" : "",
    ctaUrl: safeUrl,
    closing: cleanText(value?.closing, 1_000),
  };
}

function safeCtaUrl(value, workspace) {
  const candidate = String(value || "").trim();
  const supplied = [workspace?.website, ...(Array.isArray(workspace?.sources) ? workspace.sources.map((item) => item?.url) : [])].filter(Boolean);
  if (!candidate) return normalizeHttpUrl(workspace?.website);
  const normalized = normalizeHttpUrl(candidate);
  if (!normalized) return normalizeHttpUrl(workspace?.website);
  try {
    const hostname = new URL(normalized).hostname.replace(/^www\./, "");
    const allowed = supplied.some((url) => {
      try { const suppliedHost = new URL(normalizeHttpUrl(url)).hostname.replace(/^www\./, ""); return hostname === suppliedHost || hostname.endsWith(`.${suppliedHost}`); } catch { return false; }
    });
    return allowed ? normalized : normalizeHttpUrl(workspace?.website);
  } catch { return ""; }
}

function renderNewsletterHtml(draft, workspace) {
  const primary = safeColor(workspace?.brand?.primaryColor, "#5b3fd0");
  const background = safeColor(workspace?.brand?.neutralLightColor, "#f6f5f2");
  const text = safeColor(workspace?.brand?.neutralDarkColor, "#202020");
  const name = escapeHtml(workspace?.name || "Newsletter");
  const sections = draft.sections.map((section) => `<tr><td style="padding:0 34px 24px"><h2 style="margin:0 0 8px;font:700 20px/1.25 Arial,sans-serif;color:${text}">${escapeHtml(section.heading)}</h2><p style="margin:0;font:400 16px/1.6 Arial,sans-serif;color:${text}">${paragraphs(section.body)}</p></td></tr>`).join("");
  const button = draft.ctaUrl ? `<tr><td style="padding:2px 34px 30px"><a href="${escapeAttribute(draft.ctaUrl)}" style="display:inline-block;padding:13px 20px;background:${primary};color:#ffffff;text-decoration:none;border-radius:7px;font:700 15px Arial,sans-serif">${escapeHtml(draft.ctaLabel)}</a></td></tr>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(draft.subject)}</title></head><body style="margin:0;padding:0;background:${background}"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(draft.previewText)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${background};padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden"><tr><td style="height:8px;background:${primary}"></td></tr><tr><td style="padding:28px 34px 14px"><div style="font:700 13px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${primary}">${name}</div><h1 style="margin:14px 0 12px;font:700 34px/1.15 Arial,sans-serif;color:${text}">${escapeHtml(draft.headline)}</h1><p style="margin:0;font:400 17px/1.6 Arial,sans-serif;color:${text}">${paragraphs(draft.introduction)}</p></td></tr>${sections}${button}<tr><td style="padding:0 34px 28px"><p style="margin:0;font:400 15px/1.6 Arial,sans-serif;color:${text}">${paragraphs(draft.closing)}</p></td></tr><tr><td style="padding:20px 34px;background:#f2f1ee;font:400 12px/1.5 Arial,sans-serif;color:#666">You are receiving this because you subscribed to updates from ${name}.<br>*|LIST:DESCRIPTION|*<br><a href="*|UNSUB|*" style="color:#555">Unsubscribe</a> · <a href="*|UPDATE_PROFILE|*" style="color:#555">Update preferences</a><br>*|HTML:LIST_ADDRESS_HTML|*</td></tr></table></td></tr></table></body></html>`;
}

function serializeDraft(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    direction: row.direction || "",
    content: row.draft || {},
    html: row.html || "",
    status: row.status,
    externalId: row.external_id || "",
    archiveUrl: row.archive_url || "",
    error: row.error || "",
    approvedAt: iso(row.approved_at),
    scheduledFor: iso(row.scheduled_for),
    sentAt: iso(row.sent_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function serializeMember(member) {
  return {
    id: String(member.id || ""),
    email: String(member.email_address || ""),
    firstName: String(member.merge_fields?.FNAME || ""),
    lastName: String(member.merge_fields?.LNAME || ""),
    status: String(member.status || ""),
    confirmedAt: member.timestamp_opt || null,
  };
}

function serializeRemoteCampaign(campaign, report) {
  return {
    id: String(campaign.id || ""),
    title: String(campaign.settings?.title || campaign.settings?.subject_line || "Newsletter"),
    subject: String(campaign.settings?.subject_line || report?.subject_line || ""),
    status: String(campaign.status || ""),
    archiveUrl: String(campaign.archive_url || ""),
    sendTime: campaign.send_time || report?.send_time || null,
    emailsSent: Number(report?.emails_sent || campaign.emails_sent || 0),
    uniqueOpens: Number(report?.opens?.unique_opens || campaign.report_summary?.unique_opens || 0),
    openRate: Number(report?.opens?.open_rate || campaign.report_summary?.open_rate || 0),
    uniqueClicks: Number(report?.clicks?.unique_clicks || campaign.report_summary?.subscriber_clicks || 0),
    clickRate: Number(report?.clicks?.click_rate || campaign.report_summary?.click_rate || 0),
    unsubscribed: Number(report?.unsubscribed || 0),
    bounces: Number((report?.bounces?.hard_bounces || 0) + (report?.bounces?.soft_bounces || 0)),
  };
}

function requireAudience(credentials) {
  if (!credentials.audienceId) throw newsletterError("Choose a Mailchimp audience for this project first.", 409);
  return credentials.audienceId;
}

function validScheduleTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() < Date.now() + 10 * 60_000) throw newsletterError("Choose a delivery time at least ten minutes from now.", 400);
  if (![0, 15, 30, 45].includes(date.getUTCMinutes()) || date.getUTCSeconds() !== 0) throw newsletterError("Scheduled delivery must use a quarter-hour time (:00, :15, :30, or :45).", 400);
  return date.toISOString();
}

function encryptCredentials(credentials, env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", connectionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
}

function decryptCredentials(value, env) {
  const [ivValue, tagValue, encryptedValue] = String(value || "").split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Invalid encrypted credentials");
  const decipher = createDecipheriv("aes-256-gcm", connectionKey(env), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

function connectionKey(env) {
  const secret = String(env.CONNECTION_ENCRYPTION_KEY || "");
  if (secret.length < 32) throw newsletterError("Secure connection storage is not configured.", 503);
  return createHash("sha256").update(secret).digest();
}

function emptyStatus(configured) {
  return { configured, connected: false, accountLabel: "", accountEmail: "", audiences: [], audienceId: "", audienceName: "", connectedAt: null, canManage: false };
}

function requireConfigured(env) {
  if (!mailchimpConnectorConfigured(env)) throw newsletterError("Mailchimp authorization is not configured yet.", 503);
}

function serverPrefixFromEndpoint(value) {
  try { return new URL(value).hostname.split(".")[0]; } catch { return ""; }
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw newsletterError("The application address is invalid.", 400);
  return url.origin;
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return /^https?:$/.test(url.protocol) ? url.toString() : "";
  } catch { return ""; }
}

function providerMessage(data, fallback) {
  return String(data?.detail || data?.title || data?.error_description || data?.error || fallback).slice(0, 1200);
}

function cleanHeader(value, maximum) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, maximum);
}

function cleanText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function safeColor(value, fallback) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value) : fallback;
}

function paragraphs(value) {
  return escapeHtml(value).replace(/\n\n+/g, "</p><p style=\"margin:12px 0 0\">").replace(/\n/g, "<br>");
}

function escapeHtml(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function newsletterError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
