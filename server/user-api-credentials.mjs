import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { getPool } from "./db.mjs";
import { getManagedSubscriptionStatus } from "./billing.mjs";

export const API_PROVIDERS = ["openai", "google", "anthropic"];

const ENVIRONMENT_KEYS = {
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

let credentialsTableReady = false;

export async function getUserApiCredentialStatus(userId, env = process.env) {
  await ensureCredentialsTable(env);
  const result = await getPool(env).query(
    `SELECT provider, key_hint, status, connected_at, updated_at
       FROM market_agent_user_api_credentials
      WHERE user_id = $1`,
    [userId],
  );
  const byProvider = new Map(result.rows.map((row) => [row.provider, row]));
  const credentials = Object.fromEntries(API_PROVIDERS.map((provider) => {
    const row = byProvider.get(provider);
    return [provider, {
      connected: Boolean(row && row.status === "connected"),
      hint: row?.key_hint || "",
      connectedAt: row?.connected_at || null,
      updatedAt: row?.updated_at || null,
    }];
  }));
  const connectedCount = API_PROVIDERS.filter((provider) => credentials[provider].connected).length;
  return {
    ready: credentials.openai.connected || credentials.google.connected,
    collaborationReady: API_PROVIDERS.every((provider) => credentials[provider].connected),
    mediaReady: credentials.openai.connected || credentials.google.connected,
    videoReady: credentials.google.connected,
    connectedCount,
    credentials,
  };
}

export async function saveUserApiCredential(userId, provider, apiKey, env = process.env) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedKey = validateApiKey(apiKey);
  await ensureCredentialsTable(env);
  await getPool(env).query(
    `INSERT INTO market_agent_user_api_credentials
      (user_id, provider, encrypted_key, key_hint, status, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, 'connected', NOW(), NOW())
     ON CONFLICT (user_id, provider) DO UPDATE SET
       encrypted_key = EXCLUDED.encrypted_key,
       key_hint = EXCLUDED.key_hint,
       status = 'connected',
       connected_at = NOW(),
       updated_at = NOW()`,
    [userId, normalizedProvider, encryptApiKey(normalizedKey, env), normalizedKey.slice(-4)],
  );
  return getUserApiCredentialStatus(userId, env);
}

export async function deleteUserApiCredential(userId, provider, env = process.env) {
  const normalizedProvider = normalizeProvider(provider);
  await ensureCredentialsTable(env);
  await getPool(env).query(
    "DELETE FROM market_agent_user_api_credentials WHERE user_id = $1 AND provider = $2",
    [userId, normalizedProvider],
  );
  return getUserApiCredentialStatus(userId, env);
}

export async function loadUserApiEnv(userId, env = process.env) {
  await ensureCredentialsTable(env);
  const result = await getPool(env).query(
    `SELECT provider, encrypted_key
       FROM market_agent_user_api_credentials
      WHERE user_id = $1 AND status = 'connected'`,
    [userId],
  );
  const keys = Object.fromEntries(API_PROVIDERS.map((provider) => [provider, ""]));
  for (const row of result.rows) {
    if (!API_PROVIDERS.includes(row.provider)) continue;
    try {
      keys[row.provider] = decryptApiKey(row.encrypted_key, env);
    } catch {
      keys[row.provider] = "";
    }
  }

  const subscription = await getManagedSubscriptionStatus(userId, env);
  const hasPrivateCore = Boolean(keys.openai || keys.google);
  const accessMode = hasPrivateCore ? "byok" : subscription.active ? "managed" : subscription.trial.active ? "trial" : "expired";
  const platformKeys = {
    openai: String(env.OPENAI_API_KEY || ""),
    google: String(env.GOOGLE_GENERATIVE_AI_API_KEY || ""),
    anthropic: String(env.ANTHROPIC_API_KEY || ""),
  };
  const usePlatformWorkKeys = accessMode === "managed" || accessMode === "trial";

  // These explicit assignments are the isolation boundary: a deployment owner's
  // credentials become available for work only during the demo or an active paid
  // managed plan. Users with their own core API always run exclusively on their keys.
  return {
    ...env,
    STARTER_OPENAI_API_KEY: platformKeys.openai,
    [ENVIRONMENT_KEYS.openai]: hasPrivateCore ? keys.openai : usePlatformWorkKeys ? platformKeys.openai : "",
    [ENVIRONMENT_KEYS.google]: hasPrivateCore ? keys.google : usePlatformWorkKeys ? platformKeys.google : "",
    [ENVIRONMENT_KEYS.anthropic]: hasPrivateCore ? keys.anthropic : usePlatformWorkKeys ? platformKeys.anthropic : "",
    MARKET_AGENT_ACCESS_MODE: accessMode,
    MARKET_AGENT_TEXT_ONLY: accessMode === "managed" || accessMode === "trial" ? "true" : "false",
    MARKET_AGENT_MEDIA_BILLING_OWNER: hasPrivateCore ? "user" : "disabled",
  };
}

async function ensureCredentialsTable(env) {
  if (credentialsTableReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_user_api_credentials (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('openai', 'google', 'anthropic')),
      encrypted_key TEXT NOT NULL,
      key_hint TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'invalid')),
      connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, provider)
    )
  `);
  credentialsTableReady = true;
}

function normalizeProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (!API_PROVIDERS.includes(value)) throw credentialError("Choose a valid API connection.", 400);
  return value;
}

function validateApiKey(apiKey) {
  const value = String(apiKey || "").trim();
  if (value.length < 20 || value.length > 1024 || /\s/.test(value)) {
    throw credentialError("Paste a complete API key without spaces.", 400);
  }
  return value;
}

function encryptApiKey(apiKey, env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(apiKey, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url")).join(".");
}

function decryptApiKey(value, env) {
  const [ivValue, tagValue, encryptedValue] = String(value || "").split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Invalid encrypted API key");
  const decipher = createDecipheriv("aes-256-gcm", credentialKey(env), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

function credentialKey(env) {
  const secret = String(env.CONNECTION_ENCRYPTION_KEY || "");
  if (secret.length < 32) throw credentialError("Secure API-key storage is not configured.", 503);
  return createHash("sha256").update(secret).digest();
}

function credentialError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
