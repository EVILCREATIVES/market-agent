import { getAnalyticsConnectionStatus, getAnalyticsReport } from "./analytics.mjs";
import { getChannelAnalytics } from "./channel-analytics.mjs";
import { getPool, loadStateForUser } from "./db.mjs";
import { getSocialConnectionStatus } from "./social-connections.mjs";

const SOCIAL_PROVIDERS = ["linkedin", "instagram", "tiktok", "youtube", "x", "discord", "reddit"];

export async function getGrowthReport(userId, projectId, range = "28daysAgo", env = process.env) {
  const normalizedRange = /^(7|14|28|30|60|90)daysAgo$/.test(String(range)) ? String(range) : "28daysAgo";
  const days = Number(normalizedRange.match(/^\d+/)?.[0] || 28);
  const [{ state }, analyticsStatus, socialStatus] = await Promise.all([
    loadStateForUser(userId, env),
    getAnalyticsConnectionStatus(userId, projectId, env),
    getSocialConnectionStatus(userId, projectId, env),
  ]);
  const workspace = state.projects.find((item) => item.id === projectId) || state.projects[0] || {};
  const goal = inferGrowthPlan(workspace);
  const connectedProviders = SOCIAL_PROVIDERS.filter((provider) => socialStatus[provider]?.connected);
  const [analyticsOutcome, ...socialOutcomes] = await Promise.allSettled([
    analyticsStatus.canRead ? getAnalyticsReport(userId, projectId, normalizedRange, env) : Promise.resolve(null),
    ...connectedProviders.map((provider) => getChannelAnalytics(userId, projectId, provider, normalizedRange, env)),
  ]);
  const analytics = analyticsOutcome.status === "fulfilled" ? analyticsOutcome.value : null;
  const socialReports = socialOutcomes.flatMap((outcome) => outcome.status === "fulfilled" && outcome.value ? [outcome.value] : []);
  const keyEvents = (analytics?.keyEvents || []).map((row) => ({ eventName: String(row.eventName || ""), count: number(row.keyEvents) })).filter((item) => item.eventName && item.count > 0);
  const selectedEvent = resolveAnalyticsEvent(goal, keyEvents);
  const resolvedGoal = { ...goal, analyticsEvent: goal.analyticsEvent || selectedEvent };

  const campaignRows = analytics?.campaigns || [];
  const previousCampaignRows = analytics?.previousCampaigns || [];
  const attributedVisits = sum(campaignRows, "sessions");
  const previousAttributedVisits = sum(previousCampaignRows, "sessions");
  const attributedLeads = selectedEvent ? sumMatchingEvents(analytics?.campaignEvents || [], selectedEvent) : null;
  const previousAttributedLeads = selectedEvent ? sumMatchingEvents(analytics?.previousCampaignEvents || [], selectedEvent) : null;
  const visibility = socialReports.map(channelVisibility).filter((value) => value != null).reduce((total, value) => total + value, 0);
  const hasVisibility = socialReports.some((report) => channelVisibility(report) != null);
  const audienceComparable = socialReports.map(channelAudience).filter((item) => item.current != null && item.previous != null);
  const audienceCurrent = audienceComparable.length ? audienceComparable.reduce((total, item) => total + item.current, 0) : socialReports.map(channelAudience).filter((item) => item.current != null).reduce((total, item) => total + item.current, 0);
  const audiencePrevious = audienceComparable.length ? audienceComparable.reduce((total, item) => total + item.previous, 0) : null;

  const metrics = [
    growthMetric("visibility", "Reported visibility", hasVisibility ? visibility : null, null, "views / reach", "Connected channel APIs", hasVisibility ? "Available reach, impressions, or views reported by each channel. These are exposures, not unique people across platforms." : "No connected channel returned a visibility measure yet."),
    growthMetric("audience", audiencePrevious == null ? "Connected audience" : "Audience growth", audienceCurrent || null, audiencePrevious, "followers / subscribers", "Daily account snapshots", audiencePrevious == null ? "Tracking has started; growth appears after a second-day snapshot." : "Compared only across channels that have a stored historical baseline."),
    growthMetric("visits", "Attributed website visits", analytics ? attributedVisits : null, analytics ? previousAttributedVisits : null, "sessions", "Google Analytics campaign attribution", analytics ? "Visits carrying a Market Agent campaign identifier." : "Connect Google Analytics to measure visits from campaign links."),
    growthMetric("leads", conversionLabel(resolvedGoal.primaryConversion), attributedLeads, previousAttributedLeads, "qualified actions", selectedEvent ? `Google Analytics · ${selectedEvent}` : "Conversion event not detected", selectedEvent ? "Key events attributed to Market Agent campaign links." : `The assistant selected ${conversionName(resolvedGoal.primaryConversion)}, but a matching Analytics key event has not been detected.`),
  ];

  const channels = socialReports.map((report) => {
    const audience = channelAudience(report);
    return {
      provider: report.provider,
      label: report.label,
      visibility: channelVisibility(report),
      audienceCurrent: audience.current,
      audienceChange: audience.current != null && audience.previous != null ? audience.current - audience.previous : null,
      visits: campaignValueForSource(campaignRows, report.provider, "sessions"),
      leads: selectedEvent ? campaignEventValueForSource(analytics?.campaignEvents || [], report.provider, selectedEvent) : null,
      availability: report.availability,
    };
  });
  const campaigns = campaignRows.map((row) => ({
    id: String(row.sessionManualCampaignId || ""),
    name: String(row.sessionManualCampaignName || "Unnamed tracked campaign"),
    source: String(row.sessionManualSource || ""),
    medium: String(row.sessionManualMedium || ""),
    sessions: number(row.sessions),
    leads: selectedEvent ? campaignEventValue(analytics?.campaignEvents || [], row, selectedEvent) : null,
  }));
  const recommendations = buildRecommendations({ analytics, socialReports, metrics, goal: resolvedGoal, selectedEvent, campaigns });
  const interactions = socialReports.reduce((total, report) => total + ["likes", "reactions", "comments", "shares", "saves"].reduce((sumValue, key) => sumValue + number(report.totals?.[key]), 0), 0);

  return {
    range: normalizedRange,
    days,
    goal: resolvedGoal,
    metrics,
    funnel: [
      { key: "visibility", label: "Reported exposures", value: hasVisibility ? visibility : null, source: "Channel APIs" },
      { key: "interactions", label: "Interactions", value: socialReports.length ? interactions : null, source: "Channel APIs" },
      { key: "visits", label: "Attributed visits", value: analytics ? attributedVisits : null, source: "Google Analytics" },
      { key: "leads", label: conversionLabel(resolvedGoal.primaryConversion), value: attributedLeads, source: selectedEvent ? `Google Analytics · ${selectedEvent}` : "Not configured" },
    ],
    channels,
    campaigns,
    keyEvents,
    recommendations,
    tracking: {
      startedAt: socialReports.map((report) => report.comparison?.baselineAt).filter(Boolean).sort()[0] || new Date().toISOString(),
      attributed: Boolean(analytics && campaignRows.length),
      note: analytics
        ? campaignRows.length ? "Market Agent campaign identifiers are visible in Google Analytics." : "Tracked links are now added to eligible campaign destinations; attribution will appear after those links receive visits."
        : "Google Analytics is not connected, so website visits and qualified actions cannot be attributed yet.",
    },
    fetchedAt: new Date().toISOString(),
  };
}

