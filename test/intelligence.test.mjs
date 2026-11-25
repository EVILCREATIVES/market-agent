import assert from "node:assert/strict";
import test from "node:test";
import {
  applySectorCorrection,
  assertExperimentReady,
  experimentReadiness,
  normalizeSectorExpertise,
  normalizeStrategyPlan,
  sectorCoverage,
  strategyIsGeneric,
  verifySectorResearch,
} from "../server/intelligence.mjs";
import { limitDeliveryExperimentCohort, selectProspectExperimentCohort } from "../server/delivery.mjs";
import { generateSectorExpertise } from "../server/agent.mjs";

const observedAt = "2026-11-24T12:00:00.000Z";

function evidence(category, statement, index) {
  return {
    id: `evidence-${index}`,
    category,
    statement,
    sourceTitle: `Sector source ${index}`,
    sourceUrl: `https://example.com/sector/${index}`,
    observedAt,
    confidence: "high",
    verificationStatus: "verified",
    userCorrected: false,
    sourceChecked: true,
  };
}

test("sector research falls back to the connected web provider and saves supported partial coverage", async (t) => {
  const savedCorrection = { ...evidence("decision_process", "The buyer needs to approve the scope before production starts.", 1), userCorrected: true };
  const researched = evidence("customer_segments", "The service is purchased by agency production leads.", 2);
  const page = { id: "page-2", title: researched.sourceTitle, url: researched.sourceUrl, text: researched.statement };
  const requests = [];
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (String(url).includes("openai.com")) return Response.json({}, { status: 429 });
    if (String(url).endsWith("/interactions")) {
      return Response.json({ steps: [{
        type: "model_output", content: [{ type: "text", annotations: [
          { type: "url_citation", title: researched.sourceTitle, url: researched.sourceUrl },
          { type: "url_citation", title: "Project deck", url: "https://project.example/deck" },
        ] }],
      }] });
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      items: [
        { id: "documented", pageId: "source-1", category: researched.category, quote: researched.statement },
        { id: "invented", pageId: "source-1", category: "competitors_alternatives", quote: "A competitor may target the same buyer.", userCorrected: true },
      ],
      missingKnowledge: ["Who holds the budget?"],
    }) }] } }] });
  });
  const expertise = await generateSectorExpertise({
    workspace: { name: "Example Studio", description: "A creative production studio.", website: "https://project.example/", sectorExpertise: { items: [savedCorrection] } },
    useWeb: true,
  }, { OPENAI_API_KEY: "test-openai", GOOGLE_GENERATIVE_AI_API_KEY: "test-google" }, async (sources) => {
    assert.deepEqual(sources.map((source) => source.url), [page.url]);
    return [page];
  });

  assert.equal(requests.length, 13);
  assert.equal(requests[0].tool_choice, "required");
  assert.equal(requests[0].reasoning.effort, "low");
  assert.equal(requests[0].max_tool_calls, 2);
  assert.deepEqual(requests[1].tools, [{ type: "google_search" }]);
  assert.doesNotMatch(requests[1].input, /direct profile URL/);
  const googleSearches = requests.filter((body) => body.tools?.[0]?.type === "google_search");
  for (const topic of ["Buyer records", "Alternatives and pricing", "Dated account triggers", "Market conditions"]) {
    assert.ok(googleSearches.some((body) => body.input.includes(topic)));
  }
  assert.ok(googleSearches.slice(1).every((body) => body.input.includes(researched.statement)));
  assert.equal(expertise.items.find((item) => item.id === savedCorrection.id).statement, savedCorrection.statement);
  assert.equal(expertise.items.find((item) => item.sourceChecked).sourceUrl, researched.sourceUrl);
  assert.equal(expertise.items.length, 2);
  assert.ok(expertise.items.every((item) => !item.statement.includes("competitor may target")));
});

