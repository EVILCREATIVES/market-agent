import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { getPool } from "./db.mjs";

const SHOPIFY_SCOPES = ["write_products", "write_content", "write_files", "write_publications"];
let shopifyTableReady = false;

export async function getShopifyConnectionStatus(userId, projectId = "project-default", env = process.env) {
  const status = emptyShopifyStatus(env);
  if (!env.DATABASE_URL) return status;
  await ensureShopifyTable(env);
  const result = await getPool(env).query(
    `SELECT account_id, account_label, scopes, status, connected_at, updated_at
       FROM market_agent_connections
      WHERE user_id = $1 AND project_id = $2 AND provider = 'shopify' LIMIT 1`,
    [userId, projectId],
  );
  const row = result.rows[0];
  if (!row || row.status !== "connected") return status;
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  return {
    configured: shopifyConnectorConfigured(env),
    connected: true,
    storeDomain: row.account_id || "",
    storeName: row.account_label || row.account_id || "Shopify store",
    scopes,
    connectedAt: row.connected_at || row.updated_at || null,
    canManage: requiredScopesGranted(scopes),
  };
}

export async function createShopifyAuthorizationUrl({ userId, projectId, origin, storeDomain }, env = process.env) {
  requireShopifyConnector(env);
  const shop = normalizeShopDomain(storeDomain);
  const redirectUri = `${normalizeOrigin(origin)}/api/shopify-callback`;
  const state = await new EncryptJWT({
    u: String(userId),
    j: String(projectId || "project-default"),
    s: shop,
    r: redirectUri,
    n: randomBytes(18).toString("base64url"),
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .encrypt(connectionKey(env));
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.search = new URLSearchParams({
    client_id: env.SHOPIFY_CLIENT_ID,
    scope: SHOPIFY_SCOPES.join(","),
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.toString();
}

export async function finishShopifyAuthorization(query, env = process.env) {
  requireShopifyConnector(env);
  const code = String(query?.code || "");
  const state = String(query?.state || "");
  const shop = normalizeShopDomain(query?.shop);
  if (!code || !state || !validShopifyHmac(query, env.SHOPIFY_CLIENT_SECRET)) {
    throw shopifyError("Shopify did not return a valid authorization response.", 400);
  }
  let payload;
  try {
    ({ payload } = await jwtDecrypt(state, connectionKey(env), { clockTolerance: 5 }));
  } catch {
    throw shopifyError("The Shopify connection request expired. Start the connection again.", 400);
  }
  const userId = String(payload.u || "");
  const projectId = String(payload.j || "project-default");
  const expectedShop = String(payload.s || "");
  const redirectUri = String(payload.r || "");
  if (!userId || shop !== expectedShop || !/^https?:\/\//i.test(redirectUri)) {
    throw shopifyError("The Shopify connection request is invalid.", 400);
  }
  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: env.SHOPIFY_CLIENT_ID, client_secret: env.SHOPIFY_CLIENT_SECRET, code }),
  });
  const tokens = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || !tokens.access_token) throw shopifyError(providerError(tokens, "Shopify could not finish connecting this store."), 400);
  const scopes = String(tokens.scope || SHOPIFY_SCOPES.join(",")).split(/[\s,]+/).filter(Boolean);
  if (!requiredScopesGranted(scopes)) throw shopifyError("The Shopify store was connected without the required product, content, file, and publishing permissions.", 400);
  const profile = await shopifyGraphql(shop, tokens.access_token, `query MarketAgentShop { shop { name myshopifyDomain } }`, {}, env);
  const canonicalShop = normalizeShopDomain(profile.shop?.myshopifyDomain || shop);
  const storeName = String(profile.shop?.name || canonicalShop).slice(0, 250);
  await ensureShopifyTable(env);
  await getPool(env).query(
    `INSERT INTO market_agent_connections
      (user_id, project_id, provider, account_id, account_label, account_email, encrypted_credentials, scopes, status, connected_at, created_at, updated_at)
     VALUES ($1,$2,'shopify',$3,$4,$3,$5,$6::text[],'connected',NOW(),NOW(),NOW())
     ON CONFLICT (user_id, project_id, provider) DO UPDATE SET
       account_id = EXCLUDED.account_id, account_label = EXCLUDED.account_label,
       account_email = EXCLUDED.account_email, encrypted_credentials = EXCLUDED.encrypted_credentials,
       scopes = EXCLUDED.scopes, status = 'connected', connected_at = NOW(), updated_at = NOW()`,
    [userId, projectId, canonicalShop, storeName, encryptCredentials({ accessToken: tokens.access_token, shop: canonicalShop }, env), scopes],
  );
  return { provider: "shopify", userId, projectId, storeDomain: canonicalShop, storeName };
}

export async function disconnectShopify(userId, projectId, env = process.env) {
  await ensureShopifyTable(env);
  await getPool(env).query(
    "DELETE FROM market_agent_connections WHERE user_id = $1 AND project_id = $2 AND provider = 'shopify'",
    [userId, projectId || "project-default"],
  );
}

