import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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
      enable_fb_login: "false",
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

export async function publishSocialPost(userId, projectId, provider, payload, env = process.env) {
  if (!SOCIAL_PROVIDERS.includes(provider)) throw connectionError("Choose a supported social channel.", 400);
  const row = await readSocialConnection(userId, projectId, provider, env);
  if (!row || row.status !== "connected") throw connectionError(`Connect ${providerLabel(provider)} before publishing.`, 409);
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  if (!providerCanPublish(provider, scopes)) throw connectionError(`Reconnect ${providerLabel(provider)} and approve publishing access.`, 403);
  const credentials = decryptCredentials(row.encrypted_credentials, env);
  const accessToken = await validSocialAccessToken(userId, projectId, provider, credentials, env);
  const text = String(payload?.text || "").trim();
  if (!text) throw connectionError("The approved post has no copy.", 400);
  if (provider === "linkedin") return publishLinkedIn(row, accessToken, { ...payload, text }, env);
  if (provider === "instagram") return publishInstagram(row, accessToken, { ...payload, text }, env);
  if (provider === "tiktok") return publishTikTok(row, accessToken, { ...payload, text });
  return publishX(row, accessToken, text);
}

export async function getSocialPublishingOptions(userId, projectId, provider, env = process.env) {
  if (provider !== "tiktok") throw connectionError("Publishing options are not required for this channel.", 400);
  const row = await readSocialConnection(userId, projectId, provider, env);
  if (!row || row.status !== "connected") throw connectionError("Connect TikTok before reviewing publishing settings.", 409);
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  if (!providerCanPublish(provider, scopes)) throw connectionError("Reconnect TikTok and approve publishing access.", 403);
  const credentials = decryptCredentials(row.encrypted_credentials, env);
  const accessToken = await validSocialAccessToken(userId, projectId, provider, credentials, env);
  const creator = await readTikTokCreatorInfo(accessToken);
  return {
    provider,
    accountLabel: row.account_label || "TikTok account",
    privacyLevelOptions: creator.privacyLevelOptions,
    commentDisabled: creator.commentDisabled,
    duetDisabled: creator.duetDisabled,
    stitchDisabled: creator.stitchDisabled,
    maxVideoDurationSec: creator.maxVideoDurationSec,
  };
}