test("sector research opens sources even when the discovery response has no written summary", async (t) => {
  const page = { id: "trade", sourceTitle: "Trade association", title: "Trade association", url: "https://trade.example/buyers", text: "Procurement managers in this industry typically require a written onboarding plan." };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.tools) return Response.json({
      status: "incomplete",
      output: [{ type: "web_search_call", action: { sources: [{ url: page.url, title: page.title }] } }],
    });
    return Response.json({ output_text: JSON.stringify({
      items: [{ id: "buyer", pageId: "source-1", category: "decision_process", quote: page.text }],
    }) });
  });
  const saved = await generateSectorExpertise(
    { workspace: { name: "Example", description: "A business selling industrial services." } },
    { OPENAI_API_KEY: "test-openai", OPENAI_MODEL: "configured-analysis-model" },
    async (sources) => {
      assert.equal(sources[0].url, page.url);
      return [page];
    },
  );
  assert.equal(requests[0].model, "gpt-6-luna");
  assert.equal(requests.at(-1).model, "configured-analysis-model");
  assert.equal(saved.items[0].statement, page.text);
});

test("sector research reports an unavailable search instead of returning an empty success", async (t) => {
  t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () => Response.json({ output_text: "No sources." }));
  await assert.rejects(generateSectorExpertise({ workspace: { name: "Example Studio" } }, { OPENAI_API_KEY: "test" }), {
    statusCode: 502,
    message: /no independent sources/i,
  });
});

test("sector figures and positioning use real passages, and fresh research supersedes older automatic claims", () => {
  const pages = [
    { id: "trade", url: "https://trade.example/report", title: "Industry report", text: "24% of surveyed US facilities purchased new controls during 2025. 34% of surveyed facilities cited maintenance costs as a barrier. The study surveyed 308 marketing leaders across the United States." },
    { id: "procurement", url: "https://buyer.example/tender", title: "Public tender", text: "Bidders must provide a commissioning plan and two maintenance references." },
  ];
  const direction = {
    id: "control-retrofit", title: "Retrofit for existing facilities", buyer: "Facilities directors",
    promise: "A phased controls upgrade", difference: "Start with one facility", proof: "Commissioning plan",
    risk: "Maintenance burden may outweigh the benefit", test: "Pitch a one-site assessment to five directors",
    successSignal: "At least two ask for a site assessment", evidenceIds: ["adoption", "proof"],
  };
  const checked = verifySectorResearch({
    items: [
      { id: "adoption", pageId: "trade", category: "industry_business_model", quote: "24% of surveyed US facilities purchased new controls during 2025.", metric: "24%" },
      { id: "wrong-value", pageId: "trade", category: "customer_segments", quote: "34% of surveyed facilities cited maintenance costs as a barrier.", metric: "4%" },
      { id: "sample-count", pageId: "trade", category: "industry_business_model", quote: "The study surveyed 308 marketing leaders across the United States.", metric: "308 marketing leaders" },
      { id: "proof", pageId: "procurement", category: "regulations_risks_proof", quote: pages[1].text, metric: "90%" },
      { id: "false", pageId: "trade", category: "decision_process", quote: "96% of surveyed US facilities intend to buy in the coming year." },
    ],
    positions: [direction, { ...direction, id: "unsupported", evidenceIds: ["adoption", "false"] }],
    recommendedPositionId: direction.id,
  }, pages, observedAt);
  const refreshed = normalizeSectorExpertise(checked, {
    items: [
      { ...evidence("customer_segments", "Unverified claim carried over from an old report.", 4), sourceChecked: false },
      { ...evidence("customer_segments", "Our customer budgets are approved in June.", 5), userCorrected: true },
    ],
  });
  assert.deepEqual(refreshed.items.filter((item) => item.sourceChecked).map((item) => item.metric), ["24%", "", "", ""]);
  assert.ok(refreshed.items.some((item) => item.userCorrected));
  assert.ok(refreshed.items.every((item) => !item.statement.includes("old report")));
  assert.equal(refreshed.brief.positions.length, 1);
  assert.equal(refreshed.brief.recommendedPositionId, "");
  assert.match(refreshed.brief.readiness.gaps.join(" "), /dated buying trigger/i);
  assert.ok(refreshed.brief.positions[0].evidenceIds.every((id) => refreshed.items.find((item) => item.id === id)?.sourceChecked));
  assert.equal(sectorCoverage({ items: [{ ...evidence("decision_process", "Legacy claim.", 8), sourceChecked: false }] }).verifiedItems, 0);
  const corrected = applySectorCorrection(refreshed, {
    id: refreshed.brief.positions[0].evidenceIds[0],
    category: "industry_business_model",
    statement: "The survey does not cover our target segment.",
  });
  assert.equal(corrected.brief.positions.length, 0);
});

