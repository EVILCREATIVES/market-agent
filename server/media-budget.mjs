import { getPool } from "./db.mjs";

const DEFAULT_MONTHLY_CAP_CENTS = 2500;
const MAX_MONTHLY_CAP_CENTS = 1_000_000;
let budgetTableReady = false;

export async function getUserMediaBudgetCents(userId, env = process.env, client = null, lock = false) {
  await ensureBudgetTable(env);
  const db = client || getPool(env);
  await db.query(
    `INSERT INTO market_agent_user_settings (user_id, media_monthly_budget_cents, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW()) ON CONFLICT (user_id) DO NOTHING`,
    [userId, defaultMonthlyCapCents(env)],
  );
  const result = await db.query(
    `SELECT media_monthly_budget_cents FROM market_agent_user_settings WHERE user_id = $1${lock ? " FOR UPDATE" : ""}`,
    [userId],
  );
  return Number(result.rows[0]?.media_monthly_budget_cents ?? defaultMonthlyCapCents(env));
}

export async function updateUserMediaBudget(userId, monthlyCapCents, env = process.env) {
  const value = Number(monthlyCapCents);
  if (!Number.isInteger(value) || value < 0 || value > maxMonthlyCapCents(env)) {
    throw budgetError(`Choose a monthly limit between $0 and $${(maxMonthlyCapCents(env) / 100).toLocaleString()}.`, 400);
  }
  await ensureBudgetTable(env);
  await getPool(env).query(
    `INSERT INTO market_agent_user_settings (user_id, media_monthly_budget_cents, created_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET media_monthly_budget_cents = EXCLUDED.media_monthly_budget_cents, updated_at = NOW()`,
    [userId, value],
  );
  return value;
}

export async function getMediaBudgetSummary(userId, env = process.env) {
  const [monthlyCapCents, result] = await Promise.all([
    getUserMediaBudgetCents(userId, env),
    getPool(env).query(
      `SELECT
         (
           SELECT COALESCE(SUM(approved_budget_cents), 0)
           FROM market_agent_media_jobs
           WHERE user_id = $1 AND approved_at >= date_trunc('month', NOW()) AND status <> 'cancelled'
         ) + (
           SELECT COALESCE(SUM(approved_budget_cents), 0)
           FROM market_agent_asset_proposals
           WHERE user_id = $1 AND approved_at >= date_trunc('month', NOW()) AND status <> 'cancelled'
         ) AS approved_cents,
         (
           SELECT COALESCE(SUM(actual_cost_cents), 0)
           FROM market_agent_media_jobs
           WHERE user_id = $1 AND approved_at >= date_trunc('month', NOW()) AND status = 'complete'
         ) + (
           SELECT COALESCE(SUM(actual_cost_cents), 0)
           FROM market_agent_asset_proposals
           WHERE user_id = $1 AND approved_at >= date_trunc('month', NOW()) AND status = 'complete'
         ) AS actual_cents`,
      [userId],
    ),
  ]);
  return {
    monthlyCapCents,
    approvedThisMonthCents: Number(result.rows[0]?.approved_cents || 0),
    actualThisMonthCents: Number(result.rows[0]?.actual_cents || 0),
    billingOwner: "user",
  };
}

async function ensureBudgetTable(env) {
  if (budgetTableReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_user_settings (
      user_id TEXT PRIMARY KEY,
      media_monthly_budget_cents INTEGER NOT NULL DEFAULT 2500 CHECK (media_monthly_budget_cents >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  budgetTableReady = true;
}

function defaultMonthlyCapCents(env) {
  const value = Number(env.MEDIA_MONTHLY_BUDGET_CENTS || DEFAULT_MONTHLY_CAP_CENTS);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, maxMonthlyCapCents(env)) : DEFAULT_MONTHLY_CAP_CENTS;
}

function maxMonthlyCapCents(env) {
  const value = Number(env.MEDIA_MAX_MONTHLY_BUDGET_CENTS || MAX_MONTHLY_CAP_CENTS);
  return Number.isInteger(value) && value > 0 ? value : MAX_MONTHLY_CAP_CENTS;
}

function budgetError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
