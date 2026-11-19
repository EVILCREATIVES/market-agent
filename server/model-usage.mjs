import { getPool } from "./db.mjs";

const MEASUREMENT_KEY = "utility-router-v1";
const MEASUREMENT_DAYS = 30;
let usageTablesReady = false;

export function modelUsageFromOpenAI(response) {
  return normalizeTokenUsage({
    inputTokens: response?.usage?.input_tokens,
    outputTokens: response?.usage?.output_tokens,
  });
}

export function modelUsageFromGoogle(response) {
  return normalizeTokenUsage({
    inputTokens: response?.usageMetadata?.promptTokenCount,
    outputTokens: response?.usageMetadata?.candidatesTokenCount,
  });
}

export function calculateModelCostMicrousd(usage, pricing = {}) {
  const inputTokens = nonNegativeInteger(usage?.inputTokens);
  const outputTokens = nonNegativeInteger(usage?.outputTokens);
  const inputUsdPerMillion = finiteNonNegative(pricing?.inputUsdPerMillion);
  const outputUsdPerMillion = finiteNonNegative(pricing?.outputUsdPerMillion);
  if (inputUsdPerMillion === null || outputUsdPerMillion === null) return null;
  return Math.round(inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion);
}

export function utilityModelConfiguration(env = process.env) {
  if (env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      model: env.OPENAI_UTILITY_MODEL || "gpt-6-luna",
      pricing: {
        inputUsdPerMillion: env.OPENAI_UTILITY_INPUT_USD_PER_MILLION || "0.10",
        outputUsdPerMillion: env.OPENAI_UTILITY_OUTPUT_USD_PER_MILLION || "0.50",
      },
      baseline: {
        model: env.OPENAI_MODEL || env.AI_MODEL || "gpt-6.1-terra",
        pricing: {
          inputUsdPerMillion: env.OPENAI_BASELINE_INPUT_USD_PER_MILLION || "1.00",
          outputUsdPerMillion: env.OPENAI_BASELINE_OUTPUT_USD_PER_MILLION || "5.00",
        },
      },
    };
  }
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    return {
      provider: "google",
      model: env.GOOGLE_UTILITY_MODEL || env.GOOGLE_MODEL || "gemini-3.8-flash",
      pricing: configuredPricing(env.GOOGLE_UTILITY_INPUT_USD_PER_MILLION, env.GOOGLE_UTILITY_OUTPUT_USD_PER_MILLION),
      baseline: {
        model: env.GOOGLE_MODEL || "gemini-3.8-flash",
        pricing: configuredPricing(env.GOOGLE_BASELINE_INPUT_USD_PER_MILLION, env.GOOGLE_BASELINE_OUTPUT_USD_PER_MILLION),
      },
    };
  }
  return null;
}

export async function recordModelUsage(event, env = process.env) {
  if (!env.DATABASE_URL) return;
  await ensureModelUsageTables(env);
  const usage = normalizeTokenUsage(event?.usage);
  const actualCostMicrousd = calculateModelCostMicrousd(usage, event?.pricing);
  const baselineCostMicrousd = calculateModelCostMicrousd(usage, event?.baselinePricing);
  const savingsMicrousd = actualCostMicrousd === null || baselineCostMicrousd === null
    ? null
    : baselineCostMicrousd - actualCostMicrousd;
  await getPool(env).query(
    `INSERT INTO market_agent_model_usage_events
      (measurement_key, user_id, project_id, access_mode, task, provider, model, tier,
       input_tokens, output_tokens, actual_cost_microusd, baseline_cost_microusd,
       savings_microusd, fallback, succeeded, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())`,
    [
      MEASUREMENT_KEY,
      String(event?.userId || "unknown"),
      String(event?.projectId || "project-default"),
      String(event?.accessMode || "unknown"),
      String(event?.task || "utility"),
      String(event?.provider || "unknown"),
      String(event?.model || "unknown"),
      String(event?.tier || "utility"),
      usage.inputTokens,
      usage.outputTokens,
      actualCostMicrousd,
      baselineCostMicrousd,
      savingsMicrousd,
      Boolean(event?.fallback),
      event?.succeeded !== false,
    ],
  );
}

