import assert from "node:assert/strict";
import test from "node:test";
import { isPanelRun } from "../server/db.mjs";
import { isBrandSourceRefreshRequest, isPrivateAddress } from "../server/agent.mjs";
import { applyInvitationTracking, campaignPublicationTarget, createInvitationTrackingUrl, personalizeInvitationTemplate, renderInvitationEmailHtml, resolveInvitationDestination, retryDelayMinutes, validApprovedRecipient } from "../server/delivery.mjs";
import { canonicalAnalyticsPath, prepareAnalyticsLandingRows, prepareAnalyticsPageRows } from "../server/analytics.mjs";
import { scoreMarketingOutput } from "../server/evaluation.mjs";
import { handleSchedule } from "../server/schedule-handler.mjs";
import { projectLogoVariants, safeMailchimpSignupUrl, selectNewsletterLogoVariant, signupFormUrlFromResponses } from "../server/newsletters.mjs";
import { createBrandLogoAccessUrl } from "../server/brand-logos.mjs";
import { linkedinCommunityApprovalStatus, socialConnectorConfigured } from "../server/social-connections.mjs";
import { ownerCostEstimateCents, ownerMonthlyCostCapCents } from "../server/billing.mjs";

test("owner-paid analysis has a conservative global monthly cost ceiling", () => {
  assert.equal(ownerMonthlyCostCapCents({}), 5_000);
  assert.equal(ownerMonthlyCostCapCents({ OWNER_MONTHLY_COST_CAP_CENTS: "10000" }), 10_000);
  assert.equal(ownerMonthlyCostCapCents({ OWNER_MONTHLY_COST_CAP_CENTS: "not-a-number" }), 5_000);
  assert.equal(ownerCostEstimateCents("chat", {}), 25);
  assert.equal(ownerCostEstimateCents("panel", {}), 400);
  assert.equal(ownerCostEstimateCents("panel", { OWNER_PANEL_COST_ESTIMATE_CENTS: "250" }), 250);
});

test("LinkedIn company-page review stays separate from optional personal publishing", () => {
  const secure = "connection-key-with-at-least-32-characters";
  assert.equal(linkedinCommunityApprovalStatus({ LINKEDIN_COMMUNITY_ACCESS_STATUS: "pending" }), "pending");
  assert.equal(socialConnectorConfigured("linkedin-community", {
    CONNECTION_ENCRYPTION_KEY: secure,
    LINKEDIN_COMMUNITY_CLIENT_ID: "community-client",
    LINKEDIN_COMMUNITY_CLIENT_SECRET: "community-secret",
    LINKEDIN_COMMUNITY_ACCESS_STATUS: "pending",
  }), false);
  assert.equal(socialConnectorConfigured("linkedin-community", {
    CONNECTION_ENCRYPTION_KEY: secure,
    LINKEDIN_COMMUNITY_CLIENT_ID: "community-client",
    LINKEDIN_COMMUNITY_CLIENT_SECRET: "community-secret",
    LINKEDIN_COMMUNITY_ACCESS_STATUS: "approved",
  }), true);
  assert.equal(socialConnectorConfigured("linkedin", {
    CONNECTION_ENCRYPTION_KEY: secure,
    LINKEDIN_CLIENT_ID: "personal-client",
    LINKEDIN_CLIENT_SECRET: "personal-secret",
    LINKEDIN_COMMUNITY_ACCESS_STATUS: "pending",
  }), true);
});

test("balanced review runs count against the panel budget", () => {
  assert.equal(isPanelRun({ executionMode: "panel", model: "Standard analysis" }), true);
  assert.equal(isPanelRun({ model: "Three-way strategy review" }), true);
  assert.equal(isPanelRun({ model: "Collaborative review" }), true);
  assert.equal(isPanelRun({ executionMode: "single", model: "Standard analysis" }), false);
});

test("draft copy mentioning future updates from a site does not trigger a Brand refresh", () => {
  assert.equal(isBrandSourceRefreshRequest("If useful, subscribe for future updates from the site."), false);
  assert.equal(isBrandSourceRefreshRequest("Update the Brand from the live website."), true);
});

test("direct delivery accepts one reviewed recipient and rejects additions", () => {
  const run = { prompt: "Contact alex@example.com", output: "Approved queue for alex@example.com" };
  assert.equal(validApprovedRecipient("alex@example.com", run), "alex@example.com");
  assert.equal(validApprovedRecipient("alex@example.com, other@example.com", run), "");
  assert.equal(validApprovedRecipient("invented@example.com", run), "");
});

