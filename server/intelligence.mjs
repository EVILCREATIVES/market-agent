import { randomUUID } from "node:crypto";

export const SECTOR_KNOWLEDGE_CATEGORIES = [
  "industry_business_model",
  "customer_segments",
  "decision_process",
  "problems_objections_triggers",
  "competitors_alternatives",
  "terminology_conventions",
  "regulations_risks_proof",
  "seasonality_events_signals",
];

export const SECTOR_CATEGORY_LABELS = {
  industry_business_model: "Industry and business model",
  customer_segments: "Customer segments and buyer roles",
  decision_process: "Decision process and procurement cycle",
  problems_objections_triggers: "Problems, objections and triggers",
  competitors_alternatives: "Competitors and alternatives",
  terminology_conventions: "Terminology and communication conventions",
  regulations_risks_proof: "Regulations, risks and proof requirements",
  seasonality_events_signals: "Seasonality, events and current signals",
};

export function emptySectorExpertise() {
  return {
    summary: "",
    items: [],
    missingKnowledge: [],
    refreshedAt: "",
  };
}

export function normalizeSectorExpertise(value, existing = emptySectorExpertise()) {
  const source = value && typeof value === "object" ? value : {};
  const current = existing && typeof existing === "object" ? existing : emptySectorExpertise();
  const corrected = new Map(
    (Array.isArray(current.items) ? current.items : [])
      .filter((item) => item?.userCorrected)
      .map((item) => [sectorItemKey(item), normalizeSectorItem(item)]),
  );
  const correctedById = new Map(Array.from(corrected.values()).map((item) => [item.id, item]));
  const merged = new Map();
  for (const item of Array.isArray(current.items) ? current.items : []) {
    const normalized = normalizeSectorItem(item);
    if (normalized.statement) merged.set(sectorItemKey(normalized), normalized);
  }
  for (const item of Array.isArray(source.items) ? source.items : []) {
    const normalized = normalizeSectorItem(item);
    if (!normalized.statement) continue;
    const key = sectorItemKey(normalized);
    const protectedCorrection = corrected.get(key) || correctedById.get(normalized.id);
    if (protectedCorrection) merged.set(sectorItemKey(protectedCorrection), protectedCorrection);
    else merged.set(key, normalized);
  }
  for (const [key, item] of corrected) merged.set(key, item);
  const items = Array.from(merged.values())
    .sort((left, right) => Number(Boolean(right.userCorrected)) - Number(Boolean(left.userCorrected)) || String(right.observedAt).localeCompare(String(left.observedAt)))
    .slice(0, 240);
  return {
    summary: cleanText(source.summary || current.summary, 4_000),
    items,
    missingKnowledge: uniqueStrings(source.missingKnowledge || current.missingKnowledge, 40, 500),
    refreshedAt: validDate(source.refreshedAt) || validDate(current.refreshedAt) || (items.length ? new Date().toISOString() : ""),
  };
}

export function applySectorCorrection(expertise, correction) {
  const current = normalizeSectorExpertise(expertise);
  const corrected = normalizeSectorItem({
    ...correction,
    id: correction?.id || randomUUID(),
    sourceTitle: correction?.sourceTitle || "User correction",
    sourceUrl: correction?.sourceUrl || "",
    observedAt: correction?.observedAt || new Date().toISOString(),
    confidence: "high",
    verificationStatus: "verified",
    userCorrected: true,
  });
  if (!corrected.statement) return current;
  const items = current.items.filter((item) => item.id !== corrected.id && sectorItemKey(item) !== sectorItemKey(corrected));
  return normalizeSectorExpertise({ ...current, items: [corrected, ...items], refreshedAt: new Date().toISOString() });
}

export function sectorCoverage(expertise) {
  const normalized = normalizeSectorExpertise(expertise);
  const verifiedCategories = new Set(normalized.items.filter((item) => item.verificationStatus === "verified" || item.userCorrected).map((item) => item.category));
  const supportedCategories = new Set(normalized.items.filter((item) => item.sourceUrl || item.userCorrected).map((item) => item.category));
  return {
    totalItems: normalized.items.length,
    verifiedItems: normalized.items.filter((item) => item.verificationStatus === "verified" || item.userCorrected).length,
    categoriesCovered: supportedCategories.size,
    categoriesVerified: verifiedCategories.size,
    readyForStrategy: supportedCategories.size >= 5 && normalized.items.length >= 8,
    missingCategories: SECTOR_KNOWLEDGE_CATEGORIES.filter((category) => !supportedCategories.has(category)),
  };
}

