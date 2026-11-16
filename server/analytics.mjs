import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { getPool } from "./db.mjs";

const PROVIDER = "google-analytics";
const ANALYTICS_SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
let analyticsTableReady = false;

export function analyticsConnectorConfigured(env = process.env) {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.CONNECTION_ENCRYPTION_KEY);
}

export async function getAnalyticsConnectionStatus(userId, projectId = "project-default", env = process.env) {
  const empty = {
    configured: analyticsConnectorConfigured(env),
    authorized: false,
    connected: false,
    accountEmail: "",
    propertyId: "",
    propertyName: "",
    properties: [],
    connectedAt: null,
    canRead: false,
  };
  if (!env.DATABASE_URL) return empty;
  await ensureAnalyticsTable(env);
  const result = await getPool(env).query(
    `SELECT account_id, account_label, account_email, encrypted_credentials, scopes, status, connected_at, updated_at
       FROM market_agent_connections
      WHERE user_id = $1 AND project_id = $2 AND provider = $3
      LIMIT 1`,
    [userId, projectId, PROVIDER],
  );
  const row = result.rows[0];
  if (!row) return empty;
  let credentials = {};
  try { credentials = decryptCredentials(row.encrypted_credentials, env); } catch { return empty; }
  const properties = normalizeProperties(credentials.properties);
  const propertyId = cleanPropertyId(credentials.propertyId || row.account_id);
  const property = properties.find((item) => item.id === propertyId);
  return {
    ...empty,
    authorized: row.status === "authorized" || row.status === "connected",
    connected: row.status === "connected" && Boolean(propertyId),
    accountEmail: row.account_email || "",
    propertyId,
    propertyName: property?.name || row.account_label || "",
    properties,
    connectedAt: row.connected_at || row.updated_at || null,
    canRead: row.status === "connected" && Boolean(propertyId) && Array.isArray(row.scopes) && row.scopes.includes(ANALYTICS_SCOPE),
  };
}

export async function createAnalyticsAuthorizationUrl({ userId, projectId, origin }, env = process.env) {
  requireAnalyticsConnector(env);
  const redirectUri = `${normalizeOrigin(origin)}/api/google-analytics-callback`;
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
  const authorizationUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizationUrl.search = new URLSearchParams({
    client_id: env.GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ["openid", "email", ANALYTICS_SCOPE].join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent select_account",
    state,
  }).toString();
  return authorizationUrl.toString();
}

export async function finishAnalyticsAuthorization({ code, state }, env = process.env) {
  requireAnalyticsConnector(env);
  if (!code || !state) throw analyticsError("Google did not return a complete Analytics authorization response.", 400);
  let payload;
  try { ({ payload } = await jwtDecrypt(state, connectionKey(env), { clockTolerance: 5 })); }
  catch { throw analyticsError("The Analytics connection request expired. Start it again.", 400); }
  const userId = String(payload.u || "");
  const projectId = String(payload.j || "project-default");
  const redirectUri = String(payload.r || "");
  if (!userId || !/^https?:\/\//i.test(redirectUri)) throw analyticsError("The Analytics connection request is invalid.", 400);

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.access_token) throw analyticsError(providerMessage(tokens, "Google could not finish the Analytics connection."), 400);
  const grantedScopes = String(tokens.scope || "").split(/\s+/).filter(Boolean);
  if (!grantedScopes.includes(ANALYTICS_SCOPE)) throw analyticsError("Analytics was authorized without read access. Reconnect and approve Analytics access.", 400);
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok || !profile.email) throw analyticsError("Google did not return the authorized account.", 400);
  const properties = await listAnalyticsProperties(tokens.access_token);
  const existing = await readAnalyticsCredentials(userId, projectId, env);
  const propertyId = properties.length === 1 ? properties[0].id : cleanPropertyId(existing?.propertyId);
  const propertyName = properties.find((item) => item.id === propertyId)?.name || "";
  const credentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || existing?.refreshToken || "",
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    tokenType: tokens.token_type || "Bearer",
    properties,
    propertyId,
  };
  if (!credentials.refreshToken) throw analyticsError("Google did not provide offline Analytics access. Reconnect and approve access again.", 400);
  if (propertyId) await verifyAnalyticsRead(userId, projectId, propertyId, env, credentials);
  await ensureAnalyticsTable(env);
  await getPool(env).query(
    `INSERT INTO market_agent_connections
      (user_id, project_id, provider, account_id, account_label, account_email, encrypted_credentials, scopes, status, connected_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,NOW(),NOW())
     ON CONFLICT (user_id, project_id, provider) DO UPDATE SET
       account_id = EXCLUDED.account_id, account_label = EXCLUDED.account_label,
       account_email = EXCLUDED.account_email, encrypted_credentials = EXCLUDED.encrypted_credentials,
       scopes = EXCLUDED.scopes, status = EXCLUDED.status, connected_at = NOW(), updated_at = NOW()`,
    [userId, projectId, PROVIDER, propertyId, propertyName, String(profile.email).toLowerCase(), encryptCredentials(credentials, env), grantedScopes, propertyId ? "connected" : "authorized"],
  );
  return { userId, projectId, propertyId, propertyName, propertyCount: properties.length };
}

