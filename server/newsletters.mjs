import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { del, get } from "@vercel/blob";
import { EncryptJWT, jwtDecrypt } from "jose";
import { generateNewsletterDraft, generateProspectConversionCampaign } from "./agent.mjs";
import { getPool, loadStateForUser } from "./db.mjs";
import { newsletterDraftPlaceholders } from "./email-content.mjs";

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
  const redirectUri = `${normalizeOrigin(env.MAILCHIMP_REDIRECT_BASE_URL || origin)}/api/mailchimp-callback`;
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
  await migrateLegacyContactAssets(userId, projectId, env);
  const [local, contactImports, optinCampaigns] = await Promise.all([
    getPool(env).query("SELECT * FROM market_agent_newsletters WHERE user_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 40", [userId, projectId]),
    getPool(env).query("SELECT * FROM market_agent_contact_imports WHERE user_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 30", [userId, projectId]),
    getPool(env).query("SELECT * FROM market_agent_optin_campaigns WHERE user_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 10", [userId, projectId]),
  ]);
  let audience = { id: "", name: "Market Agent contacts", stats: {}, subscribe_url_short: "", subscribe_url_long: "" };
  let members = { members: [], total_items: 0 };
  let campaigns = { campaigns: [] };
  let remoteCampaigns = [];
  let audienceSignupUrl = "";
  try {
    const { credentials } = await connectionCredentials(userId, projectId, env);
    const audienceId = requireAudience(credentials);
    [audience, members, campaigns] = await Promise.all([
      mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}?fields=id,name,subscribe_url_short,subscribe_url_long,stats.member_count,stats.unsubscribe_count,stats.cleaned_count,stats.open_rate,stats.click_rate`),
      fetchAudienceMembers(credentials, audienceId),
      mailchimpRequest(credentials, `/campaigns?list_id=${encodeURIComponent(audienceId)}&count=25&sort_field=create_time&sort_dir=DESC`),
    ]);
    await syncSubscriberRegistry(userId, projectId, members.members || [], env);
    audienceSignupUrl = await resolveMailchimpSignupUrl(credentials, audienceId, audience, false);
    try { await ensureMailchimpWebhook(userId, projectId, credentials, audienceId, env); } catch { /* A manual refresh still keeps subscriber states synchronized. */ }
    remoteCampaigns = await Promise.all((campaigns.campaigns || []).slice(0, 25).map(async (campaign) => {
      let report = null;
      if (campaign.status === "sent") {
        try { report = await mailchimpRequest(credentials, `/reports/${encodeURIComponent(campaign.id)}`); } catch { report = null; }
      }
      return serializeRemoteCampaign(campaign, report);
    }));
  } catch {
    // Campaign planning, contact staging, and newsletter creation remain available
    // inside Market Agent before a delivery service is connected.
  }
  const [registry, registryCounts, settings] = await Promise.all([
    getPool(env).query("SELECT * FROM market_agent_subscribers WHERE user_id = $1 AND project_id = $2 ORDER BY updated_at DESC LIMIT 12", [userId, projectId]),
    getPool(env).query(`SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
      COUNT(*) FILTER (WHERE status = 'unsubscribed')::int AS unsubscribed,
      COUNT(*) FILTER (WHERE status = 'bounced')::int AS bounced
      FROM market_agent_subscribers WHERE user_id = $1 AND project_id = $2`, [userId, projectId]),
    getNewsletterSettings(userId, projectId, env),
  ]);
  let workspace = {};
  try {
    const loaded = await loadStateForUser(userId, env);
    workspace = loaded.state.projects.find((item) => item.id === projectId) || {};
  } catch { /* Existing drafts remain readable if project context is temporarily unavailable. */ }
  const hydratedDrafts = await Promise.all(local.rows.map(async (row) => {
    const draft = normalizeDraft(row.draft || {}, workspace);
    draft.issues = newsletterDraftIssues(draft, workspace);
    const html = renderNewsletterHtml(draft, workspace);
    if (JSON.stringify(draft) !== JSON.stringify(row.draft || {}) || html !== row.html) {
      await getPool(env).query("UPDATE market_agent_newsletters SET draft = $4::jsonb, html = $5, updated_at = NOW() WHERE id = $1 AND user_id = $2 AND project_id = $3", [row.id, userId, projectId, JSON.stringify(draft), html]).catch(() => undefined);
    }
    return serializeDraft({ ...row, draft, html });
  }));
  return {
    audience: {
      id: String(audience.id || ""),
      name: String(audience.name || "Market Agent contacts"),
      memberCount: Number(audience.stats?.member_count || members.total_items || 0),
      unsubscribeCount: Number(audience.stats?.unsubscribe_count || 0),
      cleanedCount: Number(audience.stats?.cleaned_count || 0),
      openRate: Number(audience.stats?.open_rate || 0),
      clickRate: Number(audience.stats?.click_rate || 0),
      signupUrl: audienceSignupUrl || signupFormUrlFromResponses(audience),
    },
    members: (members.members || []).map(serializeMember),
    campaigns: remoteCampaigns,
    drafts: hydratedDrafts,
    contactImports: contactImports.rows.map(serializeContactImport),
    conversionCampaigns: optinCampaigns.rows.map((row) => serializeOptinCampaign(row, env, workspace)),
    subscriberRegistry: {
      counts: normalizeSubscriberCounts(registryCounts.rows[0]),
      preview: registry.rows.map(serializeSubscriber),
    },
    welcome: settings,
    fetchedAt: new Date().toISOString(),
  };
}

export async function getNewsletterActionContext(userId, projectId, options = {}, env = process.env) {
  await ensureTables(env);
  const selectedNewsletterId = String(options?.newsletterId || "").slice(0, 200);
  const [draftResult, campaignResult] = await Promise.all([
    getPool(env).query(
      `SELECT * FROM market_agent_newsletters
       WHERE user_id = $1 AND project_id = $2 AND status IN ('draft','failed')
         AND ($3 = '' OR id = $3)
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      [userId, projectId, selectedNewsletterId],
    ),
    getPool(env).query(
      `SELECT * FROM market_agent_optin_campaigns
       WHERE user_id = $1 AND project_id = $2
       ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      [userId, projectId],
    ),
  ]);
  let workspace = {};
  try {
    const loaded = await loadStateForUser(userId, env);
    workspace = loaded.state.projects.find((item) => item.id === projectId) || {};
  } catch { /* The editable records remain available without workspace enrichment. */ }
  return {
    newsletter: draftResult.rows[0] ? serializeDraft(draftResult.rows[0]) : null,
    invitation: campaignResult.rows[0] ? serializeOptinCampaign(campaignResult.rows[0], env, workspace) : null,
  };
}

export async function stageContactImport(userId, projectId, input, env = process.env) {
  await ensureTables(env);
  const parsed = parseContactCsv(input?.text);
  const id = randomUUID();
  const result = await getPool(env).query(
    `INSERT INTO market_agent_contact_imports
      (id,user_id,project_id,source_name,status,contacts,column_map,total_count,valid_count,invalid_count,duplicate_count,consented_count,unknown_count,denied_count,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'staged',$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW()) RETURNING *`,
    [id, userId, projectId, cleanHeader(input?.name, 240) || "Contact list.csv", JSON.stringify(parsed.contacts), JSON.stringify(parsed.columnMap), parsed.totalCount, parsed.validCount, parsed.invalidCount, parsed.duplicateCount, parsed.consentedCount, parsed.unknownCount, parsed.deniedCount],
  );
  return { contactImport: serializeContactImport(result.rows[0]) };
}

export async function getContactImportDetails(userId, projectId, input, env = process.env) {
  await ensureTables(env);
  const result = await getPool(env).query(
    "SELECT id,source_name,contacts FROM market_agent_contact_imports WHERE id = $1 AND user_id = $2 AND project_id = $3 LIMIT 1",
    [String(input?.id || ""), userId, projectId],
  );
  const row = result.rows[0];
  if (!row) throw newsletterError("The contact list was not found.", 404);
  const search = String(input?.search || "").trim().toLowerCase().slice(0, 180);
  const offset = Math.max(0, Number.parseInt(input?.offset, 10) || 0);
  const limit = Math.min(100, Math.max(10, Number.parseInt(input?.limit, 10) || 50));
  const all = (Array.isArray(row.contacts) ? row.contacts : []).filter((contact) => {
    if (!search) return true;
    return `${contact.firstName || ""} ${contact.lastName || ""} ${contact.email || ""} ${contact.company || ""}`.toLowerCase().includes(search);
  });
  return {
    id: row.id,
    sourceName: row.source_name || "Contact list.csv",
    total: all.length,
    offset,
    limit,
    contacts: all.slice(offset, offset + limit).map((contact) => ({
      email: String(contact.email || ""),
      firstName: String(contact.firstName || ""),
      lastName: String(contact.lastName || ""),
      company: String(contact.company || ""),
      consent: ["confirmed", "denied"].includes(contact.consent) ? contact.consent : "unknown",
    })),
  };
}

export async function getSubscriberDetails(userId, projectId, input, env = process.env) {
  await ensureTables(env);
  const search = String(input?.search || "").trim().toLowerCase().slice(0, 180);
  const status = ["pending", "confirmed", "unsubscribed", "bounced"].includes(input?.status) ? input.status : "";
  const offset = Math.max(0, Number.parseInt(input?.offset, 10) || 0);
  const limit = Math.min(100, Math.max(10, Number.parseInt(input?.limit, 10) || 50));
  const values = [userId, projectId];
  let where = "user_id = $1 AND project_id = $2";
  if (status) { values.push(status); where += ` AND status = $${values.length}`; }
  if (search) { values.push(`%${search}%`); where += ` AND LOWER(email || ' ' || first_name || ' ' || last_name || ' ' || company) LIKE $${values.length}`; }
  const count = await getPool(env).query(`SELECT COUNT(*)::int AS total FROM market_agent_subscribers WHERE ${where}`, values);
  values.push(limit, offset);
  const rows = await getPool(env).query(`SELECT * FROM market_agent_subscribers WHERE ${where} ORDER BY updated_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
  return { total: Number(count.rows[0]?.total || 0), offset, limit, subscribers: rows.rows.map(serializeSubscriber) };
}

export async function updateNewsletterSettings(userId, projectId, input, env = process.env) {
  await ensureTables(env);
  if (input?.approvalConfirmed !== true) throw newsletterError("Approve the welcome automation before changing it.", 400);
  const enabled = input?.enabled === true;
  const subject = cleanHeader(input?.subject, 180);
  const body = cleanText(input?.body, 12_000);
  if (enabled && (!subject || !body)) throw newsletterError("The welcome email needs a subject and message.", 400);
  await getPool(env).query(
    `INSERT INTO market_agent_newsletter_settings
      (user_id,project_id,welcome_enabled,welcome_subject,welcome_body,welcome_enabled_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,CASE WHEN $3 THEN NOW() ELSE NULL END,NOW(),NOW())
     ON CONFLICT (user_id,project_id) DO UPDATE SET
       welcome_enabled = EXCLUDED.welcome_enabled,
       welcome_subject = EXCLUDED.welcome_subject,
       welcome_body = EXCLUDED.welcome_body,
       welcome_enabled_at = CASE
         WHEN EXCLUDED.welcome_enabled AND NOT market_agent_newsletter_settings.welcome_enabled THEN NOW()
         WHEN NOT EXCLUDED.welcome_enabled THEN NULL
         ELSE market_agent_newsletter_settings.welcome_enabled_at END,
       updated_at = NOW()`,
    [userId, projectId, enabled, subject, body],
  );
  return { welcome: await getNewsletterSettings(userId, projectId, env) };
}

async function migrateLegacyContactAssets(userId, projectId, env) {
  const candidates = await getPool(env).query(
    `SELECT id,name,blob_path FROM market_agent_project_assets
      WHERE user_id = $1 AND project_id = $2 AND status = 'ready' AND blob_path <> ''
        AND (LOWER(name) LIKE '%.csv' OR LOWER(mime_type) LIKE '%csv%')
        AND LOWER(name) ~ '(contact|subscriber|audience|lead|prospect)'
      ORDER BY created_at DESC LIMIT 5`,
    [userId, projectId],
  ).catch(() => ({ rows: [] }));
  for (const asset of candidates.rows) {
    try {
      const blob = await get(asset.blob_path, { access: "private" });
      if (!blob || blob.statusCode !== 200 || !blob.stream) continue;
      const text = (await new Response(blob.stream).text()).slice(0, 1_000_000);
      const parsed = parseContactCsv(text);
      const inserted = await getPool(env).query(
        `INSERT INTO market_agent_contact_imports
          (id,user_id,project_id,source_asset_id,source_name,status,contacts,column_map,total_count,valid_count,invalid_count,duplicate_count,consented_count,unknown_count,denied_count,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,'staged',$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
         ON CONFLICT (source_asset_id) WHERE source_asset_id <> '' DO NOTHING RETURNING id`,
        [randomUUID(), userId, projectId, asset.id, asset.name, JSON.stringify(parsed.contacts), JSON.stringify(parsed.columnMap), parsed.totalCount, parsed.validCount, parsed.invalidCount, parsed.duplicateCount, parsed.consentedCount, parsed.unknownCount, parsed.deniedCount],
      );
      if (!inserted.rows[0]) continue;
      await getPool(env).query("DELETE FROM market_agent_project_assets WHERE id = $1 AND user_id = $2", [asset.id, userId]);
      try { await del(asset.blob_path); } catch { /* The contact record is safely moved even if blob cleanup is delayed. */ }
    } catch {
      // Non-contact CSVs remain untouched in the Content Library.
    }
  }
}

export async function importContactList(userId, projectId, input, env = process.env) {
  if (input?.approvalConfirmed !== true) throw newsletterError("Approve the contact import before changing the delivery audience.", 400);
  await ensureTables(env);
  const result = await getPool(env).query(
    "SELECT * FROM market_agent_contact_imports WHERE id = $1 AND user_id = $2 AND project_id = $3 LIMIT 1",
    [String(input?.id || ""), userId, projectId],
  );
  const row = result.rows[0];
  if (!row) throw newsletterError("The staged contact list was not found.", 404);
  const mode = input?.mode === "confirmed" ? "confirmed" : "";
  if (!mode) throw newsletterError("Contacts with unknown permission must use the public opt-in campaign. Only contacts already marked as consented can be imported.", 400);
  const contacts = (Array.isArray(row.contacts) ? row.contacts : []).filter((contact) => contact.consent === "confirmed");
  if (!contacts.length) throw newsletterError("This file has no contacts marked with confirmed newsletter permission.", 409);
  const { credentials } = await connectionCredentials(userId, projectId, env);
  const audienceId = requireAudience(credentials);
  await getPool(env).query("UPDATE market_agent_contact_imports SET status = 'importing', error = '', updated_at = NOW() WHERE id = $1", [row.id]);
  let importedCount = 0;
  let failedCount = 0;
  for (const contact of contacts) {
    try {
      const memberId = createHash("md5").update(contact.email).digest("hex");
      await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}/members/${memberId}`, {
        method: "PUT",
        body: {
          email_address: contact.email,
          status_if_new: "subscribed",
          status: "subscribed",
          merge_fields: { FNAME: contact.firstName || "", LNAME: contact.lastName || "" },
          tags: ["Market Agent"],
        },
      });
      await upsertSubscriber(userId, projectId, {
        email: contact.email,
        firstName: contact.firstName,
        lastName: contact.lastName,
        company: contact.company,
        status: "confirmed",
        remoteId: memberId,
        confirmedAt: new Date().toISOString(),
      }, env);
      importedCount += 1;
    } catch {
      failedCount += 1;
    }
  }
  const status = failedCount ? (importedCount ? "partial" : "failed") : "imported";
  const error = failedCount ? `${failedCount} contact${failedCount === 1 ? "" : "s"} could not be registered.` : "";
  const updated = await getPool(env).query(
    "UPDATE market_agent_contact_imports SET status = $2, import_mode = $3, imported_count = $4, failed_count = $5, error = $6, updated_at = NOW() WHERE id = $1 RETURNING *",
    [row.id, status, mode, importedCount, failedCount, error],
  );
  return {
    contactImport: serializeContactImport(updated.rows[0]),
    message: `${importedCount} consented contact${importedCount === 1 ? " was" : "s were"} added to the delivery audience.`,
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
  await upsertSubscriber(userId, projectId, {
    email,
    firstName: cleanText(input?.firstName, 100),
    lastName: cleanText(input?.lastName, 100),
    status: mapMailchimpStatus(member.status),
    remoteId: member.id || memberId,
    confirmedAt: member.timestamp_opt || null,
  }, env);
  return { member: serializeMember(member), message: member.status === "pending" ? "Confirmation email requested. The subscriber is not active until they confirm." : "Subscriber record updated without changing their consent status." };
}

export async function processMailchimpWebhook(token, input, env = process.env) {
  await ensureTables(env);
  const identity = verifyWebhookToken(token, env);
  const event = normalizeWebhookEvent(input);
  if (!event.email || (event.listId && event.listId !== identity.audienceId)) return { accepted: true };
  const status = ({ subscribe: "confirmed", unsubscribe: "unsubscribed", cleaned: "bounced" })[event.type];
  if (!status) return { accepted: true };
  await upsertSubscriber(identity.userId, identity.projectId, {
    email: event.email,
    firstName: event.firstName,
    lastName: event.lastName,
    status,
    remoteId: event.remoteId,
    confirmedAt: status === "confirmed" ? new Date().toISOString() : null,
  }, env);
  let welcome = null;
  if (status === "confirmed") welcome = await claimSubscriberWelcome(identity.userId, identity.projectId, event.email, event.firstName, env);
  return { accepted: true, userId: identity.userId, projectId: identity.projectId, welcome };
}

export async function completeSubscriberWelcome(userId, projectId, email, error = "", env = process.env) {
  await ensureTables(env);
  await getPool(env).query(
    `UPDATE market_agent_subscribers SET welcome_status = $4, welcome_error = $5,
      welcome_sent_at = CASE WHEN $4 = 'sent' THEN NOW() ELSE NULL END, updated_at = NOW()
      WHERE user_id = $1 AND project_id = $2 AND email = $3`,
    [userId, projectId, String(email || "").toLowerCase(), error ? "failed" : "sent", cleanText(error, 1000)],
  );
}

export async function createNewsletterDraft(userId, projectId, direction, userApiEnv, env = process.env) {
  await ensureTables(env);
  const { state } = await loadStateForUser(userId, env);
  const workspace = state.projects.find((item) => item.id === projectId);
  if (!workspace) throw newsletterError("The project could not be found.", 404);
  const approvedWork = state.runs.filter((run) => run.projectId === projectId && run.status === "Approved").slice(0, 5);
  const generated = await generateNewsletterDraft({ workspace, direction, approvedWork }, userApiEnv);
  const id = randomUUID();
  const draft = normalizeDraft(generated, workspace);
  draft.issues = newsletterDraftIssues(draft, workspace);
  draft.ctaUrl = trackedNewsletterUrl(draft.ctaUrl, id, draft.subject);
  const html = renderNewsletterHtml(draft, workspace);
  const result = await getPool(env).query(
    `INSERT INTO market_agent_newsletters (id,user_id,project_id,direction,draft,html,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,'draft',NOW(),NOW()) RETURNING *`,
    [id, userId, projectId, cleanText(direction, 12_000), JSON.stringify(draft), html],
  );
  return { draft: serializeDraft(result.rows[0]) };
}

export async function createOptinCampaign(userId, projectId, direction, userApiEnv, env = process.env) {
  await ensureTables(env);
  const { state } = await loadStateForUser(userId, env);
  const workspace = state.projects.find((item) => item.id === projectId);
  if (!workspace) throw newsletterError("The project could not be found.", 404);
  let signupUrl = "";
  try {
    const { credentials } = await connectionCredentials(userId, projectId, env);
    const audienceId = requireAudience(credentials);
    const audience = await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}?fields=id,name,subscribe_url_short,subscribe_url_long`);
    signupUrl = await resolveMailchimpSignupUrl(credentials, audienceId, audience, true);
  } catch {
    // Invitations can point to the project or another action without a newsletter connection.
  }
  const prospectResult = await getPool(env).query(
    "SELECT COALESCE(SUM(unknown_count),0)::int AS count FROM market_agent_contact_imports WHERE user_id = $1 AND project_id = $2",
    [userId, projectId],
  );
  const prospectCount = Number(prospectResult.rows[0]?.count || 0);
  const generated = await generateProspectConversionCampaign({ workspace, direction, prospectCount }, userApiEnv);
  const id = randomUUID();
  const publicToken = randomBytes(24).toString("base64url");
  const publicUrl = `${applicationOrigin(env)}/join/${encodeURIComponent(publicToken)}`;
  const invitationStrategy = generated?.invitationStrategy === "direct_signup" && signupUrl ? "direct_signup" : "project_first";
  const invitationUrl = invitationStrategy === "direct_signup" ? publicUrl : safeInvitationUrl(workspace.website, publicUrl);
  const result = await getPool(env).query(
    `INSERT INTO market_agent_optin_campaigns
      (id,user_id,project_id,public_token,status,eyebrow,title,description,cta_label,privacy_note,promotion_text,invitation_subject,invitation_body,invitation_strategy,invitation_cta_label,invitation_url,signup_url,logo_url,primary_color,background_color,text_color,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,NOW(),NOW()) RETURNING *`,
    [
      id,
      userId,
      projectId,
      publicToken,
      cleanHeader(generated?.eyebrow, 80) || "NEWSLETTER",
      cleanHeader(generated?.title, 180) || `Updates from ${cleanHeader(workspace.name, 100) || "this project"}`,
      cleanText(generated?.description, 1_200),
      cleanHeader(generated?.ctaLabel, 80) || "Subscribe",
      cleanText(generated?.privacyNote, 400) || "Confirm your email to subscribe. Unsubscribe at any time.",
      cleanText(generated?.promotionText, 2_000),
      cleanHeader(generated?.invitationSubject, 180) || `An invitation from ${cleanHeader(workspace.name, 100) || "our team"}`,
      normalizeInvitationBody(generated?.invitationBody, workspace),
      invitationStrategy,
      cleanHeader(generated?.invitationCtaLabel, 80) || (invitationStrategy === "direct_signup" ? "Subscribe" : "Explore the project"),
      invitationUrl,
      signupUrl,
      projectLogoUrl(workspace),
      safeColor(workspace?.brand?.primaryColor, "#6e50d7"),
      safeColor(workspace?.brand?.neutralLightColor, "#f6f5ef"),
      safeColor(workspace?.brand?.neutralDarkColor, "#24231f"),
    ],
  );
  return { campaign: serializeOptinCampaign(result.rows[0], env, workspace), prospectCount };
}