test("invitation templates personalize one recipient and keep the approved project destination", () => {
  assert.equal(
    personalizeInvitationTemplate("Hi {{first_name}},\n\nUpdates for {{company}}: {{invitation_url}}", { firstName: "Alex", company: "Venue One" }, "https://visit-lumen.com/"),
    "Hi Alex,\n\nUpdates for Venue One: https://visit-lumen.com/",
  );
  assert.equal(personalizeInvitationTemplate("Hi {{first_name}}", {}, ""), "Hi there");
  assert.equal(personalizeInvitationTemplate("Hi {{first_name}}\n\n{{invitation_button}}", { firstName: "Alex" }, "https://visit-lumen.com/"), "Hi Alex\n\nhttps://visit-lumen.com/");
});

test("invitation delivery renders the approved brand, message, action, and opt-out", () => {
  const html = renderInvitationEmailHtml({
    name: "LUMEN",
    brand: { primaryColor: "#8CC35E", neutralLightColor: "#FAF9F7", neutralDarkColor: "#1A1A1A", logoVariants: [{ usage: "email", url: "https://assets.example.com/lumen.png" }] },
    emailIdentity: { senderName: "Riccardo", businessDetails: "LUMEN · riccardo@example.com", addressPreference: "omit" },
    sourceMedia: [{ kind: "image", name: "Venue experience", role: "hero", recommendation: "reuse", url: "https://assets.example.com/hero.jpg" }],
  }, { invitationCtaLabel: "Try the demo" }, { subject: "An invitation to try LUMEN", body: "Hi Alex,\n\nSee the experience here:\n\nhttps://visit-lumen.com/\n\nTell us what you think.", invitationUrl: "https://visit-lumen.com/", unsubscribeUrl: "https://marketagent.shop/unsubscribe/test" });
  assert.match(html, /An invitation to try LUMEN/);
  assert.match(html, /https:\/\/assets\.example\.com\/lumen\.png/);
  assert.match(html, /https:\/\/assets\.example\.com\/hero\.jpg/);
  assert.match(html, /Try the demo/);
  assert.match(html, />https:\/\/visit-lumen\.com\/<\/a>/);
  assert.match(html, /Stop future invitations/);
  assert.ok(html.indexOf(">Try the demo</a>") < html.indexOf("Tell us what you think."));
});

test("invitation destination falls back to the Brand website and normalizes assistant domains", () => {
  assert.equal(resolveInvitationDestination("", "", "https://www.visit-lumen.com/"), "https://www.visit-lumen.com/");
  assert.equal(resolveInvitationDestination("visit-lumen.com"), "https://visit-lumen.com/");
  assert.equal(resolveInvitationDestination("not a link", "https://www.visit-lumen.com/"), "https://www.visit-lumen.com/");
});

test("invitation tracking replaces the approved destination without exposing recipient data", () => {
  const env = { APP_BASE_URL: "https://marketagent.shop", CONNECTION_ENCRYPTION_KEY: "test-signing-key-with-at-least-32-characters" };
  const tracked = createInvitationTrackingUrl("job-1", env);
  assert.match(tracked, /^https:\/\/marketagent\.shop\/api\/invitation-click\?token=/);
  assert.doesNotMatch(tracked, /recipient|alex|example\.com/i);
  const payload = applyInvitationTracking({ invitationUrl: "https://visit-lumen.com/", text: "Open https://visit-lumen.com/", html: '<a href="https://visit-lumen.com/">Open</a>' }, tracked);
  assert.match(payload.text, /marketagent\.shop\/api\/invitation-click/);
  assert.match(payload.html, /marketagent\.shop\/api\/invitation-click/);
  assert.doesNotMatch(payload.text, /visit-lumen\.com/);
});

test("analytics removes 404 probes and admin activity and merges query variants", () => {
  const pages = prepareAnalyticsPageRows([
    { pagePathPlusQueryString: "/about", pageTitle: "404: This page could not be found.", screenPageViews: 1, activeUsers: 1 },
    { pagePathPlusQueryString: "/admin/settings?tab=analytics", pageTitle: "LUMEN", screenPageViews: 1, activeUsers: 1 },
    { pagePathPlusQueryString: "/generate?from=one", pageTitle: "LUMEN", screenPageViews: 2, activeUsers: 1, userEngagementDuration: 20 },
    { pagePathPlusQueryString: "/generate?from=two", pageTitle: "LUMEN", screenPageViews: 3, activeUsers: 2, userEngagementDuration: 30 },
  ]);
  assert.equal(canonicalAnalyticsPath("/generate?from=one"), "/generate");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].pagePathPlusQueryString, "/generate");
  assert.equal(pages[0].screenPageViews, 5);
  const landing = prepareAnalyticsLandingRows([
    { landingPagePlusQueryString: "/contact", sessions: 1, engagedSessions: 0, averageSessionDuration: 0, keyEvents: 0 },
    { landingPagePlusQueryString: "/generate?from=one", sessions: 1, activeUsers: 1, engagedSessions: 1, averageSessionDuration: 20, keyEvents: 1 },
  ]);
  assert.deepEqual(landing.map((row) => row.landingPagePlusQueryString), ["/generate"]);
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