export async function selectAnalyticsProperty(userId, projectId, propertyId, env = process.env) {
  const credentials = await readAnalyticsCredentials(userId, projectId, env);
  if (!credentials) throw analyticsError("Connect Google Analytics first.", 409);
  const selected = normalizeProperties(credentials.properties).find((item) => item.id === cleanPropertyId(propertyId));
  if (!selected) throw analyticsError("Choose an Analytics property available to the authorized account.", 400);
  credentials.propertyId = selected.id;
  await verifyAnalyticsRead(userId, projectId, selected.id, env, credentials);
  await getPool(env).query(
    `UPDATE market_agent_connections
        SET account_id = $3, account_label = $4, encrypted_credentials = $5,
            status = 'connected', updated_at = NOW()
      WHERE user_id = $1 AND project_id = $2 AND provider = $6`,
    [userId, projectId, selected.id, selected.name, encryptCredentials(credentials, env), PROVIDER],
  );
  return getAnalyticsConnectionStatus(userId, projectId, env);
}

export async function disconnectAnalytics(userId, projectId, env = process.env) {
  await ensureAnalyticsTable(env);
  await getPool(env).query("DELETE FROM market_agent_connections WHERE user_id = $1 AND project_id = $2 AND provider = $3", [userId, projectId, PROVIDER]);
}