export function experimentReadiness(experiment) {
  const value = experiment && typeof experiment === "object" ? experiment : {};
  const checks = {
    hypothesis: cleanText(value.hypothesis, 2_000),
    audienceSegment: cleanText(value.audienceSegment, 1_000),
    variant: cleanText(value.variant, 1_000),
    businessOutcome: cleanText(value.businessOutcome, 1_000),
    minimumEvidence: cleanText(value.minimumEvidence, 1_000),
    stopRule: cleanText(value.stopRule, 1_000),
    reviseRule: cleanText(value.reviseRule, 1_000),
    continueRule: cleanText(value.continueRule, 1_000),
    whyAudience: cleanText(value.whyAudience, 1_500),
    whyIdea: cleanText(value.whyIdea, 1_500),
    whyNow: cleanText(value.whyNow, 1_500),
    evidenceRationale: cleanText(value.evidenceRationale, 2_000),
    learningGoal: cleanText(value.learningGoal, 1_500),
  };
  const missing = Object.entries(checks).filter(([, text]) => !text).map(([key]) => key);
  const requestedCohort = Math.max(0, Math.round(Number(value.cohortSize || 0)));
  const cohortSize = requestedCohort || 25;
  if (cohortSize < 20 || cohortSize > 30) missing.push("cohortSize");
  const evidence = Array.isArray(value.evidence) ? value.evidence.filter((item) => item?.claim && (item?.url || (/^user correction$/i.test(String(item?.title || "")) && item?.verificationStatus === "verified"))) : [];
  if (!evidence.length) missing.push("evidence");
  return {
    ready: missing.length === 0,
    missing: Array.from(new Set(missing)),
    cohortSize,
  };
}

export function assertExperimentReady(run) {
  const readiness = experimentReadiness(run?.experimentPlan);
  if (readiness.ready) return readiness;
  const error = new Error(`This campaign is not ready to execute. Complete its hypothesis and learning gate first: ${readiness.missing.join(", ")}.`);
  error.statusCode = 409;
  error.code = "EXPERIMENT_NOT_READY";
  throw error;
}

export function strategyIsGeneric(territory, projectName = "") {
  const value = territory && typeof territory === "object" ? territory : {};
  const combined = [value.sectorInsight, value.audienceTension, value.strategicProposition, value.creativeConcept, value.offer, value.conversionPath]
    .map((item) => cleanText(item, 3_000).toLowerCase()).join(" ");
  const genericPhrases = ["increase awareness", "engage the audience", "tell your story", "stand out", "unlock potential", "drive engagement", "meaningful connections", "innovative solution"];
  const sectorSpecificSignals = [value.sectorInsight, value.audienceTension, value.requiredProof]
    .map((item) => cleanText(item, 2_000)).filter((item) => item.length >= 45).length;
  const projectMentioned = projectName ? combined.includes(String(projectName).toLowerCase()) : false;
  return sectorSpecificSignals < 2 || (genericPhrases.some((phrase) => combined.includes(phrase)) && !projectMentioned);
}

