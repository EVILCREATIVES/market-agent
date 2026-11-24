import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { authoritativeRuns, isPanelRun, normalizeDatabaseError } from "../server/db.mjs";
import { formatLinkedInProfileResearch, isBrandSourceRefreshRequest, isPrivateAddress } from "../server/agent.mjs";
import { applyInvitationTracking, campaignPublicationTarget, campaignTrackingSummary, createInvitationTrackingUrl, explicitApprovedYouTubeFallback, personalizeInvitationTemplate, renderInvitationEmailHtml, resolveInvitationDestination, retryDelayMinutes, validApprovedRecipient } from "../server/delivery.mjs";
import { isContextualDraftEditRequest, shouldRewriteSavedInvitation } from "../api/chat.mjs";
import { canonicalAnalyticsPath, prepareAnalyticsLandingRows, prepareAnalyticsPageRows } from "../server/analytics.mjs";
import { scoreMarketingOutput } from "../server/evaluation.mjs";
import { handleSchedule } from "../server/schedule-handler.mjs";
import { projectLogoVariants, safeMailchimpSignupUrl, selectNewsletterLogoVariant, signupFormUrlFromResponses } from "../server/newsletters.mjs";
import { createBrandLogoAccessUrl } from "../server/brand-logos.mjs";
import { linkedinCommunityApprovalStatus, socialConnectorConfigured } from "../server/social-connections.mjs";
import { ownerCostEstimateCents, ownerMonthlyCostCapCents } from "../server/billing.mjs";
import { appendMarkdownTableColumn, editableCampaignRunId, extractMarkdownTableRows, setMarkdownTableColumnValues } from "../server/campaign-edits.mjs";
import { backgroundWakePlan, nextDailyRoutineAt } from "../server/background-queue.mjs";

test("background work sleeps until the exact scheduled event", () => {
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  const near = backgroundWakePlan({ type: "delivery", jobId: "job-1", scheduledAt: "2026-11-24T12:05:00.000Z" }, now);
  assert.equal(near.delaySeconds, 300);
  assert.equal(near.retentionSeconds, 600);
  assert.equal(near.payload.scheduledAt, "2026-11-24T12:05:00.000Z");

  const distant = backgroundWakePlan({ type: "delivery", jobId: "job-2", scheduledAt: "2026-12-24T12:00:00.000Z" }, now);
  assert.equal(distant.delaySeconds, 7 * 24 * 60 * 60);
  assert.equal(distant.retentionSeconds, 7 * 24 * 60 * 60);
  assert.equal(distant.payload.scheduledAt, "2026-12-24T12:00:00.000Z");
  assert.equal(backgroundWakePlan({ type: "delivery", jobId: "job-2", scheduledAt: "2026-12-24T12:00:00.000Z" }, now).idempotencyKey, distant.idempotencyKey);
});

test("the optional daily routine schedules only its next wake", () => {
  assert.equal(nextDailyRoutineAt({}, Date.parse("2026-11-24T08:00:00.000Z")), "2026-11-24T12:00:00.000Z");
  assert.equal(nextDailyRoutineAt({}, Date.parse("2026-11-24T13:00:00.000Z")), "2026-11-25T12:00:00.000Z");
  assert.equal(nextDailyRoutineAt({ lastRunAt: "2026-11-24T09:00:00.000Z" }, Date.parse("2026-11-24T10:00:00.000Z")), "2026-11-25T12:00:00.000Z");
});

test("production has no polling timers and uses one delayed queue consumer", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.crons, undefined);
  assert.deepEqual(config.functions["api/background-queue.mjs"].experimentalTriggers, [
    { type: "queue/v2beta", topic: "market-agent-background", retryAfterSeconds: 60 },
  ]);
});

test("owner-paid analysis has a conservative global monthly cost ceiling", () => {
  assert.equal(ownerMonthlyCostCapCents({}), 5_000);
  assert.equal(ownerMonthlyCostCapCents({ OWNER_MONTHLY_COST_CAP_CENTS: "10000" }), 10_000);
  assert.equal(ownerMonthlyCostCapCents({ OWNER_MONTHLY_COST_CAP_CENTS: "not-a-number" }), 5_000);
  assert.equal(ownerCostEstimateCents("chat", {}), 25);
  assert.equal(ownerCostEstimateCents("panel", {}), 400);
  assert.equal(ownerCostEstimateCents("panel", { OWNER_PANEL_COST_ESTIMATE_CENTS: "250" }), 250);
});