export async function getAnalyticsReport(userId, projectId, range = "28daysAgo", env = process.env) {
  const { credentials, accessToken } = await authorizedAnalyticsCredentials(userId, projectId, env);
  const propertyId = cleanPropertyId(credentials.propertyId);
  if (!propertyId) throw analyticsError("Choose a Google Analytics property first.", 409);
  const startDate = /^(7|14|28|30|60|90)daysAgo$/.test(String(range)) ? String(range) : "28daysAgo";
  const days = Number(startDate.match(/^\d+/)?.[0] || 28);
  const previousRange = { startDate: `${days * 2 + 1}daysAgo`, endDate: `${days + 1}daysAgo` };
  const currentRange = { startDate, endDate: "today" };
  const request = async (body) => {
    const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw analyticsError(providerMessage(data, "Google Analytics could not read this property."), response.status === 403 ? 403 : 502);
    return data;
  };
  const optionalRequest = async (body) => {
    try { return await request(body); }
    catch { return { dimensionHeaders: [], metricHeaders: [], rows: [] }; }
  };
  const summaryMetrics = [
    { name: "activeUsers" }, { name: "sessions" }, { name: "newUsers" }, { name: "eventCount" }, { name: "keyEvents" },
    { name: "engagedSessions" }, { name: "engagementRate" }, { name: "averageSessionDuration" }, { name: "screenPageViews" }, { name: "screenPageViewsPerSession" },
  ];
  const campaignDimensions = [{ name: "sessionManualCampaignId" }, { name: "sessionManualCampaignName" }, { name: "sessionManualSource" }, { name: "sessionManualMedium" }];
  const campaignMetrics = [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }];
  const campaignEventDimensions = [...campaignDimensions, { name: "eventName" }];
  const [summary, previousSummary, timeline, channels, previousChannels, campaigns, previousCampaigns, campaignEvents, previousCampaignEvents, keyEvents] = await Promise.all([
    request({ dateRanges: [currentRange], metrics: summaryMetrics }),
    request({ dateRanges: [previousRange], metrics: summaryMetrics }),
    request({ dateRanges: [currentRange], dimensions: [{ name: "date" }], metrics: [{ name: "activeUsers" }, { name: "sessions" }], orderBys: [{ dimension: { dimensionName: "date" } }] }),
    request({ dateRanges: [currentRange], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: "20" }),
    request({ dateRanges: [previousRange], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "keyEvents" }], orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: "20" }),
    optionalRequest({ dateRanges: [currentRange], dimensions: campaignDimensions, metrics: campaignMetrics, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: "100" }),
    optionalRequest({ dateRanges: [previousRange], dimensions: campaignDimensions, metrics: campaignMetrics, orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: "100" }),
    optionalRequest({ dateRanges: [currentRange], dimensions: campaignEventDimensions, metrics: [{ name: "keyEvents" }], orderBys: [{ metric: { metricName: "keyEvents" }, desc: true }], limit: "500" }),
    optionalRequest({ dateRanges: [previousRange], dimensions: campaignEventDimensions, metrics: [{ name: "keyEvents" }], orderBys: [{ metric: { metricName: "keyEvents" }, desc: true }], limit: "500" }),
    optionalRequest({ dateRanges: [currentRange], dimensions: [{ name: "eventName" }], metrics: [{ name: "keyEvents" }], orderBys: [{ metric: { metricName: "keyEvents" }, desc: true }], limit: "100" }),
  ]);
  const [acquisition, landingPages, pages, downloads, outboundLinks, videos, transitions] = await Promise.all([
    optionalRequest({
      dateRanges: [currentRange],
      dimensions: [{ name: "sessionSourceMedium" }, { name: "sessionPrimaryChannelGroup" }, { name: "sessionManualCampaignName" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "engagedSessions" }, { name: "engagementRate" }, { name: "averageSessionDuration" }, { name: "keyEvents" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: "50",
    }),
    optionalRequest({
      dateRanges: [currentRange], dimensions: [{ name: "landingPagePlusQueryString" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "engagedSessions" }, { name: "engagementRate" }, { name: "averageSessionDuration" }, { name: "screenPageViewsPerSession" }, { name: "keyEvents" }],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }], limit: "50",
    }),
    optionalRequest({
      dateRanges: [currentRange], dimensions: [{ name: "pagePathPlusQueryString" }, { name: "pageTitle" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }, { name: "userEngagementDuration" }, { name: "scrolledUsers" }, { name: "keyEvents" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: "100",
    }),
    optionalRequest({
      dateRanges: [currentRange], dimensions: [{ name: "fileName" }, { name: "linkText" }, { name: "linkUrl" }], metrics: [{ name: "eventCount" }, { name: "activeUsers" }],
      dimensionFilter: exactDimension("eventName", "file_download"), orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: "100",
    }),
    optionalRequest({
      dateRanges: [currentRange], dimensions: [{ name: "linkDomain" }, { name: "linkText" }, { name: "linkUrl" }], metrics: [{ name: "eventCount" }, { name: "activeUsers" }],
      dimensionFilter: { andGroup: { expressions: [exactDimension("eventName", "click"), exactDimension("outbound", "true")] } },
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: "100",
    }),
    optionalRequest({
      dateRanges: [currentRange], dimensions: [{ name: "eventName" }, { name: "videoTitle" }, { name: "videoUrl" }], metrics: [{ name: "eventCount" }, { name: "activeUsers" }],
      dimensionFilter: inListDimension("eventName", ["video_start", "video_progress", "video_complete"]),
      orderBys: [{ metric: { metricName: "eventCount" }, desc: true }], limit: "100",
    }),
    optionalRequest({
      dateRanges: [currentRange], dimensions: [{ name: "pageReferrer" }, { name: "pageLocation" }], metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      dimensionFilter: exactDimension("eventName", "page_view"), orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }], limit: "250",
    }),
  ]);
  const totals = reportRows(summary)[0] || {};
  const previousTotals = reportRows(previousSummary)[0] || {};
  const metricNames = summaryMetrics.map((metric) => metric.name);
  return {
    propertyId,
    propertyName: normalizeProperties(credentials.properties).find((item) => item.id === propertyId)?.name || propertyId,
    range: startDate,
    totals,
    previousTotals,
    changes: Object.fromEntries(metricNames.map((name) => [name, metricChange(totals[name], previousTotals[name])])),
    timeline: reportRows(timeline),
    channels: reportRows(channels),
    previousChannels: reportRows(previousChannels),
    campaigns: reportRows(campaigns).filter(isAttributedCampaignRow),
    previousCampaigns: reportRows(previousCampaigns).filter(isAttributedCampaignRow),
    campaignEvents: reportRows(campaignEvents).filter(isAttributedCampaignRow),
    previousCampaignEvents: reportRows(previousCampaignEvents).filter(isAttributedCampaignRow),
    keyEvents: reportRows(keyEvents).filter((row) => Number(row.keyEvents || 0) > 0),
    acquisition: reportRows(acquisition),
    landingPages: reportRows(landingPages),
    pages: reportRows(pages),
    downloads: reportRows(downloads).filter(hasMeaningfulLink),
    outboundLinks: reportRows(outboundLinks).filter(hasMeaningfulLink),
    videos: reportRows(videos).filter((row) => meaningfulValue(row.videoTitle) || meaningfulValue(row.videoUrl)),
    transitions: reportRows(transitions).filter(isInternalTransition).slice(0, 100),
    fetchedAt: new Date().toISOString(),
  };
}

