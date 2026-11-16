import assert from "node:assert/strict";
import test from "node:test";
import { isPanelRun } from "../server/db.mjs";
import { isPrivateAddress } from "../server/agent.mjs";
import { retryDelayMinutes, validApprovedRecipient } from "../server/delivery.mjs";
import { scoreMarketingOutput } from "../server/evaluation.mjs";
import { handleSchedule } from "../server/schedule-handler.mjs";

test("balanced review runs count against the panel budget", () => {
  assert.equal(isPanelRun({ executionMode: "panel", model: "Standard analysis" }), true);
  assert.equal(isPanelRun({ model: "Three-way strategy review" }), true);
  assert.equal(isPanelRun({ model: "Collaborative review" }), true);
  assert.equal(isPanelRun({ executionMode: "single", model: "Standard analysis" }), false);
});

test("direct delivery accepts one reviewed recipient and rejects additions", () => {
  const run = { prompt: "Contact alex@example.com", output: "Approved queue for alex@example.com" };
  assert.equal(validApprovedRecipient("alex@example.com", run), "alex@example.com");
  assert.equal(validApprovedRecipient("alex@example.com, other@example.com", run), "");
  assert.equal(validApprovedRecipient("invented@example.com", run), "");
});

test("private, loopback, link-local, mapped and multicast addresses are blocked", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fc00::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

test("delivery retries back off and cap at six hours", () => {
  assert.equal(retryDelayMinutes(0), 2);
  assert.equal(retryDelayMinutes(3), 8);
  assert.equal(retryDelayMinutes(20), 360);
});

test("panel evaluation penalizes invented execution and rewards actionable measurement", () => {
  const strong = scoreMarketingOutput("PREPARED — NOT LAUNCHED\nLaunch-ready queue\nTracking and conversion measurement\nNext action", { required: ["prepared"], forbidden: ["guaranteed"] });
  const weak = scoreMarketingOutput("We published it. Guaranteed success.", { required: ["prepared"], forbidden: ["guaranteed"] });
  assert.ok(strong.score > weak.score);
});

test("private schedule handler rejects ordinary web requests and accepts Vercel schedule events", async () => {
  let invoked = false;
  const handler = handleSchedule(async () => { invoked = true; });
  const rejected = await handler(new Request("https://example.com"));
  assert.equal(rejected.status, 400);
  assert.equal(invoked, false);

  const headers = {
    "ce-specversion": "1.0",
    "ce-type": "com.vercel.schedule.v1beta",
    "ce-source": "vercel-schedules",
    "ce-id": "execution-1",
    "x-vercel-schedule-id": "schedule-1",
    "x-vercel-schedule-name": "market-agent-delivery",
    "x-vercel-schedule-namespace": "default",
    "x-vercel-schedule-scheduled-at": "2026-11-16T18:00:00.000Z",
    "x-vercel-schedule-source": "static",
    "x-vercel-schedule-expression": "*/15 * * * *",
  };
  const accepted = await handler(new Request("https://example.com", { method: "POST", headers }));
  assert.equal(accepted.status, 200);
  assert.equal(invoked, true);
});
