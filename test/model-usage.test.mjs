import test from "node:test";
import assert from "node:assert/strict";

import { shouldUseUtilityInterfacePlanner } from "../server/agent.mjs";
import {
  calculateModelCostMicrousd,
  modelUsageFromGoogle,
  modelUsageFromOpenAI,
  utilityModelConfiguration,
} from "../server/model-usage.mjs";

test("utility router selects the inexpensive model from the existing OpenAI connection", () => {
  const configuration = utilityModelConfiguration({ OPENAI_API_KEY: "connected" });
  assert.equal(configuration.provider, "openai");
  assert.equal(configuration.model, "gpt-6-luna");
  assert.equal(configuration.baseline.model, "gpt-6.1-terra");
});

test("utility router preserves configured model overrides", () => {
  const configuration = utilityModelConfiguration({
    OPENAI_API_KEY: "connected",
    OPENAI_UTILITY_MODEL: "utility-override",
    OPENAI_MODEL: "advanced-override",
  });
  assert.equal(configuration.model, "utility-override");
  assert.equal(configuration.baseline.model, "advanced-override");
});

test("reported token usage is normalized for both supported structured providers", () => {
  assert.deepEqual(modelUsageFromOpenAI({ usage: { input_tokens: 10_000, output_tokens: 500 } }), {
    inputTokens: 10_000,
    outputTokens: 500,
  });
  assert.deepEqual(modelUsageFromGoogle({ usageMetadata: { promptTokenCount: 2_000, candidatesTokenCount: 300 } }), {
    inputTokens: 2_000,
    outputTokens: 300,
  });
});

test("cost calculation keeps sub-cent precision in microdollars", () => {
  const utilityCost = calculateModelCostMicrousd(
    { inputTokens: 10_000, outputTokens: 500 },
    { inputUsdPerMillion: 0.10, outputUsdPerMillion: 0.50 },
  );
  const baselineCost = calculateModelCostMicrousd(
    { inputTokens: 10_000, outputTokens: 500 },
    { inputUsdPerMillion: 1, outputUsdPerMillion: 5 },
  );
  assert.equal(utilityCost, 1_250);
  assert.equal(baselineCost, 12_500);
});

test("only low-risk interface edits use the utility planner", () => {
  assert.equal(shouldUseUtilityInterfacePlanner("Rename this asset and add a status column"), true);
  assert.equal(shouldUseUtilityInterfacePlanner("Change the saved source preference"), true);
  assert.equal(shouldUseUtilityInterfacePlanner("Rewrite the newsletter subject and campaign caption"), false);
  assert.equal(shouldUseUtilityInterfacePlanner("Prepare a legal compliance claim"), false);
});