export async function createShopifyDraft(userId, projectId, payload, env = process.env) {
  await ensureShopifyTable(env);
  const result = await getPool(env).query(
    `SELECT account_id, account_label, encrypted_credentials, scopes, status
       FROM market_agent_connections
      WHERE user_id = $1 AND project_id = $2 AND provider = 'shopify' LIMIT 1`,
    [userId, projectId || "project-default"],
  );
  const row = result.rows[0];
  if (!row || row.status !== "connected") throw shopifyError("Connect a Shopify store before creating a product draft.", 409);
  const scopes = Array.isArray(row.scopes) ? row.scopes : [];
  if (!requiredScopesGranted(scopes)) throw shopifyError("Reconnect Shopify and approve the required store permissions.", 403);
  const credentials = decryptCredentials(row.encrypted_credentials, env);
  const title = String(payload?.subject || "").replace(/[\r\n]+/g, " ").trim().slice(0, 255);
  const description = String(payload?.text || "").trim().slice(0, 50_000);
  if (!title || !description) throw shopifyError("A Shopify product draft requires an approved title and description.", 400);
  const mediaUrl = validPublicUrl(payload?.mediaUrl);
  const mediaKind = payload?.mediaKind === "video" ? "video" : "image";
  if (payload?.mediaUrl && !mediaUrl) throw shopifyError("The approved Shopify asset must use a public HTTPS URL.", 400);
  const media = mediaUrl ? [{ originalSource: mediaUrl, mediaContentType: mediaKind === "video" ? "VIDEO" : "IMAGE", alt: title }] : [];
  const mutation = `mutation MarketAgentProductDraft($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
    productCreate(product: $product, media: $media) {
      product { id title handle status }
      userErrors { field message }
    }
  }`;
  const data = await shopifyGraphql(row.account_id, credentials.accessToken, mutation, {
    product: { title, descriptionHtml: paragraphsToHtml(description), status: "DRAFT" },
    media,
  }, env);
  const errors = data.productCreate?.userErrors || [];
  if (errors.length || !data.productCreate?.product?.id) throw shopifyError(`Shopify could not create the draft: ${errors.map((item) => item.message).join("; ") || "No product was returned."}`, 400);
  const product = data.productCreate.product;
  return {
    provider: "shopify",
    externalId: String(product.id),
    accountLabel: row.account_label || row.account_id,
    draft: true,
    title: String(product.title || title),
    handle: String(product.handle || ""),
    status: "complete",
    publishedAt: new Date().toISOString(),
  };
}

export function shopifyConnectorConfigured(env = process.env) {
  return Boolean(env.SHOPIFY_CLIENT_ID && env.SHOPIFY_CLIENT_SECRET && env.CONNECTION_ENCRYPTION_KEY);
}

function emptyShopifyStatus(env) {
  return { configured: shopifyConnectorConfigured(env), connected: false, storeDomain: "", storeName: "", scopes: [], connectedAt: null, canManage: false };
}

function requiredScopesGranted(scopes) {
  return SHOPIFY_SCOPES.every((scope) => scopes.includes(scope));
}

async function shopifyGraphql(shop, accessToken, query, variables, env) {
  const version = String(env.SHOPIFY_API_VERSION || "2026-10");
  const response = await fetch(`https://${normalizeShopDomain(shop)}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.errors?.length) throw shopifyError(providerError(body, "Shopify rejected the store request."), response.status === 401 ? 401 : 502);
  return body.data || {};
}

function validShopifyHmac(query, secret) {
  const provided = String(query?.hmac || "");
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const message = Object.keys(query || {})
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort()
    .map((key) => `${key}=${Array.isArray(query[key]) ? query[key].join(",") : String(query[key] ?? "")}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest("hex");
  return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
}

function normalizeShopDomain(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw)) throw shopifyError("Enter the store's permanent address, such as your-store.myshopify.com.", 400);
  return raw;
}

function normalizeOrigin(value) {
  const url = new URL(String(value || ""));
  if (!/^https?:$/.test(url.protocol)) throw shopifyError("The application address is invalid.", 400);
  return url.origin;
}

function validPublicUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password) return "";
    return url.toString();
  } catch { return ""; }
}

function paragraphsToHtml(value) {
  return String(value || "").split(/\n{2,}/).map((part) => `<p>${escapeHtml(part).replace(/\n/g, "<br>")}</p>`).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function encryptCredentials(credentials, env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", connectionKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
}

function decryptCredentials(value, env) {
  const [ivValue, tagValue, encryptedValue] = String(value || "").split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw shopifyError("The Shopify connection is damaged. Reconnect it.", 401);
  const decipher = createDecipheriv("aes-256-gcm", connectionKey(env), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

function connectionKey(env) {
  const secret = String(env.CONNECTION_ENCRYPTION_KEY || "");
  if (secret.length < 32) throw shopifyError("Secure connection storage is not configured.", 503);
  return createHash("sha256").update(secret).digest();
}

async function ensureShopifyTable(env) {
  if (shopifyTableReady) return;
  await getPool(env).applySchema([
    `CREATE TABLE IF NOT EXISTS market_agent_connections (
      user_id TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT 'project-default', provider TEXT NOT NULL,
      account_id TEXT NOT NULL DEFAULT '', account_label TEXT NOT NULL DEFAULT '', account_email TEXT NOT NULL DEFAULT '',
      encrypted_credentials TEXT NOT NULL, scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], status TEXT NOT NULL DEFAULT 'connected',
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, project_id, provider)
    )`,
    `ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_label TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE market_agent_connections ADD COLUMN IF NOT EXISTS account_email TEXT NOT NULL DEFAULT ''`,
    `CREATE UNIQUE INDEX IF NOT EXISTS market_agent_connections_user_project_provider_uidx ON market_agent_connections (user_id, project_id, provider)`,
  ]);
  shopifyTableReady = true;
}

function providerError(data, fallback) {
  const detail = data?.errors?.map?.((item) => item.message).join("; ") || data?.error_description || data?.error || data?.message;
  return detail ? `${fallback} ${String(detail)}` : fallback;
}

function requireShopifyConnector(env) {
  if (!shopifyConnectorConfigured(env)) throw shopifyError("Shopify authorization is not configured yet.", 503);
}

function shopifyError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
