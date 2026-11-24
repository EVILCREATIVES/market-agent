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
} from "../server/intelligence.mjs";
import { limitDeliveryExperimentCohort, selectProspectExperimentCohort } from "../server/delivery.mjs";

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
  };
}

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
  assert.equal(coverage.readyForStrategy, true);
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
