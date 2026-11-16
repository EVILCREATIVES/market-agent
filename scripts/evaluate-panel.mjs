import { readFile } from "node:fs/promises";
import { runMarketingAgent } from "../server/agent.mjs";
import { scoreMarketingOutput } from "../server/evaluation.mjs";

if (!process.env.OPENAI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error("Connect at least one evaluation API before running the panel evaluation.");
const fixtures = JSON.parse(await readFile(new URL("../test/fixtures/panel-eval.json", import.meta.url), "utf8"));
const results = [];
for (const fixture of fixtures) {
  const base = { action: fixture.action, prompt: fixture.prompt, workspace: fixture.workspace, connections: {}, useWeb: false };
  const single = await runMarketingAgent({ ...base, mode: "single" }, process.env);
  const panel = await runMarketingAgent({ ...base, mode: "panel" }, process.env);
  results.push({ name: fixture.name, single: scoreMarketingOutput(single.output, fixture), panel: scoreMarketingOutput(panel.output, fixture) });
}
const summary = { fixtures: results.length, panelWins: results.filter((item) => item.panel.score > item.single.score).length, ties: results.filter((item) => item.panel.score === item.single.score).length, results };
console.log(JSON.stringify(summary, null, 2));
if (summary.panelWins === 0) process.exitCode = 1;
