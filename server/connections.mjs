import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { getPool } from "./db.mjs";
import { getSocialConnectionStatus } from "./social-connections.mjs";
import { getAnalyticsConnectionStatus } from "./analytics.mjs";

const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/gmail.send",
];

let connectionsTableReady = false;

export async function getConnectionStatus(userId, projectId = "project-default", env = process.env) {
  const configured = googleConnectorConfigured(env);
  const [social, analytics] = await Promise.all([
    getSocialConnectionStatus(userId, projectId, env),
    getAnalyticsConnectionStatus(userId, projectId, env),
  ]);
  if (!env.DATABASE_URL) return { ...emptyStatus(configured), analytics, ...social };
  await ensureConnectionsTable(env);
  const result = await getPool(env).query(
    `SELECT account_email, scopes, status, connected_at, updated_at
       FROM market_agent_connections
      WHERE user_id = $1 AND project_id = $2 AND provider = 'google-gmail'
      LIMIT 1`,
    [userId, projectId],
  );
  const row = result.rows[0];
  if (!row || row.status !== "connected") return { ...emptyStatus(configured), analytics, ...social };
  return {
    gmail: {
      configured,
      connected: true,
      accountEmail: row.account_email || "",
      scopes: Array.isArray(row.scopes) ? row.scopes : [],
      connectedAt: row.connected_at || row.updated_at || null,
      canSend: Array.isArray(row.scopes) && row.scopes.includes("https://www.googleapis.com/auth/gmail.send"),
    },
    analytics,
    ...social,
  };
}

export async function createGoogleAuthorizationUrl({ userId, projectId, appEmail, origin }, env = process.env) {
  requireGoogleConnector(env);
  const redirectUri = `${normalizeOrigin(origin)}/api/google-callback`;
  const state = await new EncryptJWT({
    userId,
    projectId: String(projectId || "project-default"),
    appEmail: String(appEmail || "").slice(0, 320),
    redirectUri,
    nonce: randomBytes(18).toString("base64url"),
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
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent select_account",
    state,
  }).toString();
  return authorizationUrl.toString();
}

export async function finishGoogleAuthorization({ code, state }, env = process.env) {
  requireGoogleConnector(env);
  if (!code || !state) throw connectionError("Google did not return a complete authorization response.", 400);

  let payload;
  try {
    ({ payload } = await jwtDecrypt(state, connectionKey(env), { clockTolerance: 5 }));
  } catch {
    throw connectionError("The mailbox connection request expired. Start the connection again.", 400);
  }
  const userId = String(payload.userId || "");
  const projectId = String(payload.projectId || "project-default");
  const redirectUri = String(payload.redirectUri || "");
  if (!userId || !/^https?:\/\//i.test(redirectUri)) throw connectionError("The mailbox connection request is invalid.", 400);

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
  if (!tokenResponse.ok || !tokens.access_token) throw connectionError("Google could not finish connecting this mailbox.", 400);

  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = await profileResponse.json().catch(() => ({}));
  if (!profileResponse.ok || !profile.email || profile.email_verified === false) {
    throw connectionError("Google did not provide a verified mailbox address.", 400);
  }

  const grantedScopes = String(tokens.scope || "").split(/\s+/).filter(Boolean);
  if (!grantedScopes.includes("https://www.googleapis.com/auth/gmail.send")) {
    throw connectionError("The mailbox was connected without sending permission. Try again and allow email sending.", 400);
  }

  await ensureConnectionsTable(env);
  const existing = await readEncryptedCredentials(userId, projectId, env);
  const credentials = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || existing?.refreshToken || "",
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    tokenType: tokens.token_type || "Bearer",
  };
  if (!credentials.refreshToken) throw connectionError("Google did not provide offline access. Reconnect and approve access again.", 400);

  await getPool(env).query(
    `INSERT INTO market_agent_connections
      (user_id, project_id, provider, account_email, encrypted_credentials, scopes, status, connected_at, updated_at)
     VALUES ($1, $2, 'google-gmail', $3, $4, $5::text[], 'connected', NOW(), NOW())
     ON CONFLICT (user_id, project_id, provider) DO UPDATE SET
       account_email = EXCLUDED.account_email,
       encrypted_credentials = EXCLUDED.encrypted_credentials,
       scopes = EXCLUDED.scopes,
       status = 'connected',
       connected_at = NOW(),
       updated_at = NOW()`,
    [userId, projectId, String(profile.email).toLowerCase(), encryptCredentials(credentials, env), grantedScopes],
  );
  return { userId, projectId, accountEmail: String(profile.email).toLowerCase(), redirectUri };
}

export async function disconnectGoogleMailbox(userId, projectId = "project-default", env = process.env) {
  await ensureConnectionsTable(env);
  await getPool(env).query(
    "DELETE FROM market_agent_connections WHERE user_id = $1 AND project_id = $2 AND provider = 'google-gmail'",
    [userId, projectId],
  );
}

