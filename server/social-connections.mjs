import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { getPool } from "./db.mjs";

export const SOCIAL_PROVIDERS = ["linkedin", "instagram", "tiktok", "x"];

const SOCIAL_SCOPES = {
  linkedin: ["openid", "profile", "email", "w_member_social"],
  instagram: ["instagram_business_basic", "instagram_business_content_publish"],
  tiktok: ["user.info.basic", "video.publish"],
  x: ["tweet.read", "tweet.write", "users.read", "offline.access"],
};

let socialTableReady = false;

export async function getSocialConnectionStatus(userId, projectId = "project-default", env = process.env) {
  const status = emptySocialStatus(env);
  if (!env.DATABASE_URL) return status;
  await ensureSocialTable(env);
  const result = await getPool(env).query(
    `SELECT provider, account_id, account_label, account_email, scopes, status, connected_at, updated_at
       FROM market_agent_connections
      WHERE user_id = $1 AND project_id = $2 AND provider = ANY($3::text[])`,
    [userId, projectId, SOCIAL_PROVIDERS],
  );
  for (const row of result.rows) {
    if (row.status !== "connected" || !SOCIAL_PROVIDERS.includes(row.provider)) continue;
    const scopes = Array.isArray(row.scopes) ? row.scopes : [];
    status[row.provider] = {
      configured: socialConnectorConfigured(row.provider, env),
      connected: true,
      accountId: row.account_id || "",
      accountLabel: row.account_label || row.account_email || "",
      scopes,
      connectedAt: row.connected_at || row.updated_at || null,
      canPublish: providerCanPublish(row.provider, scopes),
    };
  }
  return status;
}