export async function getAgentPerformanceContext(userId, projectId, env = process.env) {
  const [report, deliveries] = await Promise.all([
    getGrowthReport(userId, projectId, "28daysAgo", env).catch(() => null),
    getPool(env).query(
      `SELECT channel, status, payload->>'subject' AS subject, payload->>'text' AS text,
              result->'performance' AS performance, completed_at, error
         FROM market_agent_delivery_jobs
        WHERE user_id = $1 AND project_id = $2
          AND created_at >= NOW() - INTERVAL '90 days'
        ORDER BY created_at DESC LIMIT 60`,
      [userId, projectId],
    ).then((result) => result.rows).catch(() => []),
  ]);
  const summary = {
    goal: report?.goal || null,
    funnel: report?.funnel || [],
    channels: report?.channels || [],
    campaigns: report?.campaigns || [],
    recommendations: report?.recommendations || [],
    delivered: deliveries.filter((item) => item.status === "complete").length,
    failed: deliveries.filter((item) => ["failed", "dead_letter"].includes(item.status)).length,
    measuredItems: deliveries.filter((item) => item.performance && Object.keys(item.performance).length).slice(0, 20).map((item) => ({
      channel: item.channel,
      subject: String(item.subject || item.text || "").slice(0, 140),
      metrics: item.performance,
      completedAt: item.completed_at,
    })),
  };
  return `LIVE PERFORMANCE — use this to decide what to continue, change, or stop. Never invent missing values.\n${JSON.stringify(summary, null, 2).slice(0, 20_000)}`;
}