export async function updateOptinCampaign(userId, projectId, id, input, env = process.env) {
  await ensureTables(env);
  if (input?.approvalConfirmed !== true) throw newsletterError("Approve the invitation change first.", 400);
  const current = await getPool(env).query(
    "SELECT * FROM market_agent_optin_campaigns WHERE id = $1 AND user_id = $2 AND project_id = $3 LIMIT 1",
    [id, userId, projectId],
  );
  const row = current.rows[0];
  if (!row) throw newsletterError("The opt-in campaign was not found.", 404);
  const { state } = await loadStateForUser(userId, env);
  const workspace = state.projects.find((item) => item.id === projectId) || {};
  const status = input?.status === "paused" ? "paused" : "active";
  const invitationStrategy = ["project_first", "direct_signup", "custom"].includes(input?.invitationStrategy) ? input.invitationStrategy : (row.invitation_strategy || "project_first");
  const publicUrl = `${applicationOrigin(env)}/join/${encodeURIComponent(row.public_token)}`;
  const invitationFallback = invitationStrategy === "direct_signup" ? publicUrl : safeInvitationUrl(workspace.website, publicUrl);
  const result = await getPool(env).query(
    `UPDATE market_agent_optin_campaigns SET status=$4,eyebrow=$5,title=$6,description=$7,cta_label=$8,privacy_note=$9,promotion_text=$10,invitation_subject=$11,invitation_body=$12,invitation_strategy=$13,invitation_cta_label=$14,invitation_url=$15,updated_at=NOW()
     WHERE id=$1 AND user_id=$2 AND project_id=$3 RETURNING *`,
    [
      id,
      userId,
      projectId,
      status,
      cleanHeader(input?.eyebrow ?? row.eyebrow, 80),
      cleanHeader(input?.title ?? row.title, 180),
      cleanText(input?.description ?? row.description, 1_200),
      cleanHeader(input?.ctaLabel ?? row.cta_label, 80) || "Subscribe",
      cleanText(input?.privacyNote ?? row.privacy_note, 400),
      cleanText(input?.promotionText ?? row.promotion_text, 2_000),
      cleanHeader(input?.invitationSubject ?? row.invitation_subject, 180),
      normalizeInvitationBody(input?.invitationBody ?? row.invitation_body),
      invitationStrategy,
      cleanHeader(input?.invitationCtaLabel ?? row.invitation_cta_label, 80) || (invitationStrategy === "direct_signup" ? "Subscribe" : "Explore"),
      safeInvitationUrl(input?.invitationUrl ?? row.invitation_url, invitationFallback),
    ],
  );
  return { campaign: serializeOptinCampaign(result.rows[0], env, workspace) };
}