export async function createSocialAuthorizationUrl({ provider, userId, projectId, origin }, env = process.env) {
  if (!SOCIAL_PROVIDERS.includes(provider)) throw connectionError("That social connection is not supported.", 400);
  requireSocialConnector(provider, env);
  const redirectUri = `${normalizeOrigin(origin)}/api/social-callback`;
  const codeVerifier = provider === "x" ? randomBytes(48).toString("base64url") : "";
  const state = await createConnectionState({ userId, projectId, provider, redirectUri, codeVerifier }, env);

  if (provider === "linkedin") {
    return authorizationUrl("https://www.linkedin.com/oauth/v2/authorization", {
      response_type: "code",
      client_id: env.LINKEDIN_CLIENT_ID,
      redirect_uri: redirectUri,
      state,
      scope: SOCIAL_SCOPES.linkedin.join(" "),
    });
  }
  if (provider === "instagram") {
    return authorizationUrl("https://www.instagram.com/oauth/authorize", {
      enable_fb_login: "0",
      force_authentication: "1",
      client_id: env.INSTAGRAM_APP_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SOCIAL_SCOPES.instagram.join(","),
      state,
    });
  }
  if (provider === "tiktok") {
    return authorizationUrl("https://www.tiktok.com/v2/auth/authorize/", {
      client_key: env.TIKTOK_CLIENT_KEY,
      response_type: "code",
      scope: SOCIAL_SCOPES.tiktok.join(","),
      redirect_uri: redirectUri,
      state,
      disable_auto_auth: "1",
    });
  }

  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  return authorizationUrl("https://x.com/i/oauth2/authorize", {
    response_type: "code",
    client_id: env.X_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SOCIAL_SCOPES.x.join(" "),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
}

export async function finishSocialAuthorization({ code, state }, env = process.env) {
  if (!code || !state) throw connectionError("The social network did not return a complete authorization response.", 400);
  const request = await readConnectionState(state, env);
  if (!SOCIAL_PROVIDERS.includes(request.provider)) throw connectionError("The connection request is invalid.", 400);
  requireSocialConnector(request.provider, env);
  const result = await finishProvider(request.provider, code, request, env);
  await storeConnection({ userId: request.userId, projectId: request.projectId, provider: request.provider, ...result }, env);
  return { provider: request.provider, userId: request.userId, projectId: request.projectId, accountLabel: result.accountLabel };
}

export async function disconnectSocialConnection(userId, projectId, provider, env = process.env) {
  if (!SOCIAL_PROVIDERS.includes(provider)) throw connectionError("That social connection is not supported.", 400);
  await ensureSocialTable(env);
  await getPool(env).query(
    "DELETE FROM market_agent_connections WHERE user_id = $1 AND project_id = $2 AND provider = $3",
    [userId, projectId || "project-default", provider],
  );
}

export function socialConnectorConfigured(provider, env = process.env) {
  const secure = Boolean(env.CONNECTION_ENCRYPTION_KEY);
  if (provider === "linkedin") return Boolean(secure && env.LINKEDIN_CLIENT_ID && env.LINKEDIN_CLIENT_SECRET);
  if (provider === "instagram") return Boolean(secure && env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
  if (provider === "tiktok") return Boolean(secure && env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET);
  if (provider === "x") return Boolean(secure && env.X_CLIENT_ID && env.X_CLIENT_SECRET);
  return false;
}

async function finishProvider(provider, code, request, env) {
  if (provider === "linkedin") return finishLinkedIn(code, request, env);
  if (provider === "instagram") return finishInstagram(code, request, env);
  if (provider === "tiktok") return finishTikTok(code, request, env);
  return finishX(code, request, env);
}

async function finishLinkedIn(code, request, env) {
  const tokens = await exchangeFormToken("https://www.linkedin.com/oauth/v2/accessToken", {
    grant_type: "authorization_code",
    code,
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
    redirect_uri: request.redirectUri,
  }, "LinkedIn");
  const profile = await fetchJson("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }, "LinkedIn could not read the authorized profile.");
  return {
    accountId: String(profile.sub || ""),
    accountLabel: String(profile.name || profile.email || "LinkedIn account"),
    accountEmail: String(profile.email || "").toLowerCase(),
    scopes: splitScopes(tokens.scope).length ? splitScopes(tokens.scope) : SOCIAL_SCOPES.linkedin,
    credentials: tokenCredentials(tokens),
  };
}

async function finishInstagram(code, request, env) {
  const tokens = await exchangeFormToken("https://api.instagram.com/oauth/access_token", {
    client_id: env.INSTAGRAM_APP_ID,
    client_secret: env.INSTAGRAM_APP_SECRET,
    grant_type: "authorization_code",
    redirect_uri: request.redirectUri,
    code,
  }, "Instagram");

  let accessToken = tokens.access_token;
  let expiresIn = Number(tokens.expires_in || 3600);
  const exchangeUrl = new URL("https://graph.instagram.com/access_token");
  exchangeUrl.search = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: env.INSTAGRAM_APP_SECRET,
    access_token: accessToken,
  }).toString();
  const longResponse = await fetch(exchangeUrl);
  const longToken = await longResponse.json().catch(() => ({}));
  if (longResponse.ok && longToken.access_token) {
    accessToken = longToken.access_token;
    expiresIn = Number(longToken.expires_in || expiresIn);
  }

  const profile = await fetchJson(`https://graph.instagram.com/me?fields=user_id,username,name,account_type,profile_picture_url&access_token=${encodeURIComponent(accessToken)}`, {}, "Instagram could not read the authorized profile.");
  const username = String(profile.username || "");
  return {
    accountId: String(profile.user_id || profile.id || tokens.user_id || ""),
    accountLabel: username ? `@${username}` : String(profile.name || "Instagram account"),
    accountEmail: "",
    scopes: SOCIAL_SCOPES.instagram,
    credentials: { accessToken, refreshToken: "", expiresAt: Date.now() + expiresIn * 1000, tokenType: "Bearer" },
  };
}

async function finishTikTok(code, request, env) {
  const tokens = await exchangeFormToken("https://open.tiktokapis.com/v2/oauth/token/", {
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: request.redirectUri,
  }, "TikTok");
  const profile = await fetchJson("https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }, "TikTok could not read the authorized profile.");
  const user = profile.data?.user || {};
  return {
    accountId: String(user.open_id || tokens.open_id || ""),
    accountLabel: String(user.display_name || "TikTok account"),
    accountEmail: "",
    scopes: splitScopes(tokens.scope),
    credentials: tokenCredentials(tokens),
  };
}

async function finishX(code, request, env) {
  const tokenResponse = await fetch("https://api.x.com/2/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      grant_type: "authorization_code",
      redirect_uri: request.redirectUri,
      code_verifier: request.codeVerifier,
    }),
  });
  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.access_token) throw connectionError(providerError("X", tokens), 400);
  const profile = await fetchJson("https://api.x.com/2/users/me?user.fields=name,username,profile_image_url", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }, "X could not read the authorized profile.");
  const user = profile.data || {};
  const username = String(user.username || "");
  return {
    accountId: String(user.id || ""),
    accountLabel: username ? `@${username}` : String(user.name || "X account"),
    accountEmail: "",
    scopes: splitScopes(tokens.scope),
    credentials: tokenCredentials(tokens),
  };
}