export function inferGrowthPlan(workspace) {
  const saved = workspace?.growth && typeof workspace.growth === "object" ? workspace.growth : {};
  if (saved.objective && saved.primaryConversion) return normalizePlan(saved);
  const context = [workspace?.name, workspace?.description, workspace?.segmentation, workspace?.positioning, workspace?.audience, workspace?.valueProposition, workspace?.manifesto, workspace?.website].filter(Boolean).join(" ").toLowerCase();
  let objective = "visibility";
  let primaryConversion = "contact_form";
  let rationale = "The project is currently best served by increasing qualified visibility, with enquiries as the downstream business action.";
  if (/\b(shop|store|e-?commerce|retail|product sales|checkout|buy|purchase|merch)\b/.test(context)) {
    objective = "sales"; primaryConversion = "purchase"; rationale = "The project sells products, so completed purchases are the clearest primary outcome.";
  } else if (/\b(newsletter|publication|editorial|subscriber|mailing list|membership)\b/.test(context)) {
    objective = "newsletter"; primaryConversion = "newsletter_signup"; rationale = "The project depends on an owned audience, so confirmed newsletter registrations are the strongest primary outcome.";
  } else if (/\b(demo|saas|software|platform|app\b|pilot|book a demo|request a demo)\b/.test(context)) {
    objective = "leads"; primaryConversion = "demo_request"; rationale = "The offer requires evaluation before purchase, so qualified demo requests are the strongest primary outcome.";
  } else if (/\b(agency|studio|consult|service|production|creative director|b2b|business-to-business|venue|operator|client brief)\b/.test(context)) {
    objective = "leads"; primaryConversion = "contact_form"; rationale = "The project sells a considered service, so qualified enquiries are more meaningful than raw engagement.";
  } else if (/\b(community|creator|artist|influencer|audience growth|followers|awareness)\b/.test(context)) {
    objective = "audience"; primaryConversion = "newsletter_signup"; rationale = "The project depends on building a repeat audience, with an owned subscription as the most durable conversion.";
  }
  return normalizePlan({ ...saved, objective, primaryConversion, selectedBy: "assistant", rationale });
}

function normalizePlan(value) {
  return {
    objective: String(value.objective || "visibility"),
    primaryConversion: String(value.primaryConversion || "contact_form"),
    analyticsEvent: String(value.analyticsEvent || ""),
    selectedBy: value.selectedBy === "user" ? "user" : "assistant",
    rationale: String(value.rationale || ""),
    targetValue: Math.max(0, number(value.targetValue)),
    targetPeriodDays: [7, 14, 30, 60, 90].includes(number(value.targetPeriodDays)) ? number(value.targetPeriodDays) : 30,
  };
}

function resolveAnalyticsEvent(goal, events) {
  if (goal.analyticsEvent && events.some((item) => item.eventName === goal.analyticsEvent)) return goal.analyticsEvent;
  const candidates = conversionEvents(goal.primaryConversion);
  return candidates.find((candidate) => events.some((item) => item.eventName.toLowerCase() === candidate)) || "";
}

function conversionEvents(value) {
  if (value === "purchase") return ["purchase"];
  if (value === "newsletter_signup") return ["newsletter_signup", "sign_up", "subscribe"];
  if (value === "demo_request") return ["demo_request", "book_demo", "generate_lead", "form_submit"];
  if (value === "contact_form") return ["generate_lead", "contact_form", "form_submit", "contact"];
  if (value === "reply") return ["reply", "email_reply"];
  return [];
}

function channelVisibility(report) {
  for (const key of ["reach", "impressions", "views"]) {
    const value = optionalNumber(report?.totals?.[key]);
    if (value != null) return value;
  }
  return null;
}

function channelAudience(report) {
  for (const key of ["followers", "subscribers", "members"]) {
    const current = optionalNumber(report?.account?.[key]);
    if (current == null) continue;
    const compared = report?.comparison?.metrics?.[key];
    return { current, previous: optionalNumber(compared?.previous) };
  }
  return { current: null, previous: null };
}