export async function getSocialPostStatus(userId, projectId, provider, externalId, env = process.env) {
  if (provider !== "tiktok") throw connectionError("Post status is not available for this channel.", 400);
  const row = await readSocialConnection(userId, projectId, provider, env);
  if (!row || row.status !== "connected") throw connectionError("Reconnect TikTok to check this post.", 409);
  const credentials = decryptCredentials(row.encrypted_credentials, env);
  const accessToken = await validSocialAccessToken(userId, projectId, provider, credentials, env);
  const response = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify({ publish_id: String(externalId || "") }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.error?.code && body.error.code !== "ok")) throw connectionError(providerError("TikTok", body), response.status === 401 ? 401 : 502);
  const providerStatus = String(body.data?.status || "");
  const publicIds = Array.isArray(body.data?.publicaly_available_post_id) ? body.data.publicaly_available_post_id.map(String) : [];
  return {
    status: providerStatus === "PUBLISH_COMPLETE" ? "complete" : providerStatus === "FAILED" ? "failed" : "submitted",
    providerStatus,
    failReason: String(body.data?.fail_reason || ""),
    publicPostIds: publicIds,
    uploadedBytes: Number(body.data?.uploaded_bytes || 0),
    downloadedBytes: Number(body.data?.downloaded_bytes || 0),
  };
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
    scopes: splitScopes(tokens.scope),
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
  const grantedScopes = new Set(splitScopes(tokens.scope));
  const permissionResponse = await fetch(`https://graph.instagram.com/me/permissions?access_token=${encodeURIComponent(accessToken)}`);
  const permissions = await permissionResponse.json().catch(() => ({}));
  if (permissionResponse.ok) {
    for (const item of permissions.data || []) if (item?.status === "granted" && item?.permission) grantedScopes.add(String(item.permission));
  }
  const username = String(profile.username || "");
  return {
    accountId: String(profile.user_id || profile.id || tokens.user_id || ""),
    accountLabel: username ? `@${username}` : String(profile.name || "Instagram account"),
    accountEmail: "",
    scopes: [...grantedScopes],
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
  if (!String(accountId || "").trim()) throw connectionError(`${providerLabel(provider)} did not return an account identifier. Reconnect the account.`, 400);
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

async function readSocialConnection(userId, projectId, provider, env) {
  await ensureSocialTable(env);
  const result = await getPool(env).query(
    `SELECT account_id, account_label, account_email, encrypted_credentials, scopes, status
       FROM market_agent_connections
      WHERE user_id = $1 AND project_id = $2 AND provider = $3 LIMIT 1`,
    [userId, projectId, provider],
  );
  return result.rows[0] || null;
}

async function validSocialAccessToken(userId, projectId, provider, credentials, env) {
  const expiryBuffer = provider === "instagram" ? 7 * 24 * 60 * 60 * 1000 : 60_000;
  if (credentials?.accessToken && Number(credentials.expiresAt || 0) > Date.now() + expiryBuffer) return credentials.accessToken;
  let refreshed;
  if (provider === "tiktok" && credentials?.refreshToken) {
    refreshed = await exchangeFormToken("https://open.tiktokapis.com/v2/oauth/token/", {
      client_key: env.TIKTOK_CLIENT_KEY,
      client_secret: env.TIKTOK_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
    }, "TikTok");
  } else if (provider === "x" && credentials?.refreshToken) {
    const response = await fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${env.X_CLIENT_ID}:${env.X_CLIENT_SECRET}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken }),
    });
    refreshed = await response.json().catch(() => ({}));
    if (!response.ok || !refreshed.access_token) throw connectionError("X access expired. Reconnect it.", 401);
  } else if (provider === "instagram" && credentials?.accessToken && Number(credentials.expiresAt || 0) > Date.now()) {
    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.search = new URLSearchParams({ grant_type: "ig_refresh_token", access_token: credentials.accessToken }).toString();
    const response = await fetch(url);
    refreshed = await response.json().catch(() => ({}));
    if (!response.ok || !refreshed.access_token) throw connectionError("Instagram access expired. Reconnect it.", 401);
  } else {
    throw connectionError(`${providerLabel(provider)} access expired. Reconnect it.`, 401);
  }
  credentials.accessToken = refreshed.access_token;
  credentials.refreshToken = refreshed.refresh_token || credentials.refreshToken || "";
  credentials.expiresAt = Date.now() + Number(refreshed.expires_in || 3600) * 1000;
  await getPool(env).query(
    "UPDATE market_agent_connections SET encrypted_credentials = $4, updated_at = NOW() WHERE user_id = $1 AND project_id = $2 AND provider = $3",
    [userId, projectId, provider, encryptCredentials(credentials, env)],
  );
  return credentials.accessToken;
}

async function publishLinkedIn(row, accessToken, payload, env) {
  const text = payload.text;
  if (text.length > 3000) throw connectionError("LinkedIn copy exceeds 3,000 characters.", 400);
  const mediaUrl = payload.mediaKind === "image" ? validMediaUrl(payload.mediaUrl) : "";
  const imageUrn = mediaUrl ? await uploadLinkedInImage(row, accessToken, mediaUrl, env) : "";
  const postBody = {
    author: `urn:li:person:${row.account_id}`,
    commentary: text,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (imageUrn) postBody.content = { media: { id: imageUrn } };
  const response = await fetch("https://api.linkedin.com/rest/posts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "Linkedin-Version": env.LINKEDIN_VERSION || "202609",
    },
    body: JSON.stringify(postBody),
  });
  const body = await response.text();
  if (!response.ok) throw connectionError(providerError("LinkedIn", parseProviderBody(body)), response.status === 401 ? 401 : 502);
  const externalId = response.headers.get("x-restli-id") || parseProviderBody(body)?.id || "";
  return { provider: "linkedin", externalId: String(externalId), accountLabel: row.account_label, publishedAt: new Date().toISOString() };
}