async function createConnectionState({ userId, projectId, provider, redirectUri, codeVerifier }, env) {
  return new EncryptJWT({
    u: String(userId),
    j: String(projectId || "project-default"),
    p: provider,
    r: redirectUri,
    v: codeVerifier || undefined,
    n: randomBytes(12).toString("base64url"),
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .encrypt(connectionKey(env));
}

async function readConnectionState(state, env) {
  let payload;
  try {
    ({ payload } = await jwtDecrypt(state, connectionKey(env), { clockTolerance: 5 }));
  } catch {
    throw connectionError("The connection request expired. Start the connection again.", 400);
  }
  const request = {
    userId: String(payload.u || ""),
    projectId: String(payload.j || "project-default"),
    provider: String(payload.p || ""),
    redirectUri: String(payload.r || ""),
    codeVerifier: String(payload.v || ""),
  };
  if (!request.userId || !/^https?:\/\//i.test(request.redirectUri)) throw connectionError("The connection request is invalid.", 400);
  return request;
}

async function exchangeFormToken(url, fields, providerName) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw connectionError(providerError(providerName, data), 400);
  return data;
}

async function fetchJson(url, options, errorMessage) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw connectionError(data.error?.message || data.message || errorMessage, 400);
  return data;
}

async function storeConnection({ userId, projectId, provider, accountId, accountLabel, accountEmail, scopes, credentials }, env) {
  await ensureSocialTable(env);
  await getPool(env).query(
    `INSERT INTO market_agent_connections
      (user_id, project_id, provider, account_id, account_label, account_email, encrypted_credentials, scopes, status, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], 'connected', NOW(), NOW())
     ON CONFLICT (user_id, project_id, provider) DO UPDATE SET
       account_id = EXCLUDED.account_id,
       account_label = EXCLUDED.account_label,
       account_email = EXCLUDED.account_email,
       encrypted_credentials = EXCLUDED.encrypted_credentials,
       scopes = EXCLUDED.scopes,
       status = 'connected',
       connected_at = NOW(),
       updated_at = NOW()`,
    [userId, projectId || "project-default", provider, accountId || "", accountLabel || "", accountEmail || "", encryptCredentials(credentials, env), scopes || []],
  );
}

async function ensureSocialTable(env) {
  if (socialTableReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_connections (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'project-default',
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '',
      account_label TEXT NOT NULL DEFAULT '',
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
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_label TEXT NOT NULL DEFAULT '';
    ALTER TABLE market_agent_connections DROP CONSTRAINT IF EXISTS market_agent_connections_pkey;
    CREATE UNIQUE INDEX IF NOT EXISTS market_agent_connections_user_project_provider_uidx
      ON market_agent_connections (user_id, project_id, provider);
  `);
  socialTableReady = true;
}

function emptySocialStatus(env) {
  const status = {};
  for (const provider of SOCIAL_PROVIDERS) {
    status[provider] = {
      configured: socialConnectorConfigured(provider, env),
      connected: false,
      accountId: "",
      accountLabel: "",
      scopes: [],
      connectedAt: null,
      canPublish: false,
    };
  }
  return status;
}

function authorizationUrl(base, fields) {
  const url = new URL(base);
  url.search = new URLSearchParams(fields).toString();
  return url.toString();
}

function tokenCredentials(tokens) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || "",
    expiresAt: Date.now() + Number(tokens.expires_in || 3600) * 1000,
    refreshExpiresAt: tokens.refresh_expires_in ? Date.now() + Number(tokens.refresh_expires_in) * 1000 : null,
    tokenType: tokens.token_type || "Bearer",
  };
}

function encryptCredentials(credentials, env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", connectionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
}

function connectionKey(env) {
  const secret = String(env.CONNECTION_ENCRYPTION_KEY || "");
  if (secret.length < 32) throw connectionError("Secure connection storage is not configured.", 503);
  return createHash("sha256").update(secret).digest();
}

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw connectionError("The application address is invalid.", 400);
  return url.origin;
}

function providerCanPublish(provider, scopes) {
  if (provider === "linkedin") return scopes.includes("w_member_social") || scopes.includes("w_organization_social");
  if (provider === "instagram") return scopes.includes("instagram_business_content_publish");
  if (provider === "tiktok") return scopes.includes("video.publish");
  return scopes.includes("tweet.write");
}

function splitScopes(value) {
  return String(value || "").split(/[\s,]+/).filter(Boolean);
}

function providerError(providerName, data) {
  const detail = data.error_description || data.error?.message || data.message || data.error;
  return detail ? `${providerName} could not finish the connection: ${String(detail)}` : `${providerName} could not finish the connection.`;
}

function providerLabel(provider) {
  return provider === "x" ? "X" : `${provider.charAt(0).toUpperCase()}${provider.slice(1)}`;
}

function requireSocialConnector(provider, env) {
  if (!socialConnectorConfigured(provider, env)) throw connectionError(`${providerLabel(provider)} authorization is not configured yet.`, 503);
}

function connectionError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