function exactDimension(fieldName, value) {
  return { filter: { fieldName, stringFilter: { matchType: "EXACT", value, caseSensitive: false } } };
}

function inListDimension(fieldName, values) {
  return { filter: { fieldName, inListFilter: { values, caseSensitive: false } } };
}

function meaningfulValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(normalized && !["(not set)", "(not provided)", "(none)"].includes(normalized));
}

function hasMeaningfulLink(row) {
  return meaningfulValue(row.linkUrl) || meaningfulValue(row.fileName) || meaningfulValue(row.linkText);
}

function isInternalTransition(row) {
  try {
    const from = new URL(String(row.pageReferrer || ""));
    const to = new URL(String(row.pageLocation || ""));
    return from.hostname && from.hostname === to.hostname && `${from.pathname}${from.search}` !== `${to.pathname}${to.search}`;
  } catch { return false; }
}

function isAttributedCampaignRow(row) {
  const name = String(row.sessionManualCampaignName || "").trim().toLowerCase();
  const id = String(row.sessionManualCampaignId || "").trim().toLowerCase();
  return !["", "(not set)", "(direct)"].includes(name) || !["", "(not set)"].includes(id);
}

function metricChange(currentValue, previousValue) {
  const current = finiteMetric(currentValue);
  const previous = finiteMetric(previousValue);
  if (current == null || previous == null) return { current, previous, absolute: null, percent: null };
  const absolute = current - previous;
  return { current, previous, absolute, percent: previous === 0 ? null : (absolute / previous) * 100 };
}

function finiteMetric(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

async function verifyAnalyticsRead(userId, projectId, propertyId, env, suppliedCredentials) {
  const authorized = suppliedCredentials
    ? { credentials: suppliedCredentials, accessToken: await validGoogleAccessToken(userId, projectId, suppliedCredentials, env) }
    : await authorizedAnalyticsCredentials(userId, projectId, env);
  const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(propertyId)}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authorized.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ dateRanges: [{ startDate: "7daysAgo", endDate: "today" }], metrics: [{ name: "activeUsers" }], limit: "1" }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw analyticsError(providerMessage(data, "The selected Analytics property could not be read. Confirm that the Data API is enabled."), response.status === 403 ? 403 : 502);
  return true;
}

async function authorizedAnalyticsCredentials(userId, projectId, env) {
  const credentials = await readAnalyticsCredentials(userId, projectId, env);
  if (!credentials) throw analyticsError("Connect Google Analytics first.", 409);
  return { credentials, accessToken: await validGoogleAccessToken(userId, projectId, credentials, env) };
}

