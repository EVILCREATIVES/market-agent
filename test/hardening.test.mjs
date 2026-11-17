import assert from "node:assert/strict";
import test from "node:test";
import { isPanelRun } from "../server/db.mjs";
import { isPrivateAddress } from "../server/agent.mjs";
import { campaignPublicationTarget, personalizeInvitationTemplate, retryDelayMinutes, validApprovedRecipient } from "../server/delivery.mjs";
import { scoreMarketingOutput } from "../server/evaluation.mjs";
import { handleSchedule } from "../server/schedule-handler.mjs";
import { projectLogoVariants, safeMailchimpSignupUrl, selectNewsletterLogoVariant, signupFormUrlFromResponses } from "../server/newsletters.mjs";
import { createBrandLogoAccessUrl } from "../server/brand-logos.mjs";

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

test("invitation templates personalize one recipient and keep the approved signup destination", () => {
  assert.equal(
    personalizeInvitationTemplate("Hi {{first_name}},\n\nUpdates for {{company}}: {{signup_url}}", { firstName: "Alex", company: "Venue One" }, "https://marketagent.shop/join/example"),
    "Hi Alex,\n\nUpdates for Venue One: https://marketagent.shop/join/example",
  );
  assert.equal(personalizeInvitationTemplate("Hi {{first_name}}", {}, ""), "Hi there");
});

test("campaign coverage recognizes the full promised publication cadence", () => {
  const output = `A four-week Instagram campaign with three posts per week.\n\n${Array.from({ length: 12 }, (_, index) => `### ${index + 1} · Day ${index * 2 + 1} · Post`).join("\n")}`;
  assert.equal(campaignPublicationTarget({ prompt: "Instagram campaign", output }), 12);
});

test("campaign coverage recognizes creative-first Instagram day headings", () => {
  const output = [
    "### Day 1 — Carousel: Meaning first",
    "### Day 3 — Reel: One idea, many forms",
    "### Day 6 — Carousel: Working method",
  ].join("\n\n");
  assert.equal(campaignPublicationTarget({ prompt: "Instagram campaign", output }), 3);
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

test("newsletter logos prefer explicit names, the newest request, then email and primary roles", () => {
  const variants = [
    { id: "primary", name: "LUMEN Primary", url: "https://assets.example.com/primary.png", usage: "primary", createdAt: "2026-11-01T00:00:00.000Z" },
    { id: "email", name: "LUMEN Email Black", url: "https://assets.example.com/email.png", usage: "email", createdAt: "2026-11-02T00:00:00.000Z" },
    { id: "new", name: "Logo LUMEN Black", url: "https://assets.example.com/new.png", usage: "other", createdAt: "2026-11-17T00:00:00.000Z" },
  ];
  assert.equal(selectNewsletterLogoVariant(variants, "replace the email logo with LUMEN Email Black").id, "email");
  assert.equal(selectNewsletterLogoVariant(variants, "replace the logo in the email with the new one", "email").id, "new");
  assert.equal(selectNewsletterLogoVariant(variants, "use the saved logo in the newsletter").id, "email");
});

test("legacy project logos remain available as a primary email-safe variant", () => {
  assert.deepEqual(projectLogoVariants({ brand: { logoDataUrl: "https://assets.example.com/legacy.png", logoName: "Legacy mark" } }), [
    { id: "legacy-primary-logo", name: "Legacy mark", url: "https://assets.example.com/legacy.png", usage: "primary", createdAt: "" },
  ]);
});

test("public opt-in redirects only to trusted Mailchimp signup hosts", () => {
  assert.equal(safeMailchimpSignupUrl("https://eepurl.com/example"), "https://eepurl.com/example");
  assert.equal(safeMailchimpSignupUrl("https://example.us10.list-manage.com/subscribe?u=abc"), "https://example.us10.list-manage.com/subscribe?u=abc");
  assert.equal(safeMailchimpSignupUrl("http://eepurl.com/example"), "https://eepurl.com/example");
  assert.equal(safeMailchimpSignupUrl("https://eepurl.com.evil.example/subscribe"), "");
  assert.equal(safeMailchimpSignupUrl("javascript:alert(1)"), "");
});

test("signup form lookup falls back to Mailchimp's dedicated forms response", () => {
  assert.equal(signupFormUrlFromResponses({}, { signup_forms: [{ signup_form_url: "http://example.us1.list-manage.com/subscribe?u=owner&id=list" }] }), "https://example.us1.list-manage.com/subscribe?u=owner&id=list");
  assert.equal(signupFormUrlFromResponses({}, { signup_forms: [{ signup_form_url: "https://attacker.example/subscribe" }] }), "");
});

test("email logo access links expose only signed brand-logo paths", () => {
  const env = { CONNECTION_ENCRYPTION_KEY: "test-signing-key-with-at-least-24-characters" };
  const url = createBrandLogoAccessUrl({ userId: "user-1", projectId: "project-1", pathname: "market-agent-assets/user-1/project-1/brand-logos/logo.png", origin: "https://marketagent.shop" }, env);
  assert.match(url, /^https:\/\/marketagent\.shop\/api\/brand-logo\?token=/);
  assert.throws(() => createBrandLogoAccessUrl({ userId: "user-1", projectId: "project-1", pathname: "market-agent-assets/user-1/project-1/private-document.pdf", origin: "https://marketagent.shop" }, env), /invalid/);
});