export async function listProspectInvitationRecipients(userId, projectId, env = process.env) {
  await ensureTables(env);
  const [imports, existing] = await Promise.all([
    getPool(env).query(
      "SELECT contacts FROM market_agent_contact_imports WHERE user_id = $1 AND project_id = $2 ORDER BY created_at ASC",
      [userId, projectId],
    ),
    getPool(env).query(
      "SELECT email FROM market_agent_subscribers WHERE user_id = $1 AND project_id = $2",
      [userId, projectId],
    ),
  ]);
  const excluded = new Set(existing.rows.map((row) => String(row.email || "").trim().toLowerCase()));
  const recipients = new Map();
  for (const row of imports.rows) {
    for (const contact of Array.isArray(row.contacts) ? row.contacts : []) {
      const email = String(contact?.email || "").trim().toLowerCase();
      const consent = ["confirmed", "denied"].includes(contact?.consent) ? contact.consent : "unknown";
      if (consent !== "unknown" || excluded.has(email) || recipients.has(email) || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(email)) continue;
      recipients.set(email, {
        email,
        firstName: cleanHeader(contact?.firstName, 100),
        lastName: cleanHeader(contact?.lastName, 100),
        company: cleanHeader(contact?.company, 180),
      });
      if (recipients.size >= 1_000) break;
    }
    if (recipients.size >= 1_000) break;
  }
  return [...recipients.values()];
}