test("database quota failures identify an owner-side platform limit", () => {
  const original = Object.assign(new Error("Your account or project has exceeded the quota. Upgrade your plan to increase limits."), { code: "53000" });
  const normalized = normalizeDatabaseError(original);
  assert.equal(normalized.statusCode, 503);
  assert.equal(normalized.code, "DATABASE_CAPACITY_EXCEEDED");
  assert.match(normalized.message, /platform-owner issue/i);
  assert.match(normalized.message, /nothing was sent or published/i);
  assert.doesNotMatch(normalized.message, /upgrade your plan/i);
  const unrelated = new Error("Connection reset");
  assert.equal(normalizeDatabaseError(unrelated), unrelated);
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

test("normalized campaign rows prevent deleted campaigns from returning after reload", () => {
  const deleted = { id: "deleted-campaign", createdAt: "2026-11-18T12:00:00.000Z" };
  const current = { id: "current-campaign", createdAt: "2026-11-19T12:00:00.000Z" };
  assert.deepEqual(
    authoritativeRuns([deleted, current], [{ data: current }], true).map((run) => run.id),
    ["current-campaign"],
  );
  assert.deepEqual(
    authoritativeRuns([deleted], [], true),
    [],
  );
  assert.deepEqual(
    authoritativeRuns([deleted], [], false).map((run) => run.id),
    ["deleted-campaign"],
  );
});

test("campaign tracking becomes ready on approval and active when delivery starts", () => {
  const approvedRun = { id: "campaign-1", title: "Launch campaign", status: "Approved", campaignTracking: { status: "ready", campaignId: "campaign-1", campaignName: "Launch campaign", approvedAt: "2026-11-21T12:00:00.000Z", startedAt: null } };
  assert.deepEqual(campaignTrackingSummary(approvedRun, []), {
    status: "ready",
    campaignId: "campaign-1",
    campaignName: "Launch campaign",
    startedAt: null,
    totalItems: 0,
    scheduledItems: 0,
    processingItems: 0,
    publishedItems: 0,
    failedItems: 0,
    trackedItems: 0,
    clicks: 0,
  });
  const jobs = [
    { status: "scheduled", approvedAt: "2026-11-21T13:00:00.000Z", payload: { tracking: { url: "https://example.com/?utm_id=campaign-1" } }, clickCount: 3 },
    { status: "submitted", approvedAt: "2026-11-21T13:00:00.000Z", payload: { tracking: null }, clickCount: 0 },
    { status: "complete", approvedAt: "2026-11-21T13:00:00.000Z", payload: { campaignType: "prospect_followup" }, clickCount: 2 },
    { status: "failed", approvedAt: "2026-11-21T13:00:00.000Z", payload: {}, clickCount: 0 },
  ];
  const active = campaignTrackingSummary(approvedRun, jobs);
  assert.equal(active.status, "active");
  assert.equal(active.scheduledItems, 1);
  assert.equal(active.processingItems, 1);
  assert.equal(active.publishedItems, 1);
  assert.equal(active.failedItems, 1);
  assert.equal(active.trackedItems, 2);
  assert.equal(active.clicks, 5);
});

test("the assistant can add a real column to a saved campaign people table", () => {
  const markdown = `## Launch-ready queue\n\n| Brand | People to approach | Collaboration angle |\n| --- | --- | --- |\n| ASOS | Nick Goodchild | Fashion film |\n| Mango | Sara Donninelli | Collection world |`;
  const update = appendMarkdownTableColumn(markdown, "LinkedIn connection", "Unknown", "people");
  assert.equal(update.changed, true);
  assert.equal(update.rowCount, 2);
  assert.match(update.text, /\| Brand \| People to approach \| Collaboration angle \| LinkedIn connection \|/);
  assert.match(update.text, /\| ASOS \| Nick Goodchild \| Fashion film \| Unknown \|/);
  const repeated = appendMarkdownTableColumn(update.text, "LinkedIn connection", "Unknown", "people");
  assert.equal(repeated.changed, false);
  assert.equal(repeated.alreadyPresent, true);
});

test("people tables can be read and populated with row-specific verified links", () => {
  const markdown = `## Launch-ready queue\n\n| Brand | People to approach | Collaboration angle |\n| --- | --- | --- |\n| ASOS | **Nick Goodchild**, director; **Vanessa Spence**, leader | Fashion film |\n| Mango | **Sara Donnelli**, brand leader | Collection world |`;
  const table = extractMarkdownTableRows(markdown, "people");
  assert.equal(table.found, true);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].values.Brand, "ASOS");
  const update = setMarkdownTableColumnValues(markdown, "LinkedIn connection", [
    { rowIndex: 0, value: "[Nick Goodchild](https://www.linkedin.com/in/nick-goodchild/); Vanessa Spence — Not found" },
    { rowIndex: 1, value: "Sara Donnelli — Needs review" },
  ], "people");
  assert.equal(update.tableFound, true);
  assert.match(update.text, /\| LinkedIn connection \|/);
  assert.match(update.text, /\[Nick Goodchild\]\(https:\/\/www\.linkedin\.com\/in\/nick-goodchild\/\)/);
  assert.match(update.text, /Sara Donnelli — Needs review/);
  const refreshed = setMarkdownTableColumnValues(update.text, "LinkedIn connection", [
    { rowIndex: 0, value: "Nick Goodchild — Not found; Vanessa Spence — Not found" },
    { rowIndex: 1, value: "[Sara Donnelli](https://www.linkedin.com/in/sara-donnelli/)" },
  ], "people");
  assert.match(refreshed.text, /\[Sara Donnelli\]\(https:\/\/www\.linkedin\.com\/in\/sara-donnelli\/\)/);
  assert.doesNotMatch(refreshed.text, /Sara Donnelli — Needs review/);
});