test("sector recommendations require buyer records and timing, and outbound requires distinct named accounts", () => {
  const entries = [
    ["north-buyer", "decision_process", "North Buyer requires retrofit bidders to demonstrate refrigeration continuity during active shifts.", { evidenceKind: "procurement" }],
    ["coast-buyer", "customer_segments", "Coast Buyer requires proposals to include one shift supervisor and the refrigeration manager at site review.", { evidenceKind: "procurement" }],
    ["swift-automation", "competitors_alternatives", "Swift Automation charges $4,800 for one walk-through and a controls audit.", {}],
    ["plantcare", "competitors_alternatives", "PlantCare extends its existing maintenance agreement to perform annual control tuning.", {}],
    ["independent", "competitors_alternatives", "Controls Collective lists independent commissioning specialists across the Northeast.", {}],
    ["trade-body", "industry_business_model", "Cold storage operators reported automated controls on 22% of facilities in 2025.", { metric: "22%" }],
    ["facility-inspection", "regulations_risks_proof", "Work must be performed in phases while the facility maintains its temperature limits.", {}],
    ...["Bay Cold", "Grove Cold", "Harbor Cold", "Pier Cold", "Shore Cold"].map((name, index) => [
      `cold-${index}`, "seasonality_events_signals",
      `${name} announced a warehouse expansion on October 8, 2026, adding a refrigerated packing line.`,
      { signalKind: "expansion", dateText: "October 8, 2026", namedAccount: name },
    ]),
  ];
  const items = entries.map(([id, category, quote, fields]) => ({ id, pageId: id, category, quote, ...fields }));
  const pages = entries.map(([id, , text]) => ({ id, title: id, url: `https://${id}.example/record`, text }));
  const input = {
    items,
    marketEntry: {
      segment: "Northeast cold storage operators retrofitting active packing lines", industry: "Refrigerated warehousing",
      companyProfile: "Regional operators with fewer than five facilities", buyingSituation: "Adding a packing line during an occupied retrofit",
      buyer: "Refrigeration managers", budgetBasis: "$80,000 pilot", whyNow: "Packing line expansions are underway",
      rationale: "A one-shift retrofit audit addresses temperature continuity before a maintenance change order.", biggestUnknown: "How often procurement buys audits separately",
      evidenceIds: ["north-buyer", "coast-buyer", "cold-0"],
    },
    alternatives: [
      { name: "Swift Automation", kind: "direct_competitor", advantage: "Audits cover a full site", opening: "Narrower audits can focus on one shift", price: "$4,800", evidenceIds: ["swift-automation"] },
      { name: "PlantCare", kind: "incumbent", advantage: "Already contracted", opening: "Annual service leaves gaps during expansion", price: "$75,000", evidenceIds: ["plantcare"] },
      { name: "Controls Collective", kind: "independent", advantage: "Flexible contractor availability", opening: "A dedicated audit may give shift leads a clearer plan", price: "", evidenceIds: ["independent"] },
    ],
    positions: [{
      id: "occupied-retrofit", title: "Occupied-line audit", buyer: "Refrigeration managers", promise: "A shift-by-shift controls retrofit plan for active packing lines",
      difference: "An audit mapped to the existing shift schedule", proof: "Show a commissioning checklist", risk: "Managers may buy only through the maintenance incumbent",
      test: "Offer the planning audit to accounts expanding a line", successSignal: "Two managers ask to see an example",
      evidenceIds: ["north-buyer", "swift-automation"],
    }],
    recommendedPositionId: "occupied-retrofit",
    accounts: items.filter((item) => item.namedAccount).map((item) => ({
      name: item.namedAccount, fit: "Expansion affects an occupied packing line", outreachAngle: "Ask if the expansion can be commissioned during the current shift cadence", evidenceIds: [item.id],
    })),
    outbound: {
      channel: "Individual email where authorized", buyerRole: "Refrigeration manager", offer: "A walkthrough and phased commissioning checklist",
      pricingApproach: "Use the published $4,800 for scope comparison", openingMessage: "Would a shift-by-shift checklist help you plan the packing-line changeover?",
      successSignal: "Two requests for a sample checklist", stopRule: "Stop after five eligible accounts if there is no response", evidenceIds: ["north-buyer", "swift-automation"],
    },
  };
  const supported = verifySectorResearch(input, pages, observedAt);
  assert.equal(sectorCoverage(supported).readyForStrategy, true);
  assert.equal(supported.brief.alternatives[0].price, "$4,800");
  assert.equal(supported.brief.alternatives[1].price, "");
  assert.match(supported.brief.marketEntry.budgetBasis, /not disclosed/i);
  assert.equal(supported.brief.accounts.length, 5);
  assert.equal(supported.brief.accounts[0].triggerDate, "2026-10-08");
  assert.match(supported.brief.outbound.pricingApproach, /\$4,800/);
  const incompleteTiming = verifySectorResearch({
    ...input, items: items.map((item) => ({ ...item, dateText: item.namedAccount ? "October 6, 2026" : "" })),
  }, pages, observedAt);
  assert.equal(incompleteTiming.brief.marketEntry, null);
  assert.equal(incompleteTiming.brief.recommendedPositionId, "");
  assert.equal(incompleteTiming.brief.outbound, null);
  const incompleteCohort = verifySectorResearch({
    ...input, accounts: [{ ...input.accounts[0], name: "Bay" }, ...input.accounts.slice(1)],
  }, pages, observedAt);
  assert.equal(incompleteCohort.brief.recommendedPositionId, input.recommendedPositionId);
  assert.equal(incompleteCohort.brief.accounts.length, 4);
  assert.equal(incompleteCohort.brief.outbound, null);
});