export async function getPublicOptinCampaign(token, action = "view", env = process.env) {
  await ensureTables(env);
  const publicToken = String(token || "").trim();
  if (!/^[A-Za-z0-9_-]{24,80}$/.test(publicToken)) throw newsletterError("This signup page is unavailable.", 404);
  const result = await getPool(env).query(
    "SELECT * FROM market_agent_optin_campaigns WHERE public_token = $1 AND status = 'active' LIMIT 1",
    [publicToken],
  );
  const row = result.rows[0];
  if (!row) throw newsletterError("This signup page is unavailable.", 404);
  if (action === "join") {
    await getPool(env).query("UPDATE market_agent_optin_campaigns SET cta_clicks=cta_clicks+1,updated_at=NOW() WHERE id=$1", [row.id]);
    return { redirectUrl: safeMailchimpSignupUrl(row.signup_url) };
  }
  if (action !== "preview") await getPool(env).query("UPDATE market_agent_optin_campaigns SET views=views+1,updated_at=NOW() WHERE id=$1", [row.id]);
  return {
    campaign: {
      eyebrow: row.eyebrow || "NEWSLETTER",
      title: row.title || "Subscribe for updates",
      description: row.description || "",
      ctaLabel: row.cta_label || "Subscribe",
      privacyNote: row.privacy_note || "Confirm your email to subscribe. Unsubscribe at any time.",
      logoUrl: safeEmailImage(row.logo_url),
      primaryColor: safeColor(row.primary_color, "#6e50d7"),
      backgroundColor: safeColor(row.background_color, "#f6f5ef"),
      textColor: safeColor(row.text_color, "#24231f"),
    },
  };
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
  draft.issues = newsletterDraftIssues(draft, workspace || {});
  draft.ctaUrl = trackedNewsletterUrl(draft.ctaUrl, id, draft.subject);
  const html = renderNewsletterHtml(draft, workspace || {});
  const result = await getPool(env).query(
    "UPDATE market_agent_newsletters SET draft = $4::jsonb, html = $5, status = 'draft', error = '', updated_at = NOW() WHERE id = $1 AND user_id = $2 AND project_id = $3 RETURNING *",
    [id, userId, projectId, JSON.stringify(draft), html],
  );
  return { draft: serializeDraft(result.rows[0]) };
}

export async function updateLatestNewsletterLink(userId, projectId, targetUrl, env = process.env) {
  await ensureTables(env);
  const current = await getPool(env).query(
    `SELECT id FROM market_agent_newsletters
      WHERE user_id = $1 AND project_id = $2 AND status IN ('draft','failed')
      ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    [userId, projectId],
  );
  const id = current.rows[0]?.id;
  if (!id) throw newsletterError("There is no editable newsletter draft in this project.", 404);
  const normalizedUrl = normalizeHttpUrl(targetUrl);
  if (!normalizedUrl) throw newsletterError("The requested newsletter link is not a valid website address.", 400);
  const updated = await updateNewsletterDraft(userId, projectId, id, { ctaUrl: normalizedUrl }, env);
  return { ...updated, requestedUrl: normalizedUrl };
}

export async function updateLatestNewsletterLogo(userId, projectId, instruction = "", env = process.env) {
  await ensureTables(env);
  const current = await getPool(env).query(
    `SELECT id,draft FROM market_agent_newsletters
      WHERE user_id = $1 AND project_id = $2 AND status IN ('draft','failed')
      ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    [userId, projectId],
  );
  const row = current.rows[0];
  if (!row?.id) throw newsletterError("There is no editable newsletter draft in this project.", 404);
  const { state } = await loadStateForUser(userId, env);
  const workspace = state.projects.find((item) => item.id === projectId);
  if (!workspace) throw newsletterError("The project could not be found.", 404);
  const variants = projectLogoVariants(workspace);
  if (!variants.length) throw newsletterError("Add a logo variant to Brand first.", 409);
  const selected = selectNewsletterLogoVariant(variants, instruction, row.draft?.logoVariantId || "");
  const updated = await updateNewsletterDraft(userId, projectId, row.id, { logoUrl: selected.url, logoVariantId: selected.id, logoHidden: false }, env);
  return { ...updated, logo: selected };
}

export function selectNewsletterLogoVariant(variants, instruction = "", currentId = "") {
  const available = Array.isArray(variants) ? variants.filter((variant) => safeEmailImage(variant?.url)) : [];
  if (!available.length) throw newsletterError("Add a logo variant to Brand first.", 409);
  const message = String(instruction || "").toLowerCase();
  const normalizedMessage = message.normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
  const named = [...available].sort((a, b) => String(b.name || "").length - String(a.name || "").length).find((variant) => {
    const name = String(variant.name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
    return name.length >= 3 && normalizedMessage.includes(name);
  });
  if (named) return named;
  if (/\b(new|newest|latest|recent|last uploaded)\b/.test(message)) {
    return [...available].sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "")).find((variant) => variant.id !== currentId) || available[0];
  }
  const requestedUsage = ["email", "dark", "light", "icon", "primary"].find((usage) => new RegExp(`\\b${usage}\\b`).test(message));
  if (requestedUsage) {
    const matchingUsage = available.find((variant) => variant.usage === requestedUsage);
    if (matchingUsage) return matchingUsage;
  }
  return available.find((variant) => variant.usage === "email") || available.find((variant) => variant.usage === "primary") || available[0];
}