async function uploadLinkedInImage(row, accessToken, mediaUrl, env) {
  const version = env.LINKEDIN_VERSION || "202609";
  const owner = `urn:li:person:${row.account_id}`;
  const initializeResponse = await fetch("https://api.linkedin.com/rest/images?action=initializeUpload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "Linkedin-Version": version,
    },
    body: JSON.stringify({ initializeUploadRequest: { owner } }),
  });
  const initialized = await initializeResponse.json().catch(() => ({}));
  const uploadUrl = initialized.value?.uploadUrl;
  const imageUrn = initialized.value?.image;
  if (!initializeResponse.ok || !uploadUrl || !imageUrn) throw connectionError(providerError("LinkedIn", initialized), initializeResponse.status === 401 ? 401 : 502);
  const source = await fetch(mediaUrl, { redirect: "follow" });
  if (!source.ok || !source.body) throw connectionError("The approved LinkedIn image could not be downloaded for publishing.", 502);
  const contentType = String(source.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/gif"].includes(contentType)) throw connectionError("LinkedIn accepts approved JPG, PNG, or GIF images for this post.", 400);
  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": contentType },
    body: source.body,
    duplex: "half",
  });
  if (!uploadResponse.ok) {
    const detail = await uploadResponse.text().catch(() => "");
    throw connectionError(detail ? `LinkedIn could not receive the approved image: ${detail.slice(0, 300)}` : "LinkedIn could not receive the approved image.", 502);
  }
  return String(imageUrn);
}

async function publishX(row, accessToken, text) {
  if ([...text].length > 280) throw connectionError("X copy exceeds 280 characters.", 400);
  const response = await fetch("https://api.x.com/2/tweets", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.data?.id) throw connectionError(providerError("X", data), response.status === 401 ? 401 : 502);
  return { provider: "x", externalId: String(data.data.id), accountLabel: row.account_label, publishedAt: new Date().toISOString() };
}