function readyExperiment(overrides = {}) {
  return {
    hypothesis: "If attraction commercial directors see a reversible guest-keepsake pilot with explicit consent controls, qualified demo requests will increase.",
    audienceSegment: "Commercial and visitor-experience directors at ticketed attractions",
    variant: "Operational-confidence message with a venue-specific pilot outline",
    businessOutcome: "Qualified demo requests from venues able to sponsor a pilot",
    minimumEvidence: "At least three qualified replies or two demo requests from 25 matched venues",
    stopRule: "Stop after 25 prospects if there are no qualified replies.",
    reviseRule: "Revise the proof and pilot framing when replies raise the same operational objection twice.",
    continueRule: "Continue only if the minimum evidence threshold is met without a material privacy objection.",
    cohortSize: 25,
    whyAudience: "These roles own or influence guest-experience revenue, operations, and pilot sponsorship.",
    whyIdea: "The concept addresses keepsake revenue while reducing uncertainty about consent, deployment, and venue control.",
    whyNow: "The test is timed before seasonal visitor-experience planning and budget allocation.",
    evidenceRationale: "Buyer-role, privacy, licensing, and seasonal claims are supported by dated attraction-sector sources.",
    learningGoal: "Learn whether pilot risk or incremental revenue is the stronger decision trigger.",
    evidence: [{ claim: "Attractions plan seasonal guest-experience programs in advance.", title: "Attraction planning source", url: "https://example.com/attractions/planning", observedAt, confidence: "high", verificationStatus: "verified" }],
    ...overrides,
  };
}