function trackedNewsletterUrl(value, campaignId, campaignName) {
  try {
    if (!value) return "";
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return value;
    url.searchParams.set("utm_id", String(campaignId || "newsletter").slice(0, 120));
    url.searchParams.set("utm_source", "mailchimp");
    url.searchParams.set("utm_medium", "email");
    url.searchParams.set("utm_campaign", String(campaignName || "newsletter").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "newsletter");
    url.searchParams.set("utm_content", "primary-cta");
    return url.toString();
  } catch {
    return value;
  }
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
    const draftIssues = newsletterDraftIssues(row.draft || {}, {});
    if (draftIssues.length) throw newsletterError(`Resolve the newsletter details before delivery: ${draftIssues.join(" ")}`, 409);
    const { row: connection, credentials } = await connectionCredentials(userId, projectId, env);
    const audienceId = requireAudience(credentials);
    const list = await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}`);
    const defaults = list.campaign_defaults || {};
    const replyTo = String(defaults.from_email || connection.account_email || "").trim();
    const fromName = String(row.draft?.senderName || defaults.from_name || connection.account_label || "").trim();
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

async function resolveMailchimpSignupUrl(credentials, audienceId, audience = {}, createIfMissing = false) {
  let signupUrl = signupFormUrlFromResponses(audience);
  if (signupUrl) return signupUrl;
  try {
    const forms = await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}/signup-forms`);
    signupUrl = signupFormUrlFromResponses(audience, forms);
  } catch { /* The audience summary can still provide the URL on older Mailchimp accounts. */ }
  if (signupUrl || !createIfMissing) return signupUrl;
  try {
    const initialized = await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}/signup-forms`, { method: "POST", body: {} });
    return signupFormUrlFromResponses(audience, initialized);
  } catch { return ""; }
}

async function saveCredentials(userId, projectId, credentials, env) {
  await getPool(env).query(
    "UPDATE market_agent_connections SET encrypted_credentials = $3, updated_at = NOW() WHERE user_id = $1 AND project_id = $2 AND provider = 'mailchimp'",
    [userId, projectId, encryptCredentials(credentials, env)],
  );
}

async function syncSubscriberRegistry(userId, projectId, members, env) {
  if (!Array.isArray(members) || !members.length) return;
  for (const member of members) {
    const email = String(member?.email_address || "").trim().toLowerCase();
    if (!email) continue;
    await upsertSubscriber(userId, projectId, {
      email,
      firstName: member.merge_fields?.FNAME || "",
      lastName: member.merge_fields?.LNAME || "",
      company: member.merge_fields?.COMPANY || "",
      status: mapMailchimpStatus(member.status),
      remoteId: member.id || "",
      confirmedAt: member.timestamp_opt || null,
    }, env);
  }
}

async function fetchAudienceMembers(credentials, audienceId) {
  const collected = [];
  let total = 0;
  for (let offset = 0; offset < 10_000; offset += 1000) {
    const page = await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}/members?count=1000&offset=${offset}&sort_field=timestamp_opt&sort_dir=DESC&fields=members.id,members.email_address,members.status,members.merge_fields,members.timestamp_opt,members.last_changed,total_items`);
    const rows = Array.isArray(page.members) ? page.members : [];
    collected.push(...rows);
    total = Number(page.total_items || collected.length);
    if (!rows.length || collected.length >= total) break;
  }
  return { members: collected, total_items: total };
}

async function upsertSubscriber(userId, projectId, subscriber, env) {
  const status = ["pending", "confirmed", "unsubscribed", "bounced"].includes(subscriber.status) ? subscriber.status : "pending";
  await getPool(env).query(
    `INSERT INTO market_agent_subscribers
      (user_id,project_id,email,first_name,last_name,company,status,remote_id,source,confirmed_at,unsubscribed_at,bounced_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mailchimp',
       CASE WHEN $7 = 'confirmed' THEN COALESCE($9::timestamptz,NOW()) ELSE NULL END,
       CASE WHEN $7 = 'unsubscribed' THEN NOW() ELSE NULL END,
       CASE WHEN $7 = 'bounced' THEN NOW() ELSE NULL END,NOW(),NOW())
     ON CONFLICT (user_id,project_id,email) DO UPDATE SET
       first_name = COALESCE(NULLIF(EXCLUDED.first_name,''),market_agent_subscribers.first_name),
       last_name = COALESCE(NULLIF(EXCLUDED.last_name,''),market_agent_subscribers.last_name),
       company = COALESCE(NULLIF(EXCLUDED.company,''),market_agent_subscribers.company),
       status = EXCLUDED.status,
       remote_id = COALESCE(NULLIF(EXCLUDED.remote_id,''),market_agent_subscribers.remote_id),
       confirmed_at = CASE WHEN EXCLUDED.status = 'confirmed' THEN COALESCE(EXCLUDED.confirmed_at,market_agent_subscribers.confirmed_at,NOW()) ELSE market_agent_subscribers.confirmed_at END,
       unsubscribed_at = CASE WHEN EXCLUDED.status = 'unsubscribed' THEN COALESCE(market_agent_subscribers.unsubscribed_at,NOW()) ELSE market_agent_subscribers.unsubscribed_at END,
       bounced_at = CASE WHEN EXCLUDED.status = 'bounced' THEN COALESCE(market_agent_subscribers.bounced_at,NOW()) ELSE market_agent_subscribers.bounced_at END,
       updated_at = NOW()`,
    [userId, projectId, String(subscriber.email || "").trim().toLowerCase(), cleanHeader(subscriber.firstName, 120), cleanHeader(subscriber.lastName, 120), cleanHeader(subscriber.company, 240), status, cleanHeader(subscriber.remoteId, 240), subscriber.confirmedAt || null],
  );
}

async function getNewsletterSettings(userId, projectId, env) {
  const result = await getPool(env).query("SELECT * FROM market_agent_newsletter_settings WHERE user_id = $1 AND project_id = $2 LIMIT 1", [userId, projectId]);
  if (result.rows[0]) return serializeNewsletterSettings(result.rows[0]);
  let projectName = "our newsletter";
  try {
    const { state } = await loadStateForUser(userId, env);
    projectName = cleanHeader(state.projects.find((item) => item.id === projectId)?.name, 100) || projectName;
  } catch { /* Use a safe, editable default when the project record is temporarily unavailable. */ }
  return {
    enabled: false,
    subject: `Welcome to ${projectName}`,
    body: `Thank you for confirming your subscription to ${projectName}.\n\nYou are now registered and will receive future updates. You can unsubscribe at any time.`,
    enabledAt: null,
  };
}

async function claimSubscriberWelcome(userId, projectId, email, firstName, env) {
  const settings = await getNewsletterSettings(userId, projectId, env);
  if (!settings.enabled) return null;
  const claimed = await getPool(env).query(
    `UPDATE market_agent_subscribers SET welcome_status = 'sending', welcome_error = '', updated_at = NOW()
     WHERE user_id = $1 AND project_id = $2 AND email = $3 AND status = 'confirmed'
       AND welcome_status IN ('not_sent','failed') AND welcome_sent_at IS NULL
       AND ($4::timestamptz IS NULL OR confirmed_at >= $4::timestamptz)
     RETURNING email,first_name`,
    [userId, projectId, String(email || "").toLowerCase(), settings.enabledAt],
  );
  if (!claimed.rows[0]) return null;
  const name = cleanHeader(firstName || claimed.rows[0].first_name, 120);
  return {
    to: claimed.rows[0].email,
    subject: personalizeWelcome(settings.subject, name),
    body: personalizeWelcome(settings.body, name),
  };
}

function personalizeWelcome(value, firstName) {
  return String(value || "").replace(/\{\{?first_name\}?\}/gi, firstName || "there");
}