async function publishInstagram(row, accessToken, payload, env) {
  const mediaUrl = validMediaUrl(payload.mediaUrl);
  if (!mediaUrl) throw connectionError("Instagram publishing requires an approved public image or video URL.", 400);
  const version = env.INSTAGRAM_GRAPH_VERSION || "v24.0";
  const mediaKind = payload.mediaKind === "video" ? "video" : "image";
  const fields = mediaKind === "video"
    ? { media_type: "REELS", video_url: mediaUrl, caption: payload.text, share_to_feed: "true", access_token: accessToken }
    : { image_url: mediaUrl, caption: payload.text, access_token: accessToken };
  const createResponse = await fetch(`https://graph.instagram.com/${version}/${encodeURIComponent(row.account_id)}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const container = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok || !container.id) throw connectionError(providerError("Instagram", container), createResponse.status === 401 ? 401 : 502);
  if (mediaKind === "video") {
    let ready = false;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const statusResponse = await fetch(`https://graph.instagram.com/${version}/${encodeURIComponent(container.id)}?fields=status_code,status&access_token=${encodeURIComponent(accessToken)}`);
      const status = await statusResponse.json().catch(() => ({}));
      if (status.status_code === "FINISHED") { ready = true; break; }
      if (status.status_code === "ERROR" || status.status_code === "EXPIRED") throw connectionError(providerError("Instagram", status), 502);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!ready) throw connectionError("Instagram is still processing the video. Try publishing again in a moment.", 409);
  }
  const publishResponse = await fetch(`https://graph.instagram.com/${version}/${encodeURIComponent(row.account_id)}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ creation_id: String(container.id), access_token: accessToken }),
  });
  const published = await publishResponse.json().catch(() => ({}));
  if (!publishResponse.ok || !published.id) throw connectionError(providerError("Instagram", published), publishResponse.status === 401 ? 401 : 502);
  return { provider: "instagram", externalId: String(published.id), accountLabel: row.account_label, publishedAt: new Date().toISOString() };
}

async function publishTikTok(row, accessToken, payload) {
  const mediaUrl = validMediaUrl(payload.mediaUrl);
  if (!mediaUrl) throw connectionError("TikTok publishing requires an approved public image or video.", 400);
  const creator = await readTikTokCreatorInfo(accessToken);
  const privacyOptions = creator.privacyLevelOptions;
  const requestedPrivacy = String(payload.privacyLevel || "SELF_ONLY");
  if (!privacyOptions.includes(requestedPrivacy)) {
    throw connectionError("TikTok's available visibility options changed. Review this item again before publishing.", 409);
  }
  const privacyLevel = requestedPrivacy;
  const disableComment = creator.commentDisabled ? true : Boolean(payload.disableComment);
  const disableDuet = creator.duetDisabled ? true : Boolean(payload.disableDuet);
  const disableStitch = creator.stitchDisabled ? true : Boolean(payload.disableStitch);
  const mediaKind = payload.mediaKind === "image" ? "image" : "video";
  const endpoint = mediaKind === "image"
    ? "https://open.tiktokapis.com/v2/post/publish/content/init/"
    : "https://open.tiktokapis.com/v2/post/publish/video/init/";
  let videoSource = null;
  let videoSize = 0;
  let videoContentType = "video/mp4";
  if (mediaKind === "video") {
    videoSource = await fetch(mediaUrl, { redirect: "follow" });
    if (!videoSource.ok || !videoSource.body) throw connectionError("The approved TikTok video could not be downloaded for publishing.", 502);
    videoSize = Number(videoSource.headers.get("content-length") || 0);
    if (!Number.isSafeInteger(videoSize) || videoSize <= 0) throw connectionError("The approved TikTok video host did not provide its file size.", 400);
    if (videoSize > 64 * 1024 * 1024) throw connectionError("TikTok video delivery currently supports approved files up to 64 MB.", 400);
    const returnedType = String(videoSource.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (["video/mp4", "video/quicktime", "video/webm"].includes(returnedType)) videoContentType = returnedType;
  }
  const body = mediaKind === "image"
    ? {
        post_info: { title: payload.text.slice(0, 90), description: payload.text.slice(0, 4000), disable_comment: disableComment, privacy_level: privacyLevel, auto_add_music: true, brand_organic_toggle: payload.brandOrganicToggle !== false, brand_content_toggle: Boolean(payload.brandContentToggle) },
        source_info: { source: "PULL_FROM_URL", photo_cover_index: 0, photo_images: [mediaUrl] },
        post_mode: "DIRECT_POST",
        media_type: "PHOTO",
        is_aigc: Boolean(payload.aiGenerated),
      }
    : {
        post_info: { title: payload.text.slice(0, 2200), privacy_level: privacyLevel, disable_duet: disableDuet, disable_comment: disableComment, disable_stitch: disableStitch, is_aigc: Boolean(payload.aiGenerated), brand_organic_toggle: payload.brandOrganicToggle !== false, brand_content_toggle: Boolean(payload.brandContentToggle) },
        source_info: { source: "FILE_UPLOAD", video_size: videoSize, chunk_size: videoSize, total_chunk_count: 1 },
      };
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || (data.error?.code && data.error.code !== "ok") || !data.data?.publish_id) throw connectionError(providerError("TikTok", data), response.status === 401 ? 401 : 502);
  if (mediaKind === "video") {
    if (!data.data?.upload_url || !videoSource?.body) throw connectionError("TikTok did not return a video upload destination.", 502);
    const uploadResponse = await fetch(data.data.upload_url, {
      method: "PUT",
      headers: {
        "Content-Type": videoContentType,
        "Content-Length": String(videoSize),
        "Content-Range": `bytes 0-${videoSize - 1}/${videoSize}`,
      },
      body: videoSource.body,
      duplex: "half",
    });
    if (uploadResponse.status !== 201) {
      const detail = await uploadResponse.text().catch(() => "");
      throw connectionError(detail ? `TikTok could not receive the approved video: ${detail.slice(0, 300)}` : "TikTok could not receive the approved video.", 502);
    }
  }
  return { provider: "tiktok", externalId: String(data.data.publish_id), accountLabel: row.account_label, status: "processing", publishedAt: new Date().toISOString() };
}

async function readTikTokCreatorInfo(accessToken) {
  const response = await fetch("https://open.tiktokapis.com/v2/post/publish/creator_info/query/", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.error?.code && body.error.code !== "ok")) {
    throw connectionError(providerError("TikTok", body), response.status === 401 ? 401 : 502);
  }
  const privacyLevelOptions = Array.isArray(body.data?.privacy_level_options)
    ? body.data.privacy_level_options.map(String).filter(Boolean)
    : [];
  if (!privacyLevelOptions.length) throw connectionError("TikTok did not return any available visibility option for this account.", 409);
  return {
    privacyLevelOptions,
    commentDisabled: Boolean(body.data?.comment_disabled),
    duetDisabled: Boolean(body.data?.duet_disabled),
    stitchDisabled: Boolean(body.data?.stitch_disabled),
    maxVideoDurationSec: Math.max(0, Number(body.data?.max_video_post_duration_sec || 0)),
  };
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

function parseProviderBody(value) {
  try { return JSON.parse(String(value || "{}")); } catch { return { message: String(value || "").slice(0, 500) }; }
}

function validMediaUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : "";
  } catch { return ""; }
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