export function normalizeStrategyPlan(value, projectName = "") {
  const source = value && typeof value === "object" ? value : {};
  const territories = (Array.isArray(source.territories) ? source.territories : []).map((territory, index) => ({
    id: cleanText(territory?.id, 120) || `territory-${index + 1}`,
    title: cleanText(territory?.title, 300),
    sectorInsight: cleanText(territory?.sectorInsight, 2_000),
    audienceTension: cleanText(territory?.audienceTension, 2_000),
    strategicProposition: cleanText(territory?.strategicProposition, 2_000),
    creativeConcept: cleanText(territory?.creativeConcept, 2_000),
    offer: cleanText(territory?.offer, 2_000),
    requiredProof: cleanText(territory?.requiredProof, 2_000),
    conversionPath: cleanText(territory?.conversionPath, 2_000),
    channels: uniqueStrings(territory?.channels, 10, 120),
    experimentDesign: cleanText(territory?.experimentDesign, 3_000),
    risks: uniqueStrings(territory?.risks, 10, 600),
    failureReasons: uniqueStrings(territory?.failureReasons, 10, 600),
    evidence: normalizeEvidence(territory?.evidence),
    criticVerdict: ["accepted", "rejected", "revised"].includes(territory?.criticVerdict) ? territory.criticVerdict : "rejected",
    criticReason: cleanText(territory?.criticReason, 2_000),
  })).filter((territory) => territory.title && territory.criticVerdict !== "rejected" && !strategyIsGeneric(territory, projectName)).slice(0, 6);
  const selectedId = territories.some((territory) => territory.id === source.selectedTerritoryId)
    ? source.selectedTerritoryId
    : territories.find((territory) => territory.criticVerdict !== "rejected")?.id || "";
  return {
    summary: cleanText(source.summary, 4_000),
    territories,
    selectedTerritoryId: selectedId,
    rejectedCount: Math.max(0, Number(source.rejectedCount || 0)),
    generatedAt: validDate(source.generatedAt) || new Date().toISOString(),
  };
}

export function renderStrategyPlan(plan, experiment) {
  const normalized = normalizeStrategyPlan(plan);
  const selected = normalized.territories.find((territory) => territory.id === normalized.selectedTerritoryId) || normalized.territories[0];
  if (!selected) return "No sector-grounded territory passed the originality and commercial-feasibility review. Nothing was prepared for execution.";
  const readiness = experimentReadiness(experiment);
  return [
    `## Recommended territory — ${selected.title}`,
    `**Sector insight:** ${selected.sectorInsight}`,
    `**Audience tension:** ${selected.audienceTension}`,
    `**Strategic proposition:** ${selected.strategicProposition}`,
    `**Creative concept:** ${selected.creativeConcept}`,
    `**Offer and required proof:** ${selected.offer}\n\n${selected.requiredProof}`,
    `**Conversion path:** ${selected.conversionPath}`,
    `**Recommended channels:** ${selected.channels.join(", ") || "Not established"}`,
    `**Experiment:** ${selected.experimentDesign}`,
    `**Why it may fail:** ${selected.failureReasons.join("; ") || selected.risks.join("; ") || "No credible failure analysis was returned."}`,
    `## Execution gate`,
    readiness.ready
      ? `Ready for a ${readiness.cohortSize}-person test cohort. The hypothesis, evidence threshold, and stop/revise/continue rules are recorded.`
      : `Blocked. Missing: ${readiness.missing.join(", ")}. No execution queue was created.`,
  ].join("\n\n");
}

export function sectorExpertiseSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "items", "missingKnowledge", "refreshedAt"],
    properties: {
      summary: { type: "string" },
      refreshedAt: { type: "string" },
      missingKnowledge: { type: "array", items: { type: "string" } },
      items: {
        type: "array",
        items: {
          type: "object", additionalProperties: false,
          required: ["id", "category", "statement", "sourceTitle", "sourceUrl", "observedAt", "confidence", "verificationStatus", "userCorrected"],
          properties: {
            id: { type: "string" },
            category: { type: "string", enum: SECTOR_KNOWLEDGE_CATEGORIES },
            statement: { type: "string" },
            sourceTitle: { type: "string" },
            sourceUrl: { type: "string" },
            observedAt: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
            verificationStatus: { type: "string", enum: ["verified", "hypothesis", "needs_review", "outdated"] },
            userCorrected: { type: "boolean" },
          },
        },
      },
    },
  };
}