test("LinkedIn research keeps only direct verified member-profile URLs", () => {
  const result = formatLinkedInProfileResearch([
    { rowIndex: 0, people: "**Jane Example**, creative director; **John Example**, producer" },
  ], {
    rows: [{ rowIndex: 0, matches: [
      { name: "Jane Example", status: "verified", url: "https://uk.linkedin.com/in/jane-example/?trk=search", verification: "Name and employer match" },
      { name: "John Example", status: "verified", url: "https://www.linkedin.com/company/example", verification: "Wrong URL kind" },
    ] }],
  });
  assert.equal(result.profilesVerified, 1);
  assert.equal(result.peopleNotFound, 1);
  assert.equal(result.rowValues[0].value, "[Jane Example](https://www.linkedin.com/in/jane-example/); John Example — Not found");
});

test("LinkedIn research preserves a professional mononym instead of dropping the person", () => {
  const result = formatLinkedInProfileResearch([
    { rowIndex: 0, people: "Demna, artistic director; Francesca Bellettini, leadership" },
  ], { rows: [{ rowIndex: 0, matches: [{ name: "Francesca Bellettini", status: "not_found", url: "", verification: "" }] }] });
  assert.equal(result.peopleNotFound, 2);
  assert.equal(result.rowValues[0].value, "Demna — Not found; Francesca Bellettini — Not found");
});

test("the assistant can edit the selected campaign from its visible detail screen", () => {
  assert.equal(editableCampaignRunId("run-1", { page: "campaigns", campaignSection: "overview", selectedRunId: "run-1" }), "run-1");
  assert.equal(editableCampaignRunId("run-1", { page: "agent", selectedRunId: "run-1" }), "run-1");
  assert.equal(editableCampaignRunId("run-1", { page: "agent", selectedRunId: "run-2" }), "");
  assert.equal(editableCampaignRunId("run-1", { page: "campaigns", campaignSection: "newsletter", selectedRunId: "run-1" }), "");
});

