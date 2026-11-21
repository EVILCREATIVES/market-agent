import test from "node:test";
import assert from "node:assert/strict";
import { approvedProspectFollowupTemplate } from "../server/delivery.mjs";

test("extracts the exact approved invitation follow-up without later sections", () => {
  const run = {
    prompt: "Improve the strategy for the 230 original invitations.",
    output: `## Exact messages and assets

### Follow-up email

**Subject:** Discover LUMEN for your venue
**Preview:** Subscribe, read and try the demo.

Hi,

1. [Subscribe for more information](https://www.marketagent.shop/join/example) and receive updates.
2. [Read the deck](https://www.visit-lumen.com/copilot-deck).
3. [Try the demo](https://www.visit-lumen.com/).

Best,
Riccardo

### Proposed website signup copy

This must not enter the email.`,
  };
  const result = approvedProspectFollowupTemplate(run);
  assert.equal(result?.subject, "Discover LUMEN for your venue");
  assert.equal(result?.primaryUrl, "https://www.marketagent.shop/join/example");
  assert.match(result?.text || "", /Subscribe for more information: https:\/\/www\.marketagent\.shop\/join\/example/);
  assert.doesNotMatch(result?.text || "", /Proposed website signup copy/);
});

test("does not reuse prior recipients for an unrelated approved email", () => {
  assert.equal(approvedProspectFollowupTemplate({ prompt: "Write an email", output: "### Email\nHello" }), null);
});