export async function getModelUsageMeasurement(userId, env = process.env) {
  await ensureModelUsageTables(env);
  const result = await getPool(env).query(
    `SELECT
       measurement.started_at,
       measurement.ends_at,
       COUNT(events.id)::int AS calls,
       COUNT(events.id) FILTER (WHERE events.tier = 'utility')::int AS utility_calls,
       COUNT(events.id) FILTER (WHERE events.tier = 'utility' AND NOT events.succeeded)::int AS failed_utility_calls,
       COUNT(events.id) FILTER (WHERE events.fallback)::int AS fallback_calls,
       COUNT(events.id) FILTER (WHERE events.actual_cost_microusd IS NOT NULL)::int AS measured_cost_calls,
       COALESCE(SUM(events.input_tokens), 0)::bigint AS input_tokens,
       COALESCE(SUM(events.output_tokens), 0)::bigint AS output_tokens,
       COALESCE(SUM(events.actual_cost_microusd), 0)::bigint AS actual_cost_microusd,
       COALESCE(SUM(events.baseline_cost_microusd), 0)::bigint AS baseline_cost_microusd,
       COALESCE(SUM(events.savings_microusd), 0)::bigint AS savings_microusd
     FROM market_agent_model_usage_measurements measurement
     LEFT JOIN market_agent_model_usage_events events
       ON events.measurement_key = measurement.measurement_key
      AND events.user_id = $2
      AND events.created_at >= measurement.started_at
      AND events.created_at < measurement.ends_at
     WHERE measurement.measurement_key = $1
     GROUP BY measurement.started_at, measurement.ends_at`,
    [MEASUREMENT_KEY, userId],
  );
  const row = result.rows[0];
  if (!row) return emptyMeasurement();
  const now = Date.now();
  const startsAt = new Date(row.started_at).toISOString();
  const endsAt = new Date(row.ends_at).toISOString();
  return {
    status: now < new Date(startsAt).getTime() ? "scheduled" : now < new Date(endsAt).getTime() ? "active" : "complete",
    startsAt,
    endsAt,
    calls: Number(row.calls || 0),
    utilityCalls: Number(row.utility_calls || 0),
    failedUtilityCalls: Number(row.failed_utility_calls || 0),
    fallbackCalls: Number(row.fallback_calls || 0),
    measuredCostCalls: Number(row.measured_cost_calls || 0),
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    estimatedCostUsd: microusdToUsd(row.actual_cost_microusd),
    baselineCostUsd: microusdToUsd(row.baseline_cost_microusd),
    estimatedSavingsUsd: microusdToUsd(row.savings_microusd),
  };
}

function normalizeTokenUsage(usage) {
  return {
    inputTokens: nonNegativeInteger(usage?.inputTokens),
    outputTokens: nonNegativeInteger(usage?.outputTokens),
  };
}

function nonNegativeInteger(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

function finiteNonNegative(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function configuredPricing(input, output) {
  if (input === undefined || output === undefined || input === "" || output === "") return null;
  return { inputUsdPerMillion: input, outputUsdPerMillion: output };
}

function microusdToUsd(value) {
  return Number((Number(value || 0) / 1_000_000).toFixed(6));
}

function emptyMeasurement() {
  return {
    status: "unavailable",
    startsAt: "",
    endsAt: "",
    calls: 0,
    utilityCalls: 0,
    failedUtilityCalls: 0,
    fallbackCalls: 0,
    measuredCostCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    baselineCostUsd: 0,
    estimatedSavingsUsd: 0,
  };
}

async function ensureModelUsageTables(env) {
  if (usageTablesReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_model_usage_measurements (
      measurement_key TEXT PRIMARY KEY,
      started_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO market_agent_model_usage_measurements (measurement_key, started_at, ends_at)
    VALUES ('${MEASUREMENT_KEY}', NOW(), NOW() + INTERVAL '${MEASUREMENT_DAYS} days')
    ON CONFLICT (measurement_key) DO NOTHING;
    CREATE TABLE IF NOT EXISTS market_agent_model_usage_events (
      id BIGSERIAL PRIMARY KEY,
      measurement_key TEXT NOT NULL REFERENCES market_agent_model_usage_measurements(measurement_key),
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      access_mode TEXT NOT NULL,
      task TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      tier TEXT NOT NULL,
      input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
      output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
      actual_cost_microusd BIGINT CHECK (actual_cost_microusd >= 0),
      baseline_cost_microusd BIGINT CHECK (baseline_cost_microusd >= 0),
      savings_microusd BIGINT,
      fallback BOOLEAN NOT NULL DEFAULT FALSE,
      succeeded BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS market_agent_model_usage_user_window_idx
      ON market_agent_model_usage_events (user_id, measurement_key, created_at DESC);
  `);
  usageTablesReady = true;
}