async function ensureMailchimpWebhook(userId, projectId, credentials, audienceId, env) {
  const baseValue = env.MAILCHIMP_REDIRECT_BASE_URL || env.APP_BASE_URL || "";
  if (!baseValue) return;
  const base = normalizeOrigin(baseValue);
  if (!base.startsWith("https://")) return;
  const callbackUrl = `${base}/api/mailchimp-webhook?t=${encodeURIComponent(createWebhookToken(userId, projectId, audienceId, env))}`;
  const existing = await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}/webhooks`);
  if ((existing.webhooks || []).some((item) => item.url === callbackUrl)) return;
  await mailchimpRequest(credentials, `/lists/${encodeURIComponent(audienceId)}/webhooks`, {
    method: "POST",
    body: {
      url: callbackUrl,
      events: { subscribe: true, unsubscribe: true, profile: true, cleaned: true, upemail: true, campaign: false },
      sources: { user: true, admin: true, api: true },
    },
  });
}

function createWebhookToken(userId, projectId, audienceId, env) {
  const payload = Buffer.from(JSON.stringify({ u: userId, p: projectId, a: audienceId }), "utf8").toString("base64url");
  const signature = createHmac("sha256", connectionKey(env)).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyWebhookToken(token, env) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) throw newsletterError("Invalid webhook authorization.", 401);
  const expected = createHmac("sha256", connectionKey(env)).update(payload).digest("base64url");
  const suppliedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !timingSafeEqual(suppliedBuffer, expectedBuffer)) throw newsletterError("Invalid webhook authorization.", 401);
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!parsed.u || !parsed.p || !parsed.a) throw new Error("Incomplete token");
    return { userId: String(parsed.u), projectId: String(parsed.p), audienceId: String(parsed.a) };
  } catch { throw newsletterError("Invalid webhook authorization.", 401); }
}

function normalizeWebhookEvent(input) {
  const read = (key) => input?.data?.[key] ?? input?.[`data[${key}]`] ?? input?.[key] ?? "";
  const merges = input?.data?.merges || {};
  return {
    type: String(input?.type || "").toLowerCase(),
    listId: String(read("list_id")),
    remoteId: String(read("id")),
    email: String(read("email") || merges.EMAIL || input?.["data[merges][EMAIL]"] || "").trim().toLowerCase(),
    firstName: String(merges.FNAME || input?.["data[merges][FNAME]"] || ""),
    lastName: String(merges.LNAME || input?.["data[merges][LNAME]"] || ""),
  };
}

function mapMailchimpStatus(value) {
  return ({ subscribed: "confirmed", pending: "pending", unsubscribed: "unsubscribed", cleaned: "bounced" })[String(value || "").toLowerCase()] || "pending";
}

function normalizeSubscriberCounts(row = {}) {
  return { total: Number(row.total || 0), pending: Number(row.pending || 0), confirmed: Number(row.confirmed || 0), unsubscribed: Number(row.unsubscribed || 0), bounced: Number(row.bounced || 0) };
}

function serializeSubscriber(row) {
  return {
    email: row.email || "",
    firstName: row.first_name || "",
    lastName: row.last_name || "",
    company: row.company || "",
    status: row.status || "pending",
    confirmedAt: iso(row.confirmed_at),
    unsubscribedAt: iso(row.unsubscribed_at),
    bouncedAt: iso(row.bounced_at),
    welcomeStatus: row.welcome_status || "not_sent",
    welcomeSentAt: iso(row.welcome_sent_at),
    updatedAt: iso(row.updated_at),
  };
}

function serializeNewsletterSettings(row) {
  return { enabled: Boolean(row.welcome_enabled), subject: row.welcome_subject || "", body: row.welcome_body || "", enabledAt: iso(row.welcome_enabled_at) };
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
    CREATE TABLE IF NOT EXISTS market_agent_contact_imports (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, source_asset_id TEXT NOT NULL DEFAULT '', source_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','importing','imported','partial','failed')),
      contacts JSONB NOT NULL DEFAULT '[]'::jsonb, column_map JSONB NOT NULL DEFAULT '{}'::jsonb,
      total_count INTEGER NOT NULL DEFAULT 0, valid_count INTEGER NOT NULL DEFAULT 0,
      invalid_count INTEGER NOT NULL DEFAULT 0, duplicate_count INTEGER NOT NULL DEFAULT 0,
      consented_count INTEGER NOT NULL DEFAULT 0, unknown_count INTEGER NOT NULL DEFAULT 0,
      denied_count INTEGER NOT NULL DEFAULT 0, imported_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0, import_mode TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE market_agent_contact_imports ADD COLUMN IF NOT EXISTS source_asset_id TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS market_agent_contact_imports_user_project_idx ON market_agent_contact_imports (user_id, project_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS market_agent_contact_imports_source_asset_uidx ON market_agent_contact_imports (source_asset_id) WHERE source_asset_id <> '';
    CREATE TABLE IF NOT EXISTS market_agent_subscribers (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL, email TEXT NOT NULL,
      first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', company TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','unsubscribed','bounced')),
      remote_id TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'mailchimp',
      confirmed_at TIMESTAMPTZ, unsubscribed_at TIMESTAMPTZ, bounced_at TIMESTAMPTZ,
      welcome_status TEXT NOT NULL DEFAULT 'not_sent' CHECK (welcome_status IN ('not_sent','sending','sent','failed')),
      welcome_sent_at TIMESTAMPTZ, welcome_error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id,project_id,email)
    );
    CREATE INDEX IF NOT EXISTS market_agent_subscribers_user_project_status_idx ON market_agent_subscribers (user_id,project_id,status,updated_at DESC);
    CREATE TABLE IF NOT EXISTS market_agent_newsletter_settings (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL,
      welcome_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      welcome_subject TEXT NOT NULL DEFAULT '', welcome_body TEXT NOT NULL DEFAULT '', welcome_enabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id,project_id)
    );
    CREATE TABLE IF NOT EXISTS market_agent_optin_campaigns (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, public_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
      eyebrow TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      cta_label TEXT NOT NULL DEFAULT '', privacy_note TEXT NOT NULL DEFAULT '', promotion_text TEXT NOT NULL DEFAULT '',
      invitation_subject TEXT NOT NULL DEFAULT '', invitation_body TEXT NOT NULL DEFAULT '',
      invitation_strategy TEXT NOT NULL DEFAULT '', invitation_cta_label TEXT NOT NULL DEFAULT '', invitation_url TEXT NOT NULL DEFAULT '',
      signup_url TEXT NOT NULL DEFAULT '', logo_url TEXT NOT NULL DEFAULT '',
      primary_color TEXT NOT NULL DEFAULT '', background_color TEXT NOT NULL DEFAULT '', text_color TEXT NOT NULL DEFAULT '',
      views INTEGER NOT NULL DEFAULT 0, cta_clicks INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE market_agent_optin_campaigns ADD COLUMN IF NOT EXISTS invitation_subject TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_optin_campaigns ADD COLUMN IF NOT EXISTS invitation_body TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_optin_campaigns ADD COLUMN IF NOT EXISTS invitation_strategy TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_optin_campaigns ADD COLUMN IF NOT EXISTS invitation_cta_label TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_optin_campaigns ADD COLUMN IF NOT EXISTS invitation_url TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS market_agent_optin_campaigns_user_project_idx ON market_agent_optin_campaigns (user_id,project_id,created_at DESC);
  `);
  tablesReady = true;
}

function normalizeDraft(value, workspace) {
  const safeUrl = safeCtaUrl(value?.ctaUrl, workspace);
  const identity = workspace?.emailIdentity && typeof workspace.emailIdentity === "object" ? workspace.emailIdentity : {};
  const senderName = cleanHeader(value?.senderName || identity.senderName, 160);
  const businessDetails = cleanText(value?.businessDetails || identity.businessDetails, 600);
  const addressPreference = ["include", "omit"].includes(value?.addressPreference || identity.addressPreference) ? (value?.addressPreference || identity.addressPreference) : "ask";
  const physicalAddress = cleanText(value?.physicalAddress || identity.physicalAddress, 600);
  const logoVariantId = cleanHeader(value?.logoVariantId, 160);
  const selectedLogo = projectLogoVariants(workspace).find((variant) => variant.id === logoVariantId);
  const logoHidden = value?.logoHidden === true;
  const logoUrl = logoHidden ? "" : safeEmailImage(selectedLogo?.url) || safeEmailImage(value?.logoUrl) || projectLogoUrl(workspace);
  const hero = projectHeroImage(workspace);
  return {
    subject: cleanHeader(value?.subject, 100) || `An update from ${cleanHeader(workspace?.name, 70) || "our team"}`,
    previewText: cleanHeader(value?.previewText, 150),
    headline: cleanText(value?.headline, 180),
    introduction: cleanText(value?.introduction, 2_000),
    sections: (Array.isArray(value?.sections) ? value.sections : []).slice(0, 4).map((section) => ({ heading: cleanText(section?.heading, 180), body: cleanText(section?.body, 3_000) })).filter((section) => section.heading || section.body),
    ctaLabel: safeUrl ? cleanHeader(value?.ctaLabel, 80) || "Learn more" : "",
    ctaUrl: safeUrl,
    closing: cleanText(value?.closing, 1_000),
    logoUrl,
    logoVariantId: selectedLogo?.id || logoVariantId || "",
    logoHidden,
    heroImageUrl: safeEmailImage(value?.heroImageUrl) || hero.url,
    heroImageAlt: cleanHeader(value?.heroImageAlt, 180) || hero.alt,
    senderName,
    businessDetails,
    physicalAddress,
    addressPreference,
    issues: Array.isArray(value?.issues) ? value.issues.map((item) => cleanText(item, 300)).filter(Boolean).slice(0, 10) : [],
  };
}