export async function sendGmailMessage(userId, projectId, message, env = process.env) {
  const to = normalizeEmailList(message?.to, 50);
  const cc = normalizeEmailList(message?.cc, 25);
  const bcc = normalizeEmailList(message?.bcc, 25);
  const subject = cleanHeader(message?.subject, 300);
  const body = String(message?.body || "").trim().slice(0, 100_000);
  if (!to.length) throw connectionError("The approved email needs at least one valid recipient.", 400);
  if (!subject || !body) throw connectionError("The approved email needs a subject and message.", 400);
  const row = await readGoogleConnection(userId, projectId, env);
  if (!row || row.status !== "connected") throw connectionError("Connect the project mailbox before sending email.", 409);
  if (!Array.isArray(row.scopes) || !row.scopes.includes("https://www.googleapis.com/auth/gmail.send")) throw connectionError("Reconnect the mailbox and approve sending access.", 403);
  const credentials = decryptCredentials(row.encrypted_credentials, env);
  const accessToken = await validGoogleAccessToken(userId, projectId, credentials, env);
  const mime = [
    `From: ${cleanHeader(row.account_email, 320)}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    ...(bcc.length ? [`Bcc: ${bcc.join(", ")}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.id) throw connectionError(providerMessage(data, "Gmail could not send the approved email."), response.status === 401 ? 401 : 502);
  return { provider: "google-gmail", externalId: String(data.id), threadId: String(data.threadId || ""), accountLabel: row.account_email, sentAt: new Date().toISOString() };
}

export function requestOrigin(req, env = process.env) {
  if (env.APP_BASE_URL) return normalizeOrigin(env.APP_BASE_URL);
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "").split(",")[0].trim();
  const protocol = String(req.headers?.["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https")).split(",")[0].trim();
  if (!host) throw connectionError("The application address could not be determined.", 400);
  return normalizeOrigin(`${protocol}://${host}`);
}

export function googleConnectorConfigured(env = process.env) {
  return Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.CONNECTION_ENCRYPTION_KEY);
}

async function ensureConnectionsTable(env) {
  if (connectionsTableReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_connections (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'project-default',
      provider TEXT NOT NULL,
      account_email TEXT NOT NULL DEFAULT '',
      encrypted_credentials TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      status TEXT NOT NULL DEFAULT 'connected',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, project_id, provider)
    );
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS project_id TEXT NOT NULL DEFAULT 'project-default';
    ALTER TABLE market_agent_connections DROP CONSTRAINT IF EXISTS market_agent_connections_pkey;
    CREATE UNIQUE INDEX IF NOT EXISTS market_agent_connections_user_project_provider_uidx
      ON market_agent_connections (user_id, project_id, provider);
  `);
  connectionsTableReady = true;
}

async function readEncryptedCredentials(userId, projectId, env) {
  await ensureConnectionsTable(env);
  const result = await getPool(env).query(
    "SELECT encrypted_credentials FROM market_agent_connections WHERE user_id = $1 AND project_id = $2 AND provider = 'google-gmail' LIMIT 1",
    [userId, projectId],
  );
  if (!result.rows[0]?.encrypted_credentials) return null;
  try {
    return decryptCredentials(result.rows[0].encrypted_credentials, env);
  } catch {
    return null;
  }
}

async function readGoogleConnection(userId, projectId, env) {
  await ensureConnectionsTable(env);
  const result = await getPool(env).query(
    "SELECT account_email, encrypted_credentials, scopes, status FROM market_agent_connections WHERE user_id = $1 AND project_id = $2 AND provider = 'google-gmail' LIMIT 1",
    [userId, projectId],
  );
  return result.rows[0] || null;
}

async function validGoogleAccessToken(userId, projectId, credentials, env) {
  if (credentials?.accessToken && Number(credentials.expiresAt || 0) > Date.now() + 60_000) return credentials.accessToken;
  if (!credentials?.refreshToken) throw connectionError("Mailbox access expired. Reconnect it.", 401);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.access_token) throw connectionError("Mailbox access expired. Reconnect it.", 401);
  credentials.accessToken = tokens.access_token;
  credentials.expiresAt = Date.now() + Number(tokens.expires_in || 3600) * 1000;
  await getPool(env).query(
    "UPDATE market_agent_connections SET encrypted_credentials = $3, updated_at = NOW() WHERE user_id = $1 AND project_id = $2 AND provider = 'google-gmail'",
    [userId, projectId, encryptCredentials(credentials, env)],
  );
  return credentials.accessToken;
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

function normalizeEmailList(value, maximum) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[;,\n]+/);
  const emails = [];
  for (const item of values) {
    const email = String(item || "").trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || emails.includes(email)) continue;
    emails.push(email);
    if (emails.length >= maximum) break;
  }
  return emails;
}

function cleanHeader(value, maximum) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, maximum);
}

function providerMessage(data, fallback) {
  return String(data?.error?.message || data?.error_description || data?.message || fallback).slice(0, 800);
}

function connectionKey(env) {
  const secret = String(env.CONNECTION_ENCRYPTION_KEY || "");
  if (secret.length < 32) throw connectionError("Secure mailbox storage is not configured.", 503);
  return createHash("sha256").update(secret).digest();
}

function requireGoogleConnector(env) {
  if (!googleConnectorConfigured(env)) throw connectionError("Google mailbox connection is not configured yet.", 503);
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw connectionError("The application address is invalid.", 400);
  return url.origin;
}

function emptyStatus(configured) {
  return { gmail: { configured, connected: false, accountEmail: "", scopes: [], connectedAt: null, canSend: false } };
}

function connectionError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