function growthMetric(key, label, value, previous, unit, source, note) {
  const currentValue = optionalNumber(value);
  const previousValue = optionalNumber(previous);
  const change = currentValue != null && previousValue != null ? currentValue - previousValue : null;
  return { key, label, value: currentValue, previous: previousValue, change, changePercent: change != null && previousValue !== 0 ? (change / previousValue) * 100 : null, unit, source, note };
}

function sum(rows, key) { return (rows || []).reduce((total, row) => total + number(row?.[key]), 0); }
function sumMatchingEvents(rows, eventName) { return (rows || []).filter((row) => String(row.eventName || "") === eventName).reduce((total, row) => total + number(row.keyEvents), 0); }
function campaignValueForSource(rows, provider, key) { return (rows || []).filter((row) => sourceMatches(row.sessionManualSource, provider)).reduce((total, row) => total + number(row[key]), 0); }
function campaignEventValueForSource(rows, provider, eventName) { return (rows || []).filter((row) => sourceMatches(row.sessionManualSource, provider) && String(row.eventName || "") === eventName).reduce((total, row) => total + number(row.keyEvents), 0); }
function campaignEventValue(rows, campaign, eventName) { return (rows || []).filter((row) => String(row.eventName || "") === eventName && String(row.sessionManualCampaignId || "") === String(campaign.sessionManualCampaignId || "") && String(row.sessionManualCampaignName || "") === String(campaign.sessionManualCampaignName || "") && String(row.sessionManualSource || "") === String(campaign.sessionManualSource || "")).reduce((total, row) => total + number(row.keyEvents), 0); }
function sourceMatches(value, provider) { return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "") === String(provider || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

function buildRecommendations({ analytics, socialReports, metrics, goal, selectedEvent, campaigns }) {
  const results = [];
  if (!analytics) results.push({ level: "setup", title: "Website outcomes are not measurable yet", detail: "Channel activity cannot be connected to enquiries or sales without the project’s Analytics property.", action: "Connect Google Analytics for this project." });
  else if (!campaigns.length) results.push({ level: "setup", title: "Campaign attribution starts with the next tracked click", detail: "No Market Agent campaign identifier has appeared in Analytics during this period.", action: "Publish the prepared tracked links; the agent will attribute visits automatically." });
  if (!selectedEvent) results.push({ level: "attention", title: `${conversionName(goal.primaryConversion)} is not configured as a measurable event`, detail: "The assistant selected the outcome from the project scope, but Analytics has not returned a matching key event.", action: "Keep the suggested outcome or change it; then configure the corresponding website event once." });
  if (!socialReports.some((report) => report.comparison)) results.push({ level: "setup", title: "Audience-growth baseline started", detail: "Follower and subscriber totals are now being stored daily. A real increase or decrease appears after another daily snapshot.", action: "No action required." });
  const visits = metrics.find((metric) => metric.key === "visits");
  const leads = metrics.find((metric) => metric.key === "leads");
  if (visits?.change > 0 && leads?.value === 0) results.push({ level: "attention", title: "Traffic increased without a qualified action", detail: "The campaign is creating visits, but the selected conversion has not followed.", action: "The agent should review the landing-page offer, proof, and call to action before increasing distribution." });
  if (leads?.change > 0) results.push({ level: "positive", title: "Qualified actions increased", detail: `${conversionName(goal.primaryConversion)} improved against the preceding equivalent period.`, action: "Prioritize the campaigns and channels contributing those actions." });
  if (!results.length) results.push({ level: "positive", title: "Measurement is operational", detail: "The current period is connected to live channel and website data.", action: "Continue the campaign until enough evidence exists for a meaningful optimization." });
  return results.slice(0, 4);
}

function conversionLabel(value) { return value === "purchase" ? "Attributed purchases" : value === "newsletter_signup" ? "Attributed registrations" : value === "demo_request" ? "Attributed demo requests" : value === "reply" ? "Attributed replies" : "Attributed enquiries"; }
function conversionName(value) { return value === "purchase" ? "purchase" : value === "newsletter_signup" ? "newsletter registration" : value === "demo_request" ? "demo request" : value === "reply" ? "reply" : "qualified enquiry"; }
function number(value) { const numeric = Number(value || 0); return Number.isFinite(numeric) ? numeric : 0; }
function optionalNumber(value) { if (value === null || value === undefined || value === "") return null; const numeric = Number(value); return Number.isFinite(numeric) ? numeric : null; }
