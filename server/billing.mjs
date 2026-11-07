import { randomBytes } from "node:crypto";
import { getPool } from "./db.mjs";

const TRIAL_DAYS = 10;
const MANAGED_PRICE = "29.99";
const MANAGED_CURRENCY = "USD";
let billingTablesReady = false;

export async function getManagedSubscriptionStatus(userId, env = process.env) {
  await ensureBillingTables(env);
  await getPool(env).query(
    `INSERT INTO market_agent_access_periods (user_id, trial_started_at)
     VALUES ($1, NOW()) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
  const [subscriptionResult, accessResult] = await Promise.all([
    getPool(env).query(
      `SELECT subscription_id, plan_id, status, payer_email, created_at, updated_at
         FROM market_agent_subscriptions WHERE user_id = $1 LIMIT 1`,
      [userId],
    ),
    getPool(env).query(
      `SELECT trial_started_at FROM market_agent_access_periods WHERE user_id = $1 LIMIT 1`,
      [userId],
    ),
  ]);
  const row = subscriptionResult.rows[0];
  const trialStartedAt = accessResult.rows[0]?.trial_started_at ? new Date(accessResult.rows[0].trial_started_at) : new Date();
  const trialEndsAt = new Date(trialStartedAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  const trialActive = Date.now() < trialEndsAt.getTime();
  const daysRemaining = trialActive ? Math.max(1, Math.ceil((trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : 0;
  const active = row?.status === "active";
  const platformApisConfigured = Boolean(env.OPENAI_API_KEY && env.GOOGLE_GENERATIVE_AI_API_KEY && env.ANTHROPIC_API_KEY);
  const paypalConfigured = Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET && env.PAYPAL_PLAN_ID);

  return {
    checked: true,
    configured: paypalConfigured && platformApisConfigured,
    paypalConfigured,
    platformApisConfigured,
    active,
    status: row?.status || "none",
    subscriptionId: row?.subscription_id || "",
    payerEmail: row?.payer_email || "",
    planName: "Managed text plan",
    price: MANAGED_PRICE,
    currency: MANAGED_CURRENCY,
    mediaIncluded: false,
    collaborationReady: active && platformApisConfigured,
    trial: {
      active: trialActive,
      daysRemaining,
      endsAt: trialEndsAt.toISOString(),
    },
  };
}

export async function createManagedSubscription(userId, origin, env = process.env) {
  await ensureBillingTables(env);
  requirePayPalConfiguration(env);
  await verifyManagedPlan(env);
  const current = await getPool(env).query(
    `SELECT subscription_id, approval_url, status, updated_at
       FROM market_agent_subscriptions WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const existing = current.rows[0];
  if (existing?.status === "active") return { active: true, subscriptionId: existing.subscription_id, approvalUrl: "" };
  if (existing?.status === "approval_pending" && existing.approval_url && Date.now() - new Date(existing.updated_at).getTime() < 24 * 60 * 60 * 1000) {
    return { active: false, subscriptionId: existing.subscription_id, approvalUrl: existing.approval_url };
  }

  const checkoutToken = randomBytes(24).toString("base64url");
  await getPool(env).query(
    `INSERT INTO market_agent_subscriptions
      (user_id, checkout_token, plan_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'creating', NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       checkout_token = EXCLUDED.checkout_token,
       plan_id = EXCLUDED.plan_id,
       subscription_id = '', approval_url = '', payer_email = '',
       status = 'creating', updated_at = NOW()`,
    [userId, checkoutToken, env.PAYPAL_PLAN_ID],
  );

  const safeOrigin = normalizeOrigin(origin);
  const subscription = await paypalRequest("/v1/billing/subscriptions", {
    method: "POST",
    headers: { "PayPal-Request-Id": `market-agent-${checkoutToken}` },
    body: {
      plan_id: env.PAYPAL_PLAN_ID,
      custom_id: checkoutToken,
      application_context: {
        brand_name: "Market Agent",
        locale: "en-US",
        shipping_preference: "NO_SHIPPING",
        user_action: "SUBSCRIBE_NOW",
        return_url: `${safeOrigin}/api/billing-return?token=${encodeURIComponent(checkoutToken)}`,
        cancel_url: `${safeOrigin}/connection-result?connection=billing-error&reason=${encodeURIComponent("Subscription checkout was cancelled. No payment was made.")}`,
      },
    },
  }, env);
  const approvalUrl = subscription.links?.find((link) => link.rel === "approve")?.href || "";
  if (!subscription.id || !approvalUrl) throw billingError("PayPal did not return a usable subscription checkout.", 502);
  await getPool(env).query(
    `UPDATE market_agent_subscriptions
        SET subscription_id = $2, approval_url = $3, status = 'approval_pending', updated_at = NOW()
      WHERE user_id = $1`,
    [userId, subscription.id, approvalUrl],
  );
  return { active: false, subscriptionId: subscription.id, approvalUrl };
}

export async function finishManagedSubscription(checkoutToken, subscriptionId, env = process.env) {
  await ensureBillingTables(env);
  requirePayPalConfiguration(env);
  const token = String(checkoutToken || "").trim();
  const id = String(subscriptionId || "").trim();
  if (!token || !id) throw billingError("The PayPal return was incomplete.", 400);
  const row = await getPool(env).query(
    `SELECT user_id, subscription_id, plan_id FROM market_agent_subscriptions WHERE checkout_token = $1 LIMIT 1`,
    [token],
  );
  const pending = row.rows[0];
  if (!pending || pending.subscription_id !== id) throw billingError("This subscription return could not be verified.", 400);
  const subscription = await paypalRequest(`/v1/billing/subscriptions/${encodeURIComponent(id)}`, { method: "GET" }, env);
  if (subscription.plan_id !== env.PAYPAL_PLAN_ID || subscription.custom_id !== token) throw billingError("The PayPal subscription does not match this account.", 400);
  const status = normalizePayPalStatus(subscription.status);
  await getPool(env).query(
    `UPDATE market_agent_subscriptions
        SET status = $2, payer_email = $3, approval_url = '', updated_at = NOW()
      WHERE user_id = $1`,
    [pending.user_id, status, String(subscription.subscriber?.email_address || "").toLowerCase()],
  );
  if (status !== "active") throw billingError("PayPal has not activated the subscription yet.", 409);
  return { userId: pending.user_id, active: true };
}

export async function cancelManagedSubscription(userId, env = process.env) {
  await ensureBillingTables(env);
  requirePayPalConfiguration(env);
  const result = await getPool(env).query(
    `SELECT subscription_id, status FROM market_agent_subscriptions WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row?.subscription_id || row.status !== "active") throw billingError("There is no active managed subscription to cancel.", 409);
  await paypalRequest(`/v1/billing/subscriptions/${encodeURIComponent(row.subscription_id)}/cancel`, {
    method: "POST",
    body: { reason: "Cancelled by the subscriber in Market Agent." },
    expectEmpty: true,
  }, env);
  await getPool(env).query(
    `UPDATE market_agent_subscriptions SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1`,
    [userId],
  );
  return getManagedSubscriptionStatus(userId, env);
}

export async function processPayPalWebhook(headers, event, env = process.env) {
  await ensureBillingTables(env);
  if (!env.PAYPAL_WEBHOOK_ID) throw billingError("PayPal webhook verification is not configured.", 503);
  const verification = await paypalRequest("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      transmission_id: headers["paypal-transmission-id"],
      transmission_time: headers["paypal-transmission-time"],
      cert_url: headers["paypal-cert-url"],
      auth_algo: headers["paypal-auth-algo"],
      transmission_sig: headers["paypal-transmission-sig"],
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: event,
    },
  }, env);
  if (verification.verification_status !== "SUCCESS") throw billingError("Invalid PayPal webhook signature.", 400);
  const eventId = String(event?.id || "");
  if (!eventId) throw billingError("PayPal webhook event ID is missing.", 400);
  const inserted = await getPool(env).query(
    `INSERT INTO market_agent_paypal_events (event_id, event_type, received_at)
     VALUES ($1, $2, NOW()) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
    [eventId, String(event?.event_type || "")],
  );
  if (!inserted.rows[0]) return { duplicate: true };

  const subscriptionId = String(String(event?.event_type || "").startsWith("PAYMENT.SALE.")
    ? event?.resource?.billing_agreement_id || ""
    : event?.resource?.id || event?.resource?.billing_agreement_id || "");
  if (!subscriptionId) return { ignored: true };
  const status = webhookStatus(event?.event_type, event?.resource?.status);
  if (status) {
    await getPool(env).query(
      `UPDATE market_agent_subscriptions
          SET status = $2,
              payer_email = COALESCE(NULLIF($3, ''), payer_email),
              updated_at = NOW()
        WHERE subscription_id = $1`,
      [subscriptionId, status, String(event?.resource?.subscriber?.email_address || "").toLowerCase()],
    );
  }
  return { processed: true };
}

export async function consumeAiUsage(userId, purpose, accessEnv, env = process.env) {
  const mode = String(accessEnv?.MARKET_AGENT_ACCESS_MODE || "expired");
  if (mode === "byok") return;
  const limits = usageLimits(mode, purpose);
  if (!limits) throw billingError("Connect your own APIs or activate the managed plan to continue.", 402);
  await ensureBillingTables(env);
  const client = await getPool(env).connect();
  try {
    await client.query("BEGIN");
    const counts = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::int AS daily,
         COUNT(*)::int AS total
       FROM market_agent_ai_usage_events
       WHERE user_id = $1 AND access_mode = $2 AND purpose = $3`,
      [userId, mode, purpose],
    );
    const daily = Number(counts.rows[0]?.daily || 0);
    const total = Number(counts.rows[0]?.total || 0);
    if (daily >= limits.daily || (limits.total && total >= limits.total)) {
      throw billingError(mode === "trial"
        ? "The demo limit for this feature has been reached. Connect your APIs or activate the managed plan to continue."
        : "The daily managed-plan limit for this feature has been reached. Try again tomorrow.", 429);
    }
    await client.query(
      `INSERT INTO market_agent_ai_usage_events (user_id, access_mode, purpose, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [userId, mode, purpose],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function connectorAllowedForAccess(accessEnv, provider) {
  const mode = String(accessEnv?.MARKET_AGENT_ACCESS_MODE || "expired");
  if (mode === "byok" || mode === "managed") return true;
  if (mode === "trial") return provider === "linkedin";
  return false;
}

function usageLimits(mode, purpose) {
  const trial = {
    chat: { daily: 15, total: 80 },
    agent: { daily: 3, total: 15 },
    panel: { daily: 1, total: 5 },
    workspace: { daily: 3, total: 10 },
    delivery: { daily: 3, total: 10 },
  };
  const managed = {
    chat: { daily: 60 },
    agent: { daily: 12 },
    panel: { daily: 2 },
    workspace: { daily: 10 },
    delivery: { daily: 12 },
    cron: { daily: 1 },
  };
  const setup = { chat: { daily: 12 } };
  if (mode === "trial") return trial[purpose] || null;
  if (mode === "managed") return managed[purpose] || null;
  if (mode === "starter" || mode === "expired") return setup[purpose] || null;
  return null;
}

async function ensureBillingTables(env) {
  if (billingTablesReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_subscriptions (
      user_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL DEFAULT 'paypal',
      subscription_id TEXT NOT NULL DEFAULT '',
      checkout_token TEXT NOT NULL DEFAULT '',
      approval_url TEXT NOT NULL DEFAULT '',
      plan_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'none',
      payer_email TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS market_agent_subscriptions_subscription_uidx
      ON market_agent_subscriptions (subscription_id) WHERE subscription_id <> '';
    CREATE UNIQUE INDEX IF NOT EXISTS market_agent_subscriptions_checkout_uidx
      ON market_agent_subscriptions (checkout_token) WHERE checkout_token <> '';
    CREATE TABLE IF NOT EXISTS market_agent_access_periods (
      user_id TEXT PRIMARY KEY,
      trial_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS market_agent_paypal_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL DEFAULT '',
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS market_agent_ai_usage_events (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      access_mode TEXT NOT NULL,
      purpose TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS market_agent_ai_usage_user_day_idx
      ON market_agent_ai_usage_events (user_id, access_mode, purpose, created_at DESC);
  `);
  billingTablesReady = true;
}

async function paypalRequest(path, options = {}, env = process.env) {
  const accessToken = await paypalAccessToken(env);
  const response = await fetch(`${paypalApiBase(env)}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (options.expectEmpty && response.ok) return {};
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw billingError(paypalMessage(data), response.status >= 400 && response.status < 500 ? 400 : 502);
  return data;
}

async function verifyManagedPlan(env) {
  const plan = await paypalRequest(`/v1/billing/plans/${encodeURIComponent(env.PAYPAL_PLAN_ID)}`, { method: "GET" }, env);
  const regular = Array.isArray(plan.billing_cycles) ? plan.billing_cycles.find((cycle) => cycle.tenure_type === "REGULAR") : null;
  const amount = regular?.pricing_scheme?.fixed_price;
  if (plan.status !== "ACTIVE" || amount?.value !== MANAGED_PRICE || amount?.currency_code !== MANAGED_CURRENCY || regular?.frequency?.interval_unit !== "MONTH" || Number(regular?.frequency?.interval_count || 0) !== 1) {
    throw billingError("The PayPal plan must be active and charge exactly $29.99 USD each month.", 503);
  }
}

async function paypalAccessToken(env) {
  requirePayPalConfiguration(env);
  const response = await fetch(`${paypalApiBase(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw billingError("PayPal could not authenticate the subscription service.", 502);
  return data.access_token;
}

function paypalApiBase(env) {
  return env.PAYPAL_ENVIRONMENT === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

function requirePayPalConfiguration(env) {
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET || !env.PAYPAL_PLAN_ID) {
    throw billingError("PayPal subscriptions are not configured yet.", 503);
  }
}

function normalizeOrigin(value) {
  const url = new URL(String(value || ""));
  if (!/^https?:$/.test(url.protocol)) throw billingError("The application address is invalid.", 400);
  return url.origin;
}

function normalizePayPalStatus(status) {
  const value = String(status || "").toUpperCase();
  return ({ ACTIVE: "active", APPROVAL_PENDING: "approval_pending", SUSPENDED: "suspended", CANCELLED: "cancelled", EXPIRED: "expired" })[value] || "pending";
}

function webhookStatus(type, resourceStatus) {
  const direct = {
    "BILLING.SUBSCRIPTION.ACTIVATED": "active",
    "BILLING.SUBSCRIPTION.CANCELLED": "cancelled",
    "BILLING.SUBSCRIPTION.SUSPENDED": "suspended",
    "BILLING.SUBSCRIPTION.EXPIRED": "expired",
    "BILLING.SUBSCRIPTION.PAYMENT.FAILED": "past_due",
    "PAYMENT.SALE.REFUNDED": "past_due",
    "PAYMENT.SALE.REVERSED": "past_due",
  };
  return direct[type] || (type === "BILLING.SUBSCRIPTION.UPDATED" ? normalizePayPalStatus(resourceStatus) : type === "PAYMENT.SALE.COMPLETED" ? "active" : "");
}

function paypalMessage(data) {
  const detail = data?.details?.[0]?.description || data?.message || "";
  return detail ? `PayPal could not complete the request: ${String(detail)}` : "PayPal could not complete the request.";
}

function billingError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