test("the assistant can edit a selected research or audience record", () => {
  assert.equal(editableCampaignRunId("research-1", { page: "research", selectedRunId: "research-1" }), "research-1");
  assert.equal(editableCampaignRunId("audience-1", { page: "agent", selectedRunId: "audience-1" }), "audience-1");
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

test("an exact approved private YouTube upload survives an empty model delivery plan", () => {
  const media = {
    id: "asset-1",
    sourceAssetId: "asset-1",
    kind: "video",
    name: "market-agent-oauth-verification-test.mp4",
    url: "https://marketagent.shop/api/project-asset?id=asset-1",
  };
  const item = explicitApprovedYouTubeFallback({
    prompt: "Prepare exactly one private YouTube test upload using the Content Library asset “market-agent-oauth-verification-test.mp4”. Title: “Market Agent OAuth Verification Test”. Description: “Private OAuth verification test for Market Agent. No customer data.” Use only this asset and YouTube.",
    output: "PREPARED — NOT UPLOADED.",
  }, { sourceMedia: [media] }, ["youtube"]);
  assert.equal(item?.channel, "youtube");
  assert.equal(item?.sourceAssetId, "asset-1");
  assert.equal(item?.subject, "Market Agent OAuth Verification Test");
  assert.equal(item?.text, "Private OAuth verification test for Market Agent. No customer data.");
  assert.equal(item?.privacyLevel, "private");
});

test("the YouTube fallback refuses ambiguous assets", () => {
  const prompt = "Prepare exactly one private YouTube upload. Title: “Test”. Description: “Private test.”";
  const workspace = { sourceMedia: [
    { id: "a", kind: "video", name: "one.mp4", url: "https://assets.example.com/one.mp4" },
    { id: "b", kind: "video", name: "two.mp4", url: "https://assets.example.com/two.mp4" },
  ] };
  assert.equal(explicitApprovedYouTubeFallback({ prompt, output: "" }, workspace, ["youtube"]), null);
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

test("invitation delivery keeps ordered secondary actions clickable", () => {
  const html = renderInvitationEmailHtml({
    name: "LUMEN",
    website: "https://www.visit-lumen.com/",
    brand: { primaryColor: "#8CC35E" },
  }, { invitationCtaLabel: "Subscribe" }, {
    subject: "Discover LUMEN",
    body: "Hi Alex,\n\n1. Subscribe for updates:\n\n{{invitation_button}}\n\n2. [Read the Copilot deck](https://www.visit-lumen.com/copilot-deck)\n\n3. [Try the demo](https://www.visit-lumen.com/)",
    invitationUrl: "https://www.visit-lumen.com/subscribe",
  });
  assert.match(html, />Subscribe<\/a>/);
  assert.match(html, /href="https:\/\/www\.visit-lumen\.com\/copilot-deck"[^>]*>Read the Copilot deck<\/a>/);
  assert.match(html, /href="https:\/\/www\.visit-lumen\.com\/"[^>]*>Try the demo<\/a>/);
  assert.ok(html.indexOf(">Subscribe</a>") < html.indexOf("Read the Copilot deck</a>"));
  assert.ok(html.indexOf("Read the Copilot deck</a>") < html.indexOf("Try the demo</a>"));
});

test("short follow-up corrections are treated as edits from every page", () => {
  assert.equal(isContextualDraftEditRequest("no, first step 1. subscribe, 2. read the deck, 3. access the demo"), true);
  assert.equal(isContextualDraftEditRequest("I want the document link before the demo"), true);
  assert.equal(isContextualDraftEditRequest("add the saved logo here"), true);
  assert.equal(isContextualDraftEditRequest("How many invitations were sent?"), false);
});

test("an Agent proposal takes priority over remembered invitation context", () => {
  const rememberedInvitation = {
    hasInvitation: true,
    message: "no, make the first step the document",
    contextualDraftEdit: true,
    editableRunId: "run-1",
    uiContext: { page: "agent", selectedRunId: "run-1", campaignSection: "newsletter", campaignEmailMode: "invitation" },
    recentConversationText: "We were editing the invitation recipient preview.",
  };
  assert.equal(shouldRewriteSavedInvitation(rememberedInvitation), false);
  assert.equal(shouldRewriteSavedInvitation({ ...rememberedInvitation, message: "Change the saved Campaigns invitation subject" }), true);
  assert.equal(shouldRewriteSavedInvitation({
    ...rememberedInvitation,
    editableRunId: "",
    uiContext: { page: "campaigns", campaignSection: "newsletter", campaignEmailMode: "invitation" },
  }), true);
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