export function strategyPlanSchema() {
  return {
    type: "object", additionalProperties: false,
    required: ["summary", "territories", "selectedTerritoryId", "rejectedCount", "generatedAt"],
    properties: {
      summary: { type: "string" },
      selectedTerritoryId: { type: "string" },
      rejectedCount: { type: "integer" },
      generatedAt: { type: "string" },
      territories: {
        type: "array", minItems: 3, maxItems: 5,
        items: {
          type: "object", additionalProperties: false,
          required: ["id", "title", "sectorInsight", "audienceTension", "strategicProposition", "creativeConcept", "offer", "requiredProof", "conversionPath", "channels", "experimentDesign", "risks", "failureReasons", "evidence", "criticVerdict", "criticReason"],
          properties: {
            id: { type: "string" }, title: { type: "string" }, sectorInsight: { type: "string" }, audienceTension: { type: "string" }, strategicProposition: { type: "string" }, creativeConcept: { type: "string" }, offer: { type: "string" }, requiredProof: { type: "string" }, conversionPath: { type: "string" },
            channels: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
            experimentDesign: { type: "string" },
            risks: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
            failureReasons: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
            evidence: { type: "array", minItems: 1, maxItems: 10, items: evidenceSchema() },
            criticVerdict: { type: "string", enum: ["accepted", "rejected", "revised"] },
            criticReason: { type: "string" },
          },
        },
      },
    },
  };
}

export function experimentPlanSchema() {
  return {
    type: "object", additionalProperties: false,
    required: ["hypothesis", "audienceSegment", "variant", "businessOutcome", "minimumEvidence", "stopRule", "reviseRule", "continueRule", "cohortSize", "whyAudience", "whyIdea", "whyNow", "evidenceRationale", "learningGoal", "evidence"],
    properties: {
      hypothesis: { type: "string" }, audienceSegment: { type: "string" }, variant: { type: "string" }, businessOutcome: { type: "string" }, minimumEvidence: { type: "string" }, stopRule: { type: "string" }, reviseRule: { type: "string" }, continueRule: { type: "string" },
      cohortSize: { type: "integer", minimum: 20, maximum: 30 },
      whyAudience: { type: "string" }, whyIdea: { type: "string" }, whyNow: { type: "string" }, evidenceRationale: { type: "string" }, learningGoal: { type: "string" },
      evidence: { type: "array", minItems: 1, maxItems: 12, items: evidenceSchema() },
    },
  };
}

function evidenceSchema() {
  return {
    type: "object", additionalProperties: false,
    required: ["claim", "title", "url", "observedAt", "confidence", "verificationStatus"],
    properties: {
      claim: { type: "string" }, title: { type: "string" }, url: { type: "string" }, observedAt: { type: "string" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      verificationStatus: { type: "string", enum: ["verified", "hypothesis", "needs_review", "outdated"] },
    },
  };
}

function normalizeSectorItem(item) {
  const source = item && typeof item === "object" ? item : {};
  return {
    id: cleanText(source.id, 120) || randomUUID(),
    category: SECTOR_KNOWLEDGE_CATEGORIES.includes(source.category) ? source.category : "industry_business_model",
    statement: cleanText(source.statement, 3_000),
    sourceTitle: cleanText(source.sourceTitle, 500),
    sourceUrl: safeSourceUrl(source.sourceUrl),
    observedAt: validDate(source.observedAt) || new Date().toISOString(),
    confidence: ["high", "medium", "low"].includes(source.confidence) ? source.confidence : "low",
    verificationStatus: ["verified", "hypothesis", "needs_review", "outdated"].includes(source.verificationStatus) ? source.verificationStatus : "needs_review",
    userCorrected: source.userCorrected === true,
  };
}

function normalizeEvidence(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    claim: cleanText(item?.claim, 2_000), title: cleanText(item?.title, 500), url: safeSourceUrl(item?.url), observedAt: validDate(item?.observedAt) || new Date().toISOString(),
    confidence: ["high", "medium", "low"].includes(item?.confidence) ? item.confidence : "low",
    verificationStatus: ["verified", "hypothesis", "needs_review", "outdated"].includes(item?.verificationStatus) ? item.verificationStatus : "needs_review",
  })).filter((item) => item.claim && (item.url || (/^user correction$/i.test(item.title) && item.verificationStatus === "verified"))).slice(0, 12);
}

function sectorItemKey(item) {
  return `${item.category}:${String(item.statement || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 180)}`;
}

function safeSourceUrl(value) {
  const text = cleanText(value, 2_000);
  if (!text) return "";
  try { const url = new URL(text); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : ""; }
  catch { return ""; }
}

function validDate(value) {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function uniqueStrings(value, maximum, length) {
  return Array.from(new Set((Array.isArray(value) ? value : []).map((item) => cleanText(item, length)).filter(Boolean))).slice(0, maximum);
}

function cleanText(value, maximum) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
}