function newsletterDraftIssues(draft, workspace) {
  const issues = [];
  const placeholders = newsletterDraftPlaceholders(draft);
  if (placeholders.length) issues.push(`Replace unresolved fields: ${placeholders.join(", ")}.`);
  if (!cleanHeader(draft?.senderName || workspace?.emailIdentity?.senderName, 160)) issues.push("Add the sender name.");
  if (!cleanText(draft?.businessDetails || workspace?.emailIdentity?.businessDetails, 600)) issues.push("Add the business contact details, or explicitly choose to omit them.");
  const preference = draft?.addressPreference || workspace?.emailIdentity?.addressPreference || "ask";
  if (preference === "ask") issues.push("Choose whether the editorial signature should show the physical address.");
  if (preference === "include" && !cleanText(draft?.physicalAddress || workspace?.emailIdentity?.physicalAddress, 600)) issues.push("Add the physical address or choose to omit it from the editorial signature.");
  return [...new Set(issues)];
}

function projectLogoUrl(workspace) {
  const variants = projectLogoVariants(workspace);
  const selected = variants.find((variant) => variant.usage === "email") || variants.find((variant) => variant.usage === "primary") || variants[0];
  if (selected) return selected.url;
  const media = Array.isArray(workspace?.sourceMedia) ? workspace.sourceMedia : [];
  return safeEmailImage(media.find((item) => /\b(logo|wordmark|brand mark)\b/i.test(`${item?.name || ""} ${item?.role || ""} ${(item?.tags || []).join(" ")}`))?.url);
}

export function projectLogoVariants(workspace) {
  const variants = Array.isArray(workspace?.brand?.logoVariants) ? workspace.brand.logoVariants : [];
  const normalized = variants.map((variant, index) => ({
    id: cleanHeader(variant?.id, 160) || `logo-${index + 1}`,
    name: cleanHeader(variant?.name, 220) || `Logo ${index + 1}`,
    url: safeEmailImage(variant?.url),
    usage: ["primary", "email", "light", "dark", "icon", "other"].includes(variant?.usage) ? variant.usage : "other",
    createdAt: String(variant?.createdAt || ""),
  })).filter((variant) => variant.url).slice(0, 10);
  const legacy = safeEmailImage(workspace?.brand?.logoDataUrl);
  if (!normalized.length && legacy) normalized.push({ id: "legacy-primary-logo", name: cleanHeader(workspace?.brand?.logoName, 220) || "Primary logo", url: legacy, usage: "primary", createdAt: "" });
  return normalized;
}

function projectHeroImage(workspace) {
  const media = Array.isArray(workspace?.sourceMedia) ? workspace.sourceMedia : [];
  const item = media.find((candidate) => candidate?.kind === "image" && candidate?.recommendation === "reuse" && !/\b(logo|favicon|icon|wordmark|brand mark)\b/i.test(`${candidate?.name || ""} ${candidate?.role || ""} ${(candidate?.tags || []).join(" ")}`))
    || media.find((candidate) => candidate?.kind === "image" && !/\b(logo|favicon|icon|wordmark|brand mark)\b/i.test(`${candidate?.name || ""} ${candidate?.role || ""} ${(candidate?.tags || []).join(" ")}`));
  return { url: safeEmailImage(item?.url), alt: cleanHeader(item?.name || item?.role, 180) };
}

function safeEmailImage(value) {
  const image = String(value || "").trim();
  return /^(?:https:\/\/|data:image\/(?:png|jpeg|jpg|webp|gif);base64,)/i.test(image) ? image : "";
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
  const logo = draft.logoUrl ? `<img src="${escapeAttribute(draft.logoUrl)}" alt="${name}" style="display:block;max-width:190px;max-height:72px;width:auto;height:auto">` : `<div style="font:700 13px Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:${primary}">${name}</div>`;
  const hero = draft.heroImageUrl ? `<tr><td><img src="${escapeAttribute(draft.heroImageUrl)}" alt="${escapeAttribute(draft.heroImageAlt || "")}" width="640" style="display:block;width:100%;max-width:640px;height:auto;max-height:420px;object-fit:cover"></td></tr>` : "";
  const signature = [draft.senderName, draft.businessDetails, draft.addressPreference === "include" ? draft.physicalAddress : ""].filter(Boolean).map((line) => paragraphs(line)).join("<br>");
  const sections = draft.sections.map((section) => `<tr><td style="padding:0 34px 24px"><h2 style="margin:0 0 8px;font:700 20px/1.25 Arial,sans-serif;color:${text}">${escapeHtml(section.heading)}</h2><p style="margin:0;font:400 16px/1.6 Arial,sans-serif;color:${text}">${paragraphs(section.body)}</p></td></tr>`).join("");
  const button = draft.ctaUrl ? `<tr><td style="padding:2px 34px 30px"><a href="${escapeAttribute(draft.ctaUrl)}" style="display:inline-block;padding:13px 20px;background:${primary};color:#ffffff;text-decoration:none;border-radius:7px;font:700 15px Arial,sans-serif">${escapeHtml(draft.ctaLabel)}</a></td></tr>` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(draft.subject)}</title></head><body style="margin:0;padding:0;background:${background}"><div style="display:none;max-height:0;overflow:hidden">${escapeHtml(draft.previewText)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:${background};padding:28px 12px"><tr><td align="center"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden"><tr><td style="height:8px;background:${primary}"></td></tr><tr><td style="padding:28px 34px 22px">${logo}</td></tr>${hero}<tr><td style="padding:28px 34px 14px"><h1 style="margin:0 0 12px;font:700 34px/1.15 Arial,sans-serif;color:${text}">${escapeHtml(draft.headline)}</h1><p style="margin:0;font:400 17px/1.6 Arial,sans-serif;color:${text}">${paragraphs(draft.introduction)}</p></td></tr>${sections}${button}<tr><td style="padding:0 34px 28px"><p style="margin:0;font:400 15px/1.6 Arial,sans-serif;color:${text}">${paragraphs(draft.closing)}</p>${signature ? `<p style="margin:18px 0 0;font:600 14px/1.55 Arial,sans-serif;color:${text}">${signature}</p>` : ""}</td></tr><tr><td style="padding:20px 34px;background:#f2f1ee;font:400 12px/1.5 Arial,sans-serif;color:#666">You are receiving this because you subscribed to updates from ${name}.<br>*|LIST:DESCRIPTION|*<br><a href="*|UNSUB|*" style="color:#555">Unsubscribe</a> · <a href="*|UPDATE_PROFILE|*" style="color:#555">Update preferences</a><br>*|HTML:LIST_ADDRESS_HTML|*</td></tr></table></td></tr></table></body></html>`;
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

function serializeOptinCampaign(row, env, workspace = {}) {
  const publicUrl = `${applicationOrigin(env)}/join/${encodeURIComponent(row.public_token)}`;
  const hasProjectDestination = Boolean(normalizeHttpUrl(workspace?.website));
  const invitationStrategy = ["project_first", "direct_signup", "custom"].includes(row.invitation_strategy)
    ? row.invitation_strategy
    : hasProjectDestination ? "project_first" : "direct_signup";
  const invitationUrl = safeInvitationUrl(row.invitation_url, invitationStrategy === "direct_signup" ? publicUrl : normalizeHttpUrl(workspace?.website) || publicUrl);
  const projectName = cleanHeader(workspace?.name, 100) || "the project";
  const defaultSubject = invitationStrategy === "project_first" ? `An invitation to explore ${projectName}` : `An invitation from ${projectName}`;
  const defaultBody = invitationStrategy === "project_first"
    ? `Hi {{first_name}},\n\nI thought ${projectName} might be relevant to your work. I’d like to invite you to explore it here:\n\n{{invitation_url}}\n\nIf the project is useful, you can choose to subscribe for future updates from the site. If it is not relevant, no action is needed.`
    : normalizeInvitationBody("", workspace);
  return {
    id: row.id,
    status: row.status === "paused" ? "paused" : "active",
    eyebrow: row.eyebrow || "NEWSLETTER",
    title: row.title || "Subscribe for updates",
    description: row.description || "",
    ctaLabel: row.cta_label || "Subscribe",
    privacyNote: row.privacy_note || "Confirm your email to subscribe. Unsubscribe at any time.",
    promotionText: row.promotion_text || "",
    invitationSubject: row.invitation_subject || defaultSubject,
    invitationBody: row.invitation_body || defaultBody,
    invitationStrategy,
    invitationCtaLabel: row.invitation_cta_label || (invitationStrategy === "direct_signup" ? "Subscribe" : "Explore the project"),
    invitationUrl,
    publicUrl,
    views: Number(row.views || 0),
    ctaClicks: Number(row.cta_clicks || 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function normalizeInvitationBody(value, workspace = {}) {
  let body = cleanText(value, 20_000);
  if (!body) {
    const name = cleanHeader(workspace?.name, 100) || "our team";
    body = `Hi {{first_name}},\n\nI thought you might find ${name}'s updates useful. If you would like to receive them, you can review the details and subscribe here:\n\n{{invitation_url}}\n\nIf this is not relevant, no action is needed.`;
  }
  if (!body.includes("{{invitation_url}}") && !body.includes("{{signup_url}}") && !/https:\/\//i.test(body)) body = `${body}\n\n{{invitation_url}}`;
  return body;
}