async function validGoogleAccessToken(userId, projectId, credentials, env) {
  if (credentials.accessToken && Number(credentials.expiresAt || 0) > Date.now() + 60_000) return credentials.accessToken;
  if (!credentials.refreshToken) throw analyticsError("Google Analytics access expired. Reconnect it.", 401);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_OAUTH_CLIENT_ID, client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET, refresh_token: credentials.refreshToken, grant_type: "refresh_token" }),
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.access_token) throw analyticsError("Google Analytics access expired. Reconnect it.", 401);
  credentials.accessToken = tokens.access_token;
  credentials.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
  await getPool(env).query(
    "UPDATE market_agent_connections SET encrypted_credentials = $3, updated_at = NOW() WHERE user_id = $1 AND project_id = $2 AND provider = $4",
    [userId, projectId, encryptCredentials(credentials, env), PROVIDER],
  );
  return credentials.accessToken;
}

async function listAnalyticsProperties(accessToken) {
  const properties = [];
  let pageToken = "";
  do {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    url.searchParams.set("pageSize", "200");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw analyticsError(providerMessage(data, "Google Analytics could not list available properties. Confirm that the Admin API is enabled."), response.status === 403 ? 403 : 502);
    for (const account of data.accountSummaries || []) {
      for (const property of account.propertySummaries || []) {
        const id = cleanPropertyId(property.property);
        if (id) properties.push({ id, name: String(property.displayName || `Property ${id}`).slice(0, 250), account: String(account.displayName || "").slice(0, 250) });
      }
    }
    pageToken = String(data.nextPageToken || "");
  } while (pageToken && properties.length < 500);
  return normalizeProperties(properties);
}

function reportRows(report) {
  const dimensions = (report.dimensionHeaders || []).map((item) => item.name);
  const metrics = (report.metricHeaders || []).map((item) => item.name);
  return (report.rows || []).map((row) => Object.fromEntries([
    ...dimensions.map((name, index) => [name, row.dimensionValues?.[index]?.value || ""]),
    ...metrics.map((name, index) => [name, Number(row.metricValues?.[index]?.value || 0)]),
  ]));
}

function normalizeProperties(values) {
  if (!Array.isArray(values)) return [];
  const result = [];
  for (const value of values) {
    const id = cleanPropertyId(value?.id || value?.property);
    if (!id || result.some((item) => item.id === id)) continue;
    result.push({ id, name: String(value?.name || value?.displayName || `Property ${id}`).slice(0, 250), account: String(value?.account || "").slice(0, 250) });
  }
  return result.slice(0, 500);
}

function cleanPropertyId(value) {
  return String(value || "").replace(/^properties\//, "").trim().replace(/[^0-9]/g, "").slice(0, 30);
}

async function readAnalyticsCredentials(userId, projectId, env) {
  await ensureAnalyticsTable(env);
  const result = await getPool(env).query("SELECT encrypted_credentials FROM market_agent_connections WHERE user_id = $1 AND project_id = $2 AND provider = $3 LIMIT 1", [userId, projectId, PROVIDER]);
  if (!result.rows[0]?.encrypted_credentials) return null;
  try { return decryptCredentials(result.rows[0].encrypted_credentials, env); } catch { return null; }
}

async function ensureAnalyticsTable(env) {
  if (analyticsTableReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_connections (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'project-default', provider TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '', account_label TEXT NOT NULL DEFAULT '', account_email TEXT NOT NULL DEFAULT '',
      encrypted_credentials TEXT NOT NULL, scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], status TEXT NOT NULL DEFAULT 'connected',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, project_id, provider)
    );
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'project-default';
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_label TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_email TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_connections DROP CONSTRAINT IF EXISTS market_agent_connections_pkey;
    CREATE UNIQUE INDEX IF NOT EXISTS market_agent_connections_user_project_provider_uidx ON market_agent_connections (user_id, project_id, provider);
  `);
  analyticsTableReady = true;
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
  if (secret.length < 32) throw analyticsError("Secure Analytics storage is not configured.", 503);
  return createHash("sha256").update(secret).digest();
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw analyticsError("The application address is invalid.", 400);
  return url.origin;
}

function requireAnalyticsConnector(env) {
  if (!analyticsConnectorConfigured(env)) throw analyticsError("Google Analytics authorization is not configured yet.", 503);
}

function providerMessage(data, fallback) {
  return String(data?.error?.message || data?.error_description || data?.message || fallback).slice(0, 800);
}

function analyticsError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
