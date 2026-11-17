import { getPool } from "./db.mjs";
import { replaceCampaignLinks } from "./email-content.mjs";

export async function updateCampaignLink(userId, projectId, runId, targetUrl, env = process.env) {
  if (!runId) return null;
  const result = await getPool(env).query(
    "SELECT data FROM market_agent_runs WHERE user_id = $1 AND project_id = $2 AND id = $3 LIMIT 1",
    [userId, projectId, runId],
  );
  const run = result.rows[0]?.data;
  if (!run) return null;

  const outputUpdate = replaceCampaignLinks(run.output, targetUrl);
  let itemReplacements = 0;
  const campaignPlan = run.campaignPlan?.items?.length ? {
    ...run.campaignPlan,
    items: run.campaignPlan.items.map((item) => {
      const textUpdate = replaceCampaignLinks(item?.text, targetUrl);
      itemReplacements += textUpdate.replaced;
      return { ...item, text: textUpdate.text };
    }),
  } : run.campaignPlan;
  const replaced = outputUpdate.replaced + itemReplacements;
  if (!replaced) return { run, targetUrl: normalizeTarget(targetUrl), replaced: 0 };
  const updated = { ...run, output: outputUpdate.text, campaignPlan };
  const database = getPool(env);
  const stateResult = await database.query(
    "UPDATE market_agent_runs SET data = $4::jsonb WHERE user_id = $1 AND project_id = $2 AND id = $3",
    [userId, projectId, runId, JSON.stringify(updated)],
  );
  await database.query(
    `UPDATE market_agent_states SET state = jsonb_set(
       state, '{runs}',
       COALESCE((SELECT jsonb_agg(CASE WHEN item->>'id' = $2 THEN $3::jsonb ELSE item END)
         FROM jsonb_array_elements(COALESCE(state->'runs','[]'::jsonb)) AS item), '[]'::jsonb), true),
       revision = revision + 1, updated_at = NOW()
     WHERE user_id = $1 RETURNING revision`,
    [userId, runId, JSON.stringify(updated)],
  );
  return { run: updated, targetUrl: normalizeTarget(targetUrl), replaced, revision: Number(stateResult.rows[0]?.revision || 0) };
}

function normalizeTarget(value) {
  const raw = String(value || "").trim();
  try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).toString(); }
  catch { return raw; }
}