function safeInvitationUrl(value, fallback = "") {
  const normalized = normalizeHttpUrl(value) || normalizeHttpUrl(fallback);
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" || url.username || url.password || url.hostname === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(url.hostname)) return normalizeHttpUrl(fallback);
    return url.toString();
  } catch {
    return normalizeHttpUrl(fallback);
  }
}

function serializeContactImport(row) {
  const contacts = Array.isArray(row.contacts) ? row.contacts : [];
  return {
    id: row.id,
    projectId: row.project_id,
    sourceName: row.source_name || "Contact list.csv",
    status: row.status || "staged",
    columnMap: row.column_map || {},
    totalCount: Number(row.total_count || 0),
    validCount: Number(row.valid_count || 0),
    invalidCount: Number(row.invalid_count || 0),
    duplicateCount: Number(row.duplicate_count || 0),
    consentedCount: Number(row.consented_count || 0),
    unknownCount: Number(row.unknown_count || 0),
    deniedCount: Number(row.denied_count || 0),
    importedCount: Number(row.imported_count || 0),
    failedCount: Number(row.failed_count || 0),
    importMode: row.import_mode || "",
    error: row.error || "",
    preview: contacts.slice(0, 5).map((contact) => ({ email: maskEmail(contact.email), firstName: contact.firstName || "", lastName: contact.lastName || "", company: contact.company || "", consent: contact.consent || "unknown" })),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function parseContactCsv(value) {
  const rows = parseCsv(String(value || "").replace(/^\uFEFF/, "")).filter((row) => row.some((cell) => String(cell || "").trim()));
  if (rows.length < 2) throw newsletterError("The contact CSV does not contain any contact rows.", 400);
  const headers = rows[0].map((header) => String(header || "").trim());
  const normalized = headers.map(normalizeColumnName);
  const findColumn = (...aliases) => normalized.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)));
  let emailIndex = normalized.findIndex((header) => ["emailaddress", "email", "mail", "emailid"].includes(header));
  if (emailIndex < 0) emailIndex = normalized.findIndex((header) => /(?:^|contact|work|business|personal)email(?:address)?$/.test(header));
  if (emailIndex < 0) throw newsletterError("The contact CSV needs an email column.", 400);
  const firstNameIndex = findColumn("firstname", "givenname", "forename");
  const lastNameIndex = findColumn("lastname", "surname", "familyname");
  const fullNameIndex = findColumn("fullname", "contactname", "name");
  const companyIndex = findColumn("company", "organization", "organisation", "venue", "business");
  const consentIndex = normalized.findIndex((header) => /(consent|permission|optin|subscribed|marketingstatus)/.test(header));
  const contacts = [];
  const seen = new Set();
  let invalidCount = 0;
  let duplicateCount = 0;
  let consentedCount = 0;
  let unknownCount = 0;
  let deniedCount = 0;
  for (const row of rows.slice(1, 5001)) {
    const email = String(row[emailIndex] || "").trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) { invalidCount += 1; continue; }
    if (seen.has(email)) { duplicateCount += 1; continue; }
    seen.add(email);
    let firstName = firstNameIndex >= 0 ? cleanHeader(row[firstNameIndex], 100) : "";
    let lastName = lastNameIndex >= 0 ? cleanHeader(row[lastNameIndex], 100) : "";
    if (!firstName && !lastName && fullNameIndex >= 0) {
      const pieces = cleanHeader(row[fullNameIndex], 200).split(/\s+/).filter(Boolean);
      firstName = pieces.shift() || "";
      lastName = pieces.join(" ");
    }
    const consent = consentIndex >= 0 ? normalizeConsent(row[consentIndex]) : "unknown";
    if (consent === "confirmed") consentedCount += 1;
    else if (consent === "denied") deniedCount += 1;
    else unknownCount += 1;
    contacts.push({ email, firstName, lastName, company: companyIndex >= 0 ? cleanHeader(row[companyIndex], 180) : "", consent });
  }
  if (!contacts.length) throw newsletterError("No valid email addresses were found in the contact CSV.", 400);
  return {
    contacts,
    columnMap: { email: headers[emailIndex] || "", firstName: firstNameIndex >= 0 ? headers[firstNameIndex] : "", lastName: lastNameIndex >= 0 ? headers[lastNameIndex] : "", fullName: fullNameIndex >= 0 ? headers[fullNameIndex] : "", company: companyIndex >= 0 ? headers[companyIndex] : "", consent: consentIndex >= 0 ? headers[consentIndex] : "" },
    totalCount: Math.max(0, rows.length - 1),
    validCount: contacts.length,
    invalidCount,
    duplicateCount,
    consentedCount,
    unknownCount,
    deniedCount,
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(cell); cell = ""; }
    else if (character === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += character;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows;
}

function normalizeColumnName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeConsent(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (["yes", "true", "1", "subscribed", "consented", "confirmed", "granted", "opted in", "opt in"].includes(normalized)) return "confirmed";
  if (["no", "false", "0", "unsubscribed", "denied", "revoked", "opted out", "opt out"].includes(normalized)) return "denied";
  return "unknown";
}

function maskEmail(value) {
  const [local, domain] = String(value || "").split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 2)}${local.length > 2 ? "•••" : ""}@${domain}`;
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

export function safeMailchimpSignupUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase();
    const allowed = hostname === "eepurl.com" || hostname.endsWith(".eepurl.com") || hostname === "mailchi.mp" || hostname.endsWith(".mailchi.mp") || hostname.endsWith(".list-manage.com") || hostname.endsWith(".mailchimp.com");
    if (!allowed || !["http:", "https:"].includes(url.protocol)) return "";
    url.protocol = "https:";
    return url.toString();
  } catch { return ""; }
}

export function signupFormUrlFromResponses(audience = {}, forms = {}) {
  const candidates = [
    audience?.subscribe_url_short,
    audience?.subscribe_url_long,
    forms?.signup_form_url,
    ...(Array.isArray(forms?.signup_forms) ? forms.signup_forms.map((form) => form?.signup_form_url) : []),
  ];
  for (const candidate of candidates) {
    const safe = safeMailchimpSignupUrl(candidate);
    if (safe) return safe;
  }
  return "";
}

function applicationOrigin(env) {
  for (const value of [env.APP_BASE_URL, env.MAILCHIMP_REDIRECT_BASE_URL, "https://www.marketagent.shop"]) {
    try {
      const url = new URL(String(value || ""));
      if (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) return url.origin;
    } catch { /* Try the next configured application origin. */ }
  }
  return "https://www.marketagent.shop";
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