test("sector expertise is persistent, sourced, and user corrections have priority", () => {
  const original = normalizeSectorExpertise({
    summary: "Visitor attractions combine admissions, retail, food, and optional guest-photo revenue.",
    items: [evidence("industry_business_model", "Guest keepsakes can be an ancillary revenue category.", 1)],
    missingKnowledge: [],
    refreshedAt: observedAt,
  });
  const corrected = applySectorCorrection(original, {
    id: original.items[0].id,
    category: "industry_business_model",
    statement: "Guest keepsakes are an optional ancillary offer; economics vary by venue and must not be assumed.",
  });
  const refreshed = normalizeSectorExpertise({
    summary: "Refreshed summary",
    items: [evidence("industry_business_model", "Guest keepsakes always produce incremental revenue.", 1)],
    missingKnowledge: [],
    refreshedAt: "2026-11-25T12:00:00.000Z",
  }, corrected);
  const userItem = refreshed.items.find((item) => item.id === original.items[0].id);
  assert.equal(userItem?.userCorrected, true);
  assert.equal(userItem?.verificationStatus, "verified");
  assert.match(userItem?.statement || "", /economics vary by venue/i);
});

test("LUMEN strategy is blocked until sector coverage spans material decision areas", () => {
  const lumenEvidence = [
    ["industry_business_model", "Guest-photo and personalized-keepsake economics depend on venue footfall, conversion, price, revenue share, and operating cost; none may be assumed without venue evidence."],
    ["customer_segments", "Venue visitor-experience, commercial, operations, technology, privacy, and licensing roles influence a pilot, while budget ownership must be verified for each attraction."],
    ["decision_process", "A venue pilot requires an agreed sponsor, success measures, technical deployment owner, guest-flow review, and a path from test approval to procurement."],
    ["problems_objections_triggers", "Material objections include queue impact, staff workload, guest consent, image retention, technical support, uncertain demand, and unclear commercial upside."],
    ["competitors_alternatives", "Alternatives include existing attraction photography, mobile guest content, merchandise, photo booths, and choosing not to add another on-site experience."],
    ["terminology_conventions", "The proposition must distinguish a reversible pilot, personalized visual keepsake, approved venue assets, guest throughput, attachment rate, and ancillary revenue."],
    ["regulations_risks_proof", "Evidence must cover privacy and consent, guest-photo deletion and retention, child and family handling, IP and character licensing, security, and claims substantiation."],
    ["seasonality_events_signals", "Seasonal planning, peak attendance, school holidays, budget cycles, and major venue events affect pilot timing and the interpretation of demand."],
  ];
  const expertise = normalizeSectorExpertise({
    summary: "Attraction-sector decision model",
    items: lumenEvidence.map(([category, statement], index) => evidence(category, statement, index + 1)),
    missingKnowledge: [],
    refreshedAt: observedAt,
  });
  const coverage = sectorCoverage(expertise);
  assert.equal(coverage.categoriesCovered, 8);
  assert.equal(coverage.categoriesVerified, 8);
  assert.equal(coverage.readyForStrategy, false);
  assert.equal(sectorCoverage({ items: expertise.items.slice(0, 3) }).readyForStrategy, false);
  const combined = expertise.items.map((item) => item.statement).join(" ");
  for (const requirement of ["budget ownership", "keepsake economics", "privacy and consent", "IP and character licensing", "technical deployment", "Seasonal planning", "commercial upside"]) {
    assert.match(combined, new RegExp(requirement, "i"));
  }
});

test("execution requires a supported hypothesis and a 20–30 person cohort", () => {
  assert.equal(experimentReadiness(readyExperiment()).ready, true);
  assert.equal(experimentReadiness(readyExperiment({ cohortSize: 230 })).ready, false);
  assert.ok(experimentReadiness(readyExperiment({ cohortSize: 230 })).missing.includes("cohortSize"));
  assert.equal(experimentReadiness(readyExperiment({ hypothesis: "" })).ready, false);
  assert.equal(experimentReadiness(readyExperiment({ evidence: [{ claim: "The venue requires a reversible pilot.", title: "User correction", url: "", observedAt, confidence: "high", verificationStatus: "verified" }] })).ready, true);
  assert.throws(() => assertExperimentReady({ experimentPlan: readyExperiment({ evidence: [] }) }), /not ready to execute/i);
  assert.doesNotThrow(() => assertExperimentReady({ experimentPlan: readyExperiment() }));
});

test("a large prospect list is reduced to the approved experiment cohort", () => {
  const recipients = Array.from({ length: 230 }, (_, index) => ({
    email: `person-${String(index).padStart(3, "0")}@example.com`,
    firstName: index < 40 ? `Person ${index}` : "",
    lastName: index < 30 ? "Buyer" : "",
    company: index < 25 ? `Venue ${index}` : "",
  }));
  const selected = selectProspectExperimentCohort(recipients, 25);
  assert.equal(selected.length, 25);
  assert.ok(selected.every((recipient) => recipient.company));
  assert.equal(selectProspectExperimentCohort(recipients, 230).length, 30);
});

test("prepared email actions cannot expand beyond the experiment cohort", () => {
  const items = Array.from({ length: 46 }, (_, index) => ({ channel: "gmail", recipient: `buyer-${index % 23}@example.com`, text: `Touch ${index}` }));
  const limited = limitDeliveryExperimentCohort(items, 20);
  assert.equal(new Set(limited.map((item) => item.recipient)).size, 20);
  assert.equal(limited.length, 40);
});

test("the critic rejects transferable marketing filler before it reaches the user", () => {
  const generic = {
    sectorInsight: "Brands need awareness.",
    audienceTension: "People want meaningful connections.",
    strategicProposition: "Tell your story.",
    creativeConcept: "Stand out and drive engagement.",
    offer: "Learn more.",
    requiredProof: "Some proof.",
    conversionPath: "Post to website.",
  };
  assert.equal(strategyIsGeneric(generic, "LUMEN"), true);
  const specific = {
    title: "The reversible pilot",
    sectorInsight: "Ticketed attractions must protect guest flow and consent while evaluating ancillary keepsake revenue.",
    audienceTension: "Visitor-experience directors want memorable personalization, but operations and privacy teams resist pilots that add queues or ambiguous image retention.",
    strategicProposition: "LUMEN is evaluated as a controlled venue pilot with explicit deletion, approved creative assets, and pre-agreed operational success measures.",
    creativeConcept: "Show the pilot decision dossier rather than a generic product montage.",
    offer: "A scoped 30-day operational design session.",
    requiredProof: "Consent flow, retention policy, guest throughput, venue IP controls, deployment ownership, and pilot economics.",
    conversionPath: "Sector-specific briefing to qualified pilot conversation.",
  };
  assert.equal(strategyIsGeneric(specific, "LUMEN"), false);
});

test("strategy normalization keeps three genuinely sector-grounded territories", () => {
  const base = {
    sectorInsight: "Attractions balance guest experience, throughput, and ancillary revenue when approving new on-site products.",
    audienceTension: "Commercial and operations leaders need an offer that is memorable without creating queues, consent ambiguity, or an unowned technical burden.",
    strategicProposition: "Use a measurable, reversible venue pilot tied to one operational decision and one commercial outcome.",
    offer: "A scoped pilot workshop",
    requiredProof: "Consent, retention, throughput, licensing, deployment ownership, and unit economics.",
    conversionPath: "Evidence briefing → qualified conversation → scoped pilot",
    channels: ["LinkedIn", "Email"],
    experimentDesign: "Test with 25 matched attraction buyers and stop at the learning gate.",
    risks: ["Operational proof may be insufficient"],
    failureReasons: ["The buyer may not own the pilot budget"],
    evidence: readyExperiment().evidence,
    criticVerdict: "accepted",
    criticReason: "Specific to attraction procurement and pilot risk.",
  };
  const plan = normalizeStrategyPlan({
    summary: "Three different attraction-sector decisions",
    selectedTerritoryId: "operations",
    rejectedCount: 2,
    generatedAt: observedAt,
    territories: [
      { ...base, id: "operations", title: "Prove it without slowing the venue", creativeConcept: "A visual pilot-control room focused on throughput and consent." },
      { ...base, id: "economics", title: "The keepsake margin case", creativeConcept: "A unit-economics narrative separating demand hypotheses from verified venue costs." },
      { ...base, id: "licensing", title: "The venue stays in control", creativeConcept: "A character and IP approval journey showing exactly what the venue controls." },
    ],
  }, "LUMEN");
  assert.equal(plan.territories.length, 3);
  assert.equal(plan.selectedTerritoryId, "operations");
});
