import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { inflateSync } from "fflate";
import { decompress as decompressZstd } from "fzstd";
import { compileSchema, decodeBinarySchema } from "kiwi-schema";

const actionInstructions = {
  research: `Research the live market for this product now. Identify the strongest audience pains, language people actually use, relevant alternatives, timely market signals, and concrete marketing opportunities. Deliver the sourced findings, prioritized targets, and usable implications yourself; do not tell the user to assign a researcher or conduct the research later. Distinguish sourced facts from your analysis.`,
  campaign: `Build an executable campaign and complete every deliverable possible in this run. Research and deliver a sourced first-priority prospect batch, final outreach copy, follow-ups, channel assets, a launch queue, qualification rules, and tracking fields. For a target larger than one response can contain, complete the largest credible first wave and define the continuation pattern. Keep strategy explanation short: lead with completed work and launch-ready assets. Do not invent people, product proof, performance numbers, or commercial terms.`,
  social: `Create a seven-day social content pack adapted for LinkedIn, Instagram, TikTok, and X. Deliver final copy, creative direction, short-video scripts, calls to action, and a launch queue. Keep explanation short and make every item ready to publish. Never claim customer results that are not in the product context.`,
  audience: `Research and define three concrete audience segments. For each, deliver their job, pain, triggering events, objections, where they gather, language to listen for, and ethical public signals for prospect discovery. Include verified example organizations when web evidence supports them; never fabricate named people or buying intent.`,
  chat: `Act as the product's senior marketing operator and complete the user's request. Do the research, prioritization, planning, drafting, list design, and measurement setup that can be completed now. Be specific, practical, and honest about missing evidence. Do not turn your work into a to-do list for the user.`,
};

const campaignIntensityInstructions = {
  careful: `CAREFUL MODE: Use smaller waves, more validation gates, softer calls to action, and longer learning cycles. Still complete the actual work now rather than delegating it to the user.`,
  assertive: `ASSERTIVE MODE: Be decisive and commercially ambitious. Use meaningful initial volume, direct positioning, clear calls to action, parallel channels, and fast follow-up while preserving sensible review points.`,
  aggressive: `AGGRESSIVE MODE: Optimize for speed, reach, and pipeline creation. Use large credible first waves, parallel channel execution, direct commercial language, strong calls to action, short follow-up intervals, rapid iteration, and ambitious targets. Do not dilute the campaign into a tiny calibration exercise or long preamble. Aggressive never means inventing claims, spamming, ignoring opt-outs, or bypassing platform and privacy rules.`,
};

const actionTitles = {
  research: "Market research",
  campaign: "30-day campaign",
  social: "Social content pack",
  audience: "Audience analysis",
  chat: "Custom agent run",
};

export async function runMarketingAgent(payload, env = process.env) {
  const { action = "chat", prompt = "", workspace = {}, useWeb = true, mode = "single" } = payload ?? {};
  const intensity = normalizeCampaignIntensity(payload?.intensity);
  requireProviderKeys(mode, env);

  const instruction = actionInstructions[action] ?? actionInstructions.chat;
  const context = buildContext(workspace);
  const deliveryNeeded = needsDeliveryAccess(action, prompt);
  const deliveryState = deliveryNeeded
    ? `CURRENT DELIVERY ACCESS\nNo email, messaging, or social publishing account is connected. You may research and prepare launch-ready work, but you cannot truthfully claim that anything was sent or published. Label the result "PREPARED — NOT LAUNCHED" and make the only user-facing next action "Connect a delivery channel."`
    : "";
  const task = `${context}\n\n${deliveryState}\n\nEXECUTION STYLE\n${campaignIntensityInstructions[intensity]}\n\nTASK\n${instruction}\n\nUSER DIRECTION\n${prompt || "Use your best judgment and produce the complete deliverable."}\n\nOUTPUT RULES\nLead with status and completed work. Use short sections, compact tables or bullets, and final assets. Avoid a long strategy essay, repeated caveats, generic advice, or a multi-step to-do list for the user. End with exactly one next action.`;

  if (mode === "panel") {
    const result = await runCollaborativePanel(task, useWeb, env);
    return { ...result, intensity };
  }

  if (env.OPENAI_API_KEY) {
    const model = env.OPENAI_MODEL || env.AI_MODEL || "gpt-6.1-terra";
    const response = await createOpenAIResponse({
      env,
      model,
      system: operatorSystem,
      prompt: task,
      useWeb,
      maxOutputTokens: 7000,
    });
    return { ...formatOpenAIResponse(response, model), intensity };
  }

  const response = await generateGoogleText({
    env,
    model: env.GOOGLE_MODEL || "gemini-3.8-flash",
    system: operatorSystem,
    prompt: task,
    maxOutputTokens: 7000,
  });
  return { id: crypto.randomUUID(), model: "Standard analysis", output: response.text, sources: [], createdAt: new Date().toISOString(), intensity };
}

export async function runProjectConversation(payload, env = process.env) {
  const workspace = payload?.workspace && typeof payload.workspace === "object" ? payload.workspace : {};
  const message = String(payload?.message || "").trim().slice(0, 12_000);
  if (!message) {
    const error = new Error("Write a message first.");
    error.statusCode = 400;
    throw error;
  }
  const history = Array.isArray(payload?.history)
    ? payload.history.slice(-24).map((item) => `${item?.role === "assistant" ? "AGENT" : "USER"}: ${String(item?.content || "").slice(0, 5000)}`).join("\n\n")
    : "No earlier conversation.";
  const prompt = `${buildContext(workspace)}

RECENT PROJECT CONVERSATION
${history || "No earlier conversation."}

NEW USER MESSAGE
${message}

Reply directly and naturally. Always acknowledge and comment on the user's actual input before moving forward. Remember corrections and decisions already present in the conversation, and do not ask for information the project or conversation already contains. If the user gives feedback or a preference, state briefly how it changes the work. Complete small marketing tasks in the reply when possible. Ask at most one short question, and only when a decision or private authorization truly requires the user. Never mention internal systems, model names, or providers.`;
  const conversationSystem = `${operatorSystem} You are also the project's persistent conversational partner. Keep replies compact, attentive, and grounded in the saved project and conversation.`;
  if (env.OPENAI_API_KEY) {
    const response = await createOpenAIResponse({
      env,
      model: env.OPENAI_MODEL || env.AI_MODEL || "gpt-6.1-terra",
      system: conversationSystem,
      prompt,
      useWeb: Boolean(payload?.useWeb),
      maxOutputTokens: 2200,
    });
    return { reply: responseText(response), sources: collectOpenAISources(response), createdAt: new Date().toISOString() };
  }
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const response = await generateGoogleText({ env, model: env.GOOGLE_MODEL || "gemini-3.8-flash", system: conversationSystem, prompt, maxOutputTokens: 2200 });
    return { reply: response.text, sources: [], createdAt: new Date().toISOString() };
  }
  if (env.ANTHROPIC_API_KEY) {
    const response = await generateAnthropicText({ env, model: env.ANTHROPIC_MODEL || "claude-sonnet-5-5", system: conversationSystem, prompt, maxOutputTokens: 2200 });
    return { reply: response.text, sources: [], createdAt: new Date().toISOString() };
  }
  if (env.STARTER_OPENAI_API_KEY) {
    const starterEnv = { ...env, OPENAI_API_KEY: env.STARTER_OPENAI_API_KEY };
    const response = await createOpenAIResponse({
      env: starterEnv,
      model: env.STARTER_OPENAI_MODEL || "gpt-6-luna",
      system: starterGuideSystem,
      prompt: `USER QUESTION\n${message}\n\nReply with concise setup help only.`,
      useWeb: false,
      maxOutputTokens: 900,
    });
    return { reply: responseText(response), sources: [], createdAt: new Date().toISOString(), starter: true };
  }
  return {
    reply: "To begin real work, connect either OpenAI or Gemini under Connections. OpenAI or Gemini unlocks reasoning and image creation; Claude adds an independent strategy review. Connecting all three gives the strongest balanced result.",
    sources: [],
    createdAt: new Date().toISOString(),
    starter: true,
  };
}

function normalizeCampaignIntensity(value) {
  return ["careful", "assertive", "aggressive"].includes(value) ? value : "assertive";
}

function needsDeliveryAccess(action, prompt) {
  return action === "campaign" || action === "social" || /\b(send|email|message|outreach|publish|post|campaign|buyer|prospect|lead|pipeline|launch|demo)\b/i.test(String(prompt || ""));
}

export async function buildProductBrain(payload, env = process.env) {
  if (!env.OPENAI_API_KEY && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const error = new Error("Connect your private analysis APIs under Connections first.");
    error.statusCode = 503;
    throw error;
  }

  const projectId = String(payload?.projectId || "project-default");
  const projectName = String(payload?.projectName || "New project").slice(0, 200);
  const existingWorkspace = productBrainContext(payload?.workspace);
  const links = Array.isArray(payload?.links)
    ? payload.links.map((value) => String(value || "").trim()).filter((value) => /^https?:\/\//i.test(value)).slice(0, 15)
    : [];
  const materials = Array.isArray(payload?.materials) ? payload.materials.slice(0, 20) : [];
  const connectedMaterial = await readConnectedMaterial(links);
  const materialText = materials
    .map((material) => {
      const name = String(material?.name || "Uploaded material").slice(0, 250);
      const text = String(material?.text || "").slice(0, 60_000);
      return text ? `\n--- ${name} ---\n${text}` : `\n--- ${name} ---\nVisual material supplied.`;
    })
    .join("\n")
    .concat(connectedMaterial.text ? `\n\n${connectedMaterial.text}` : "")
    .slice(0, 170_000);
  const images = materials
    .flatMap((material) => Array.isArray(material?.images) ? material.images : [])
    .filter(isSupportedAnalysisImage)
    .concat(connectedMaterial.images)
    .filter(isSupportedAnalysisImage)
    .slice(0, 18);

  if (!materialText.trim() && !images.length && !links.length) {
    const error = new Error("Add at least one file or source link first.");
    error.statusCode = 400;
    throw error;
  }

  const prompt = `Build a factual product brain for the project named "${projectName}" from the supplied materials and public source links.

EXISTING SAVED PRODUCT BRAIN
${existingWorkspace ? JSON.stringify(existingWorkspace.brain, null, 2) : "No existing product brain."}

CONFIRMED USER ANSWERS
${existingWorkspace?.confirmedAnswers.length ? existingWorkspace.confirmedAnswers.map((item, index) => `${index + 1}. ${item.question}\nANSWER: ${item.answer}`).join("\n\n") : "No confirmed answers supplied."}

QUESTIONS THE USER DISMISSED OR COULD NOT ANSWER
${existingWorkspace?.dismissedQuestions.length ? existingWorkspace.dismissedQuestions.map((question, index) => `${index + 1}. ${question}`).join("\n") : "None."}

PROTECTED USER CORRECTIONS
${existingWorkspace?.protectedFields.length ? existingWorkspace.protectedFields.join(", ") : "No individually protected fields."}

SOURCE PRECEDENCE
${sourcePriorityInstruction(existingWorkspace?.sourcePriority)}

USER'S SOURCE NOTES
${existingWorkspace?.sourceGuidance || "No additional source guidance supplied."}

SOURCE LINKS
${links.length ? links.map((link) => `- ${link}`).join("\n") : "No links supplied."}

EXTRACTED MATERIAL
${materialText || "Visual materials are attached."}

Preserve useful saved facts unless stronger source evidence corrects them. Confirmed user answers are authoritative: carry them into the updated product brain and never replace them with a weaker inference or ask for them again. Fields listed as protected user corrections must retain their exact saved meaning. If new source evidence materially conflicts with a protected field, keep the saved value and add one concise confirmation question describing the conflict; never silently overwrite it. Infer only what is strongly supported. Derive the visual identity from the supplied website, CSS, deck pages, images, and documents. Assign primaryColor, secondaryColor, and accentColor only to chromatic brand hues—never black, white, or gray. Store background/text neutrals separately as neutralLightColor and neutralDarkColor. Keep the palette coherent to one source system: never combine hues from visibly distinct website and deck identities into a hybrid palette. Follow the selected source precedence; when no authoritative secondary or accent hue exists, return an empty string rather than inventing one. Choose representative visible six-digit hex values, identify typography, recognize the logo, and summarize the imagery style. Consolidate duplicates and contradictions. Do not ask the user for colors, hex values, logo, typefaces, or visual style when those are visible or detected in a supplied source. Make the best evidence-based extraction and place any uncertainty in brand notes instead of unknowns. Put only genuinely unavailable business facts in unknowns. The result is a draft for the user to review, not a claim of certainty. Never mention internal systems, providers, or model names.`;

  try {
    const parsed = await generateProductBrainStructured({
      env,
      system: "You are a meticulous product-onboarding analyst. Extract a useful marketing source of truth from user materials. Preserve factual nuance, identify uncertainty, and never invent proof, customers, metrics, pricing, or capabilities.",
      prompt,
      images,
      useWeb: links.length > 0,
    });
    const normalized = normalizeBrainResult(parsed, projectName, links[0] || existingWorkspace?.brain.website || "");
    normalizeBrandPalette(normalized.brain.brand, connectedMaterial.colors);
    if (existingWorkspace?.protectedFields.length) applyProtectedBrainFields(normalized.brain, existingWorkspace.brain, existingWorkspace.protectedFields);
    if (existingWorkspace?.handledQuestions.length) {
      normalized.unknowns = removeRepeatedQuestions(normalized.unknowns, existingWorkspace.handledQuestions);
    }
    if (connectedMaterial.logoDataUrl) {
      normalized.brain.brand.logoDataUrl = connectedMaterial.logoDataUrl;
      normalized.brain.brand.logoName = connectedMaterial.logoName || "Logo extracted from website";
    }
    const sourceContainsVisualEvidence = images.length > 0 || connectedMaterial.brandEvidence;
    if (sourceContainsVisualEvidence) {
      normalized.unknowns = normalized.unknowns.filter((question) => !isSourceAnswerableBrandQuestion(question));
    }
    if (connectedMaterial.issues.length) {
      normalized.unknowns = normalized.unknowns.filter((question) => !/what (content|visual identity).*(deck|figma)|what.*(deck|figma).*(contain|show)|describe.*(deck|figma)/i.test(question));
    }
    return { projectId, ...normalized, sourceWarnings: connectedMaterial.issues, sourceMedia: connectedMaterial.sourceMedia };
  } catch {
    const error = new Error("The project materials were read, but the product brain could not be assembled. Please try again.");
    error.statusCode = 502;
    throw error;
  }
}

export async function refineProductBrain(payload, env = process.env) {
  if (!env.OPENAI_API_KEY && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const error = new Error("Connect your private analysis APIs under Connections first.");
    error.statusCode = 503;
    throw error;
  }

  const workspace = payload?.workspace && typeof payload.workspace === "object" ? payload.workspace : {};
  const answers = Array.isArray(payload?.answers)
    ? payload.answers
      .map((item) => ({ question: String(item?.question || "").trim(), answer: String(item?.answer || "").trim() }))
      .filter((item) => item.question && item.answer)
      .slice(0, 20)
    : [];
  const additionalContext = String(payload?.additionalContext || "").trim().slice(0, 20_000);
  if (!answers.length && !additionalContext) {
    const error = new Error("Answer at least one question or add some context first.");
    error.statusCode = 400;
    throw error;
  }

  const safeWorkspace = {
    name: workspace.name || "New project",
    website: workspace.website || "",
    description: workspace.description || "",
    audience: workspace.audience || "",
    valueProposition: workspace.valueProposition || "",
    voice: workspace.voice || "",
    guardrails: workspace.guardrails || "",
    notes: workspace.notes || "",
    brand: {
      primaryColor: workspace.brand?.primaryColor || "#7856ff",
      secondaryColor: workspace.brand?.secondaryColor || "#4d9a75",
      accentColor: workspace.brand?.accentColor || "#f2a65a",
      neutralLightColor: workspace.brand?.neutralLightColor || "#ffffff",
      neutralDarkColor: workspace.brand?.neutralDarkColor || "#222222",
      typography: workspace.brand?.typography || "",
      imageryStyle: workspace.brand?.imageryStyle || "",
      notes: workspace.brand?.notes || "",
    },
    sources: Array.isArray(workspace.sources) ? workspace.sources.map((source) => ({ label: source.label, url: source.url })).slice(0, 20) : [],
  };
  const answerText = answers.map((item, index) => `${index + 1}. ${item.question}\nANSWER: ${item.answer}`).join("\n\n");
  const prompt = `Update the existing product brain using the user's confirmed answers. Preserve useful existing facts unless an answer corrects them. Resolve answered questions, retain only material unanswered gaps, and never invent missing commercial claims or proof. Never ask an answered question again, including a reworded version. If the user does not know an answer, keep the uncertainty in the notes without repeating the question.

CURRENT PRODUCT BRAIN
${JSON.stringify(safeWorkspace, null, 2)}

USER ANSWERS
${answerText || "No individual answers supplied."}

ADDITIONAL CONTEXT
${additionalContext || "None supplied."}`;
  try {
    const parsed = await generateProductBrainStructured({
      env,
      system: "You maintain a factual product and brand source of truth. Apply user corrections precisely, preserve nuance, and return only structured data. Never mention internal systems or model names.",
      prompt,
    });
    const normalized = normalizeBrainResult(parsed, safeWorkspace.name, safeWorkspace.website);
    normalizeBrandPalette(normalized.brain.brand, []);
    normalized.unknowns = removeRepeatedQuestions(normalized.unknowns, answers.map((item) => item.question));
    if (safeWorkspace.sources.length) normalized.unknowns = normalized.unknowns.filter((question) => !isSourceAnswerableBrandQuestion(question));
    return normalized;
  } catch {
    const error = new Error("The answers were read, but the product brain could not be updated. Please try again.");
    error.statusCode = 502;
    throw error;
  }
}

export async function analyzeProjectAsset(payload, env = process.env) {
  if (!env.OPENAI_API_KEY && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const error = new Error("Connect OpenAI or Gemini before analyzing project assets.");
    error.statusCode = 503;
    throw error;
  }
  const name = String(payload?.name || "Untitled asset").slice(0, 250);
  const sourceUrl = String(payload?.sourceUrl || "").slice(0, 2000);
  const extractedText = String(payload?.text || "").slice(0, 60_000);
  const suppliedImages = Array.isArray(payload?.images) ? payload.images.filter((value) => typeof value === "string" && value.startsWith("data:image/")).slice(0, 8) : [];
  let connected = { text: "", images: [], issues: [] };
  if (/^https?:\/\//i.test(sourceUrl)) connected = await readConnectedMaterial([sourceUrl]);
  if (sourceUrl && !connected.text && !connected.images.length && connected.issues.length) {
    const error = new Error(connected.issues.join(" "));
    error.statusCode = 400;
    throw error;
  }
  const prompt = `Evaluate this existing marketing asset for the active project.

ASSET
Name: ${name}
Type: ${payload?.kind || "unknown"}
Format: ${payload?.mimeType || "unknown"}
Source: ${sourceUrl || "Uploaded file"}
Extraction detail: ${payload?.detail || "Not supplied"}

EXTRACTED CONTENT
${extractedText || connected.text || "No readable text. Evaluate the supplied visual frames and metadata."}

PROJECT CONTEXT
${buildContext(payload?.workspace || {})}

Tag the asset by purpose, channel, format, audience, funnel stage, tone, and subject. Decide whether it should be reused unchanged, adapted, replaced, or archived. Explain the decision in plain language. If adaptation is best, specify exact changes such as copy overlays, crops, sequencing, updated claims, or format changes. Propose a PDF or presentation deck only when that deliverable would materially improve the project; do not propose one automatically.`;
  const parsed = await generateStructuredObject({
    env,
    name: "asset_decision",
    system: "You are a senior creative-operations librarian. Make decisive, evidence-based reuse decisions. Never invent performance, rights, approvals, or product facts.",
    prompt,
    images: [...suppliedImages, ...connected.images].slice(0, 8),
    schema: assetDecisionSchema(),
  });
  return {
    summary: String(parsed.summary || "").slice(0, 1200),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((value) => String(value).trim()).filter(Boolean).slice(0, 18) : [],
    recommendation: ["reuse", "adapt", "replace", "archive"].includes(parsed.recommendation) ? parsed.recommendation : "review",
    rationale: String(parsed.rationale || "").slice(0, 2000),
    suggestedChanges: Array.isArray(parsed.suggestedChanges) ? parsed.suggestedChanges.map((value) => String(value).trim()).filter(Boolean).slice(0, 12) : [],
    proposedDeliverables: Array.isArray(parsed.proposedDeliverables) ? parsed.proposedDeliverables.slice(0, 2).map((item) => ({
      kind: item?.kind === "deck" ? "deck" : "pdf",
      title: String(item?.title || "Proposed document").slice(0, 200),
      description: String(item?.description || "").slice(0, 1200),
      rationale: String(item?.rationale || "").slice(0, 1200),
    })) : [],
  };
}

export async function generateProjectDocument(payload, env = process.env) {
  if (!env.OPENAI_API_KEY && !env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const error = new Error("Connect OpenAI or Gemini before creating this document.");
    error.statusCode = 503;
    throw error;
  }
  const kind = payload?.kind === "deck" ? "presentation deck" : "PDF document";
  const prompt = `Create the final content structure for an approved ${kind}.

APPROVED DELIVERABLE
Title: ${payload?.title || "Project document"}
Description: ${payload?.description || "Not supplied"}
Reason: ${payload?.rationale || "Not supplied"}

PROJECT CONTEXT
${buildContext(payload?.workspace || {})}

SELECTED ASSET EVIDENCE
${JSON.stringify(payload?.assets || [], null, 2)}

Return polished, presentation-ready content grounded only in the supplied project facts. For a deck, create 6–10 concise slide-like sections. For a PDF, create 4–8 readable sections. Include concrete final copy, not instructions to a designer. Never invent customers, results, pricing, or claims.`;
  return generateStructuredObject({
    env,
    name: "approved_project_document",
    system: "You create concise, client-ready marketing documents from approved source material. Return only the requested structured content.",
    prompt,
    schema: projectDocumentSchema(),
  });
}

function assetDecisionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "tags", "recommendation", "rationale", "suggestedChanges", "proposedDeliverables"],
    properties: {
      summary: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      recommendation: { type: "string", enum: ["reuse", "adapt", "replace", "archive"] },
      rationale: { type: "string" },
      suggestedChanges: { type: "array", items: { type: "string" } },
      proposedDeliverables: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "title", "description", "rationale"],
          properties: {
            kind: { type: "string", enum: ["pdf", "deck"] },
            title: { type: "string" },
            description: { type: "string" },
            rationale: { type: "string" },
          },
        },
      },
    },
  };
}

function projectDocumentSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "subtitle", "sections"],
    properties: {
      title: { type: "string" },
      subtitle: { type: "string" },
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["heading", "body", "bullets"],
          properties: {
            heading: { type: "string" },
            body: { type: "string" },
            bullets: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
}

function productBrainSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      website: { type: "string" },
      description: { type: "string" },
      audience: { type: "string" },
      valueProposition: { type: "string" },
      voice: { type: "string" },
      guardrails: { type: "string" },
      notes: { type: "string" },
      brand: {
        type: "object",
        additionalProperties: false,
        properties: {
          primaryColor: { type: "string" },
          secondaryColor: { type: "string" },
          accentColor: { type: "string" },
          neutralLightColor: { type: "string" },
          neutralDarkColor: { type: "string" },
          typography: { type: "string" },
          imageryStyle: { type: "string" },
          notes: { type: "string" },
        },
        required: ["primaryColor", "secondaryColor", "accentColor", "neutralLightColor", "neutralDarkColor", "typography", "imageryStyle", "notes"],
      },
      reviewSummary: { type: "string" },
      unknowns: { type: "array", items: { type: "string" } },
    },
    required: ["name", "website", "description", "audience", "valueProposition", "voice", "guardrails", "notes", "brand", "reviewSummary", "unknowns"],
  };
}

function normalizeBrainResult(parsed, fallbackName, fallbackWebsite) {
  const stringField = (value, fallback = "") => typeof value === "string" ? value.trim() : fallback;
  const colorField = (value, fallback) => /^#[0-9a-f]{6}$/i.test(stringField(value)) ? stringField(value) : fallback;
  const brand = parsed?.brand && typeof parsed.brand === "object" ? parsed.brand : {};
  return {
    brain: {
      name: stringField(parsed?.name, fallbackName) || fallbackName,
      website: stringField(parsed?.website, fallbackWebsite),
      description: stringField(parsed?.description),
      audience: stringField(parsed?.audience),
      valueProposition: stringField(parsed?.valueProposition),
      voice: stringField(parsed?.voice),
      guardrails: stringField(parsed?.guardrails),
      notes: stringField(parsed?.notes),
      brand: {
        primaryColor: colorField(brand.primaryColor, ""),
        secondaryColor: colorField(brand.secondaryColor, ""),
        accentColor: colorField(brand.accentColor, ""),
        neutralLightColor: colorField(brand.neutralLightColor, "#ffffff"),
        neutralDarkColor: colorField(brand.neutralDarkColor, "#222222"),
        typography: stringField(brand.typography),
        imageryStyle: stringField(brand.imageryStyle),
        notes: stringField(brand.notes),
      },
    },
    reviewSummary: stringField(parsed?.reviewSummary, "The product brain is ready for review."),
    unknowns: Array.isArray(parsed?.unknowns) ? removeRepeatedQuestions(parsed.unknowns.map((value) => String(value)).filter(Boolean), []).slice(0, 12) : [],
  };
}

function productBrainContext(value) {
  if (!value || typeof value !== "object") return null;
  const clean = (field, maximum = 6000) => typeof field === "string" ? field.trim().slice(0, maximum) : "";
  const handledAnswers = value.questionAnswers && typeof value.questionAnswers === "object"
    ? Object.entries(value.questionAnswers)
      .map(([question, answer]) => ({ question: clean(question, 1200), answer: clean(answer, 6000) }))
      .filter((item) => item.question && item.answer)
      .slice(0, 30)
    : [];
  const answers = handledAnswers.filter((item) => item.answer !== "__MARKET_AGENT_SKIPPED__");
  const dismissedQuestions = handledAnswers
    .filter((item) => item.answer === "__MARKET_AGENT_SKIPPED__")
    .map((item) => item.question);
  return {
    brain: {
      name: clean(value.name, 200),
      website: clean(value.website, 1000),
      description: clean(value.description),
      audience: clean(value.audience),
      valueProposition: clean(value.valueProposition),
      voice: clean(value.voice),
      guardrails: clean(value.guardrails),
      notes: clean(value.notes),
      brand: {
        primaryColor: clean(value.brand?.primaryColor, 20),
        secondaryColor: clean(value.brand?.secondaryColor, 20),
        accentColor: clean(value.brand?.accentColor, 20),
        neutralLightColor: clean(value.brand?.neutralLightColor, 20),
        neutralDarkColor: clean(value.brand?.neutralDarkColor, 20),
        typography: clean(value.brand?.typography),
        imageryStyle: clean(value.brand?.imageryStyle),
        notes: clean(value.brand?.notes),
      },
    },
    confirmedAnswers: answers,
    dismissedQuestions,
    handledQuestions: handledAnswers.map((item) => item.question),
    protectedFields: Array.isArray(value.protectedFields) ? value.protectedFields.map((field) => clean(field, 100)).filter(Boolean).slice(0, 30) : [],
    sourcePriority: ["best-evidence", "website", "deck"].includes(value.sourcePriority) ? value.sourcePriority : "best-evidence",
    sourceGuidance: clean(value.sourceGuidance, 6000),
  };
}

function sourcePriorityInstruction(value) {
  if (value === "website") return "When sources conflict, prefer the public website for brand, style, product facts, and current messaging. Use decks as supporting context and note material contradictions.";
  if (value === "deck") return "When sources conflict, prefer decks, documents, and uploaded materials as the intended brand and product direction. Use the website as supporting public context and note material contradictions.";
  return "Compare all sources and use the strongest, most explicit, and most recent evidence. For the public brand identity, prefer the current official website unless a deck is explicitly identified as the newer intended direction. Never merge visibly separate visual systems into one palette; record meaningful contradictions in notes instead of asking the user to restate extractable information.";
}

function applyProtectedBrainFields(next, saved, protectedFields) {
  const allowed = new Set(["name", "website", "description", "audience", "valueProposition", "voice", "guardrails", "notes", "brand.primaryColor", "brand.secondaryColor", "brand.accentColor", "brand.neutralLightColor", "brand.neutralDarkColor", "brand.typography", "brand.imageryStyle", "brand.notes"]);
  for (const path of protectedFields) {
    if (!allowed.has(path)) continue;
    if (path.startsWith("brand.")) {
      const key = path.slice(6);
      if (typeof saved?.brand?.[key] === "string") next.brand[key] = saved.brand[key];
    } else if (typeof saved?.[path] === "string") {
      next[path] = saved[path];
    }
  }
}

const questionStopWords = new Set(["about", "again", "also", "and", "are", "can", "confirm", "could", "does", "for", "from", "have", "how", "into", "is", "its", "now", "please", "should", "that", "the", "their", "them", "there", "these", "this", "today", "what", "when", "where", "which", "who", "why", "with", "would", "you", "your"]);

function questionWords(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !questionStopWords.has(word))
    .map((word) => word.length > 5 ? word.replace(/(ing|ed|es|s)$/, "") : word);
}

const questionTopicPatterns = {
  pricing: /\b(price|prices|pricing|rate|rates|cost|costs|fee|fees|budget|minimum engagement|estimate|estimates)\b/i,
  availability: /\b(available|availability|live|planned|prototype|roadmap|launch|released|commercially)\b/i,
  capabilities: /\b(output|outputs|produce|produces|capability|capabilities|feature|features|deliverable|deliverables)\b/i,
  deployment: /\b(deploy|deployment|hosting|hosted|on premise|on-premise|cloud|installation)\b/i,
  privacy: /\b(consent|retention|deletion|delete|privacy|personal data|guest photo|guest photos|data handling)\b/i,
  proof: /\b(customer|customers|client|clients|pilot|pilots|result|results|case stud|testimonial|metric|metrics)\b/i,
  identity: /\b(brand|branding|logo|logos|colour|colours|color|colors|palette|typeface|typefaces|font|fonts|visual identity|imagery)\b/i,
  audience: /\b(audience|audiences|buyer|buyers|customer segment|customer segments|target market|target markets)\b/i,
  geography: /\b(geography|region|regions|country|countries|market|markets|location|locations|territory|territories)\b/i,
  purchase: /\b(buy|purchase|commission|engage|engagement|contact|booking|book|sales process|procurement)\b/i,
};

function questionTopics(value) {
  return Object.entries(questionTopicPatterns)
    .filter(([, pattern]) => pattern.test(String(value || "")))
    .map(([topic]) => topic);
}

function sameQuestion(left, right) {
  const leftNormalized = String(left || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const rightNormalized = String(right || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized || leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return true;
  const leftTopics = questionTopics(left);
  const rightTopics = questionTopics(right);
  if (leftTopics.some((topic) => rightTopics.includes(topic))) return true;
  const leftWords = new Set(questionWords(left));
  const rightWords = new Set(questionWords(right));
  const shared = [...leftWords].filter((word) => rightWords.has(word)).length;
  const smaller = Math.min(leftWords.size, rightWords.size);
  return shared >= 3 && smaller > 0 && shared / smaller >= 0.65;
}

function removeRepeatedQuestions(questions, alreadyHandled) {
  const unique = [];
  for (const value of questions) {
    const question = String(value || "").trim();
    if (!question || alreadyHandled.some((handled) => sameQuestion(handled, question)) || unique.some((existing) => sameQuestion(existing, question))) continue;
    unique.push(question);
  }
  return unique;
}

function isSourceAnswerableBrandQuestion(value) {
  const question = String(value || "").toLowerCase();
  return /\b(primary|secondary|accent|brand|approved)\b.*\b(colou?r|hex|palette)\b/.test(question)
    || /\b(colou?r|hex|palette)\b.*\b(primary|secondary|accent|brand|approved)\b/.test(question)
    || /\b(logos?|typefaces?|typography|fonts?|visual[\s-]+identity|imagery[\s-]+styles?|photography[\s-]+styles?|brand[\s-]+guidelines?)\b/.test(question);
}

export async function readConnectedMaterial(links) {
  const textParts = [];
  const images = [];
  const issues = [];
  const sourceMedia = [];
  const detectedColors = [];
  const detectedFonts = [];
  let logoDataUrl = "";
  let logoName = "";
  let brandEvidence = false;
  for (const link of links) {
    try {
      const url = new URL(link);
      let handled = false;
      if (url.hostname === "docs.google.com" && url.pathname.includes("/presentation/d/")) {
        handled = true;
        const id = url.pathname.match(/\/presentation\/d\/([a-zA-Z0-9_-]+)/)?.[1];
        if (!id) {
          issues.push("A Google Slides link could not be recognized. Check that it is a complete presentation link.");
          continue;
        }
        const response = await fetch(`https://docs.google.com/presentation/d/${id}/export/pptx`, { redirect: "follow" });
        if (!response.ok) {
          issues.push("Google Slides cannot read this presentation yet. In Google Slides, select Share → under General access choose “Anyone with the link” and “Viewer,” then return here and select Update from sources.");
          continue;
        }
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength > 30 * 1024 * 1024) {
          issues.push("A Google Slides deck is too large to import from its link. Upload a PDF/PPTX export instead.");
          continue;
        }
        const { default: JSZip } = await import("jszip");
        const zip = await JSZip.loadAsync(bytes);
        const slides = Object.keys(zip.files)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((left, right) => Number(left.match(/(\d+)\.xml$/)?.[1] || 0) - Number(right.match(/(\d+)\.xml$/)?.[1] || 0));
        const slideText = [];
        for (const [index, name] of slides.entries()) {
          const xml = await zip.file(name)?.async("text");
          if (!xml) continue;
          const text = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g))
            .map((match) => decodeXml(match[1]))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (text) slideText.push(`Slide ${index + 1}: ${text}`);
        }
        if (slideText.length) textParts.push(`CONNECTED GOOGLE SLIDES\n${slideText.join("\n")}`);
        const mediaNames = Object.keys(zip.files).filter((name) => /^ppt\/media\//.test(name) && !zip.files[name].dir).slice(0, 8);
        for (const name of mediaNames) {
          const mimeType = mimeTypeFromFilename(name);
          if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml" || images.length >= 8) continue;
          const bytes = await zip.file(name)?.async("uint8array");
          if (!bytes || bytes.byteLength > 3 * 1024 * 1024) continue;
          images.push(`data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`);
          brandEvidence = true;
        }
      }

      if (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com")) {
        handled = true;
        try {
          const connected = await readPublicFigmaDeck(link);
          if (connected.text) textParts.push(connected.text);
          if (connected.image && images.length < 8) images.push(connected.image);
          if (connected.text || connected.image) brandEvidence = true;
          if (connected.issue) issues.push(connected.issue);
        } catch {
          issues.push("Figma could not read this deck. Confirm that Share → link access is set to “Anyone” with “Can view,” then return here and select Update from sources.");
        }
      }

      if (!handled) {
        const website = await readPublicWebsite(url);
        if (website.text) textParts.push(website.text);
        for (const image of website.images || []) if (images.length < 8) images.push(image);
        detectedColors.push(...(website.colors || []));
        detectedFonts.push(...(website.fonts || []));
        if (!logoDataUrl && website.logoDataUrl) {
          logoDataUrl = website.logoDataUrl;
          logoName = website.logoName || "Website logo";
        }
        sourceMedia.push(...(website.sourceMedia || []));
        brandEvidence ||= Boolean(website.brandEvidence);
        if (website.issue) issues.push(website.issue);
      }
    } catch {
      // A connector can fail independently; the remaining uploaded material is still analyzed.
    }
  }
  return {
    text: textParts.join("\n\n").slice(0, 100_000),
    images,
    issues: Array.from(new Set(issues)),
    colors: Array.from(new Set(detectedColors)),
    fonts: Array.from(new Set(detectedFonts)),
    logoDataUrl,
    logoName,
    brandEvidence,
    sourceMedia: sourceMedia
      .filter((item, index, all) => item?.url && all.findIndex((candidate) => candidate.url === item.url) === index)
      .slice(0, 40),
  };
}

async function readPublicWebsite(url) {
  try {
    const response = await safeFetchPublic(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MarketAgent/1.0; +https://market-agent-lime-gamma.vercel.app)",
        Accept: "text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.5",
      },
      signal: AbortSignal.timeout(25_000),
    });
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!response.ok) return { issue: `The website at ${url.hostname} returned ${response.status}. Confirm that it is publicly accessible.` };
    if (contentType.startsWith("image/")) {
      const bytes = await limitedResponseBytes(response, 3 * 1024 * 1024);
      if (!bytes) return { issue: `The linked image at ${url.hostname} is too large to analyze.` };
      const dataUrl = `data:${contentType.split(";")[0]};base64,${Buffer.from(bytes).toString("base64")}`;
      return {
        text: `CONNECTED BRAND IMAGE\nSource: ${url}`,
        images: isSupportedAnalysisImage(dataUrl) ? [dataUrl] : [],
        colors: [],
        fonts: [],
        logoDataUrl: dataUrl,
        logoName: filenameFromUrl(url, "Brand image"),
        brandEvidence: true,
        sourceMedia: [{ kind: "image", name: filenameFromUrl(url, "Brand image"), url: url.toString(), role: "Brand image", tags: ["brand", "image"], recommendation: "reuse" }],
      };
    }
    if (contentType.startsWith("video/")) {
      return {
        text: `CONNECTED VIDEO SOURCE\nSource: ${url}`,
        images: [],
        colors: [],
        fonts: [],
        brandEvidence: false,
        sourceMedia: [{ kind: "video", name: filenameFromUrl(url, "Website video"), url: url.toString(), role: "Website video", tags: ["video", "source"], recommendation: "review" }],
      };
    }
    if (!contentType.includes("html") && !contentType.includes("xhtml") && contentType) {
      return { issue: `The source at ${url.hostname} is not a readable website. Upload the file directly so the agent can inspect it.` };
    }

    const htmlBytes = await limitedResponseBytes(response, 3 * 1024 * 1024);
    if (!htmlBytes) return { issue: `The website at ${url.hostname} is too large to analyze safely.` };
    const html = new TextDecoder().decode(htmlBytes);
    const cssTexts = Array.from(html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)).map((match) => match[1]).slice(0, 20);
    const stylesheetUrls = Array.from(html.matchAll(/<link\b[^>]*>/gi))
      .map((match) => match[0])
      .filter((tag) => /\brel\s*=\s*["'][^"']*stylesheet/i.test(tag))
      .map((tag) => readTagAttribute(tag, "href"))
      .filter(Boolean)
      .slice(0, 5);
    for (const href of stylesheetUrls) {
      try {
        const stylesheetUrl = new URL(href, url);
        const stylesheet = await safeFetchPublic(stylesheetUrl, { headers: { Accept: "text/css,*/*;q=0.5" }, signal: AbortSignal.timeout(12_000) });
        if (!stylesheet.ok) continue;
        const cssBytes = await limitedResponseBytes(stylesheet, 1_500_000);
        if (cssBytes) cssTexts.push(new TextDecoder().decode(cssBytes));
      } catch {
        // A blocked stylesheet does not prevent analysis of the rest of the page.
      }
    }

    const combinedVisualSource = `${html.slice(0, 1_500_000)}\n${cssTexts.join("\n").slice(0, 1_500_000)}`;
    const colors = extractWebsiteColors(combinedVisualSource, readMeta(html, "theme-color"));
    const fonts = extractWebsiteFonts(combinedVisualSource);
    const title = readMeta(html, "og:title") || readHtmlTitle(html) || url.hostname;
    const description = readMeta(html, "description") || readMeta(html, "og:description");
    const pageText = htmlToReadableText(html).slice(0, 55_000);
    const logoCandidates = websiteImageCandidates(html, url, cssTexts.join("\n"));
    const sourceMedia = [];
    let logoDataUrl = "";
    let logoName = "";
    for (const candidate of logoCandidates.filter((candidate) => candidate.logoScore >= 6).slice(0, 6)) {
      const image = await readWebsiteImage(candidate.url);
      if (!image || image.dataUrl.length > 1_200_000) continue;
      logoDataUrl = image.dataUrl;
      logoName = candidate.name || filenameFromUrl(candidate.url, "Website logo");
      if (/^https?:\/\//i.test(candidate.url)) sourceMedia.push({ kind: "image", name: logoName, url: candidate.url, role: "Logo or brand mark", tags: ["logo", "brand"], recommendation: "reuse" });
      break;
    }
    const images = [];
    if (isSupportedAnalysisImage(logoDataUrl)) images.push(logoDataUrl);
    for (const candidate of logoCandidates.slice(0, 8)) {
      if (images.length >= 4 || candidate.logoScore !== 0) continue;
      const image = await readWebsiteImage(candidate.url);
      if (image && isSupportedAnalysisImage(image.dataUrl) && !images.includes(image.dataUrl)) {
        images.push(image.dataUrl);
        if (image.byteLength >= 8_000 && /^https?:\/\//i.test(candidate.url)) sourceMedia.push({ kind: "image", name: candidate.name || filenameFromUrl(candidate.url, "Website image"), url: candidate.url, role: candidate.role || "Website image", tags: mediaTags(candidate.name, candidate.role), recommendation: candidate.role === "Social preview" ? "adapt" : "review" });
      }
    }
    sourceMedia.push(...websiteVideoCandidates(html, url));
    const signalText = [
      `CONNECTED PUBLIC WEBSITE`,
      `URL: ${url}`,
      `Page title: ${title}`,
      description ? `Meta description: ${description}` : "",
      colors.length ? `Detected CSS and theme colors, ranked by frequency: ${colors.join(", ")}` : "No reliable CSS colors detected.",
      fonts.length ? `Detected font families: ${fonts.join(", ")}` : "No explicit font families detected.",
      logoDataUrl ? `Logo: extracted automatically as ${logoName}` : "Logo: no reliable logo image was exposed in the page markup.",
      sourceMedia.length ? `Reusable media discovered: ${sourceMedia.map((item) => `${item.kind}: ${item.name} (${item.role})`).join("; ")}` : "No clearly reusable image or video assets were exposed in the page markup.",
      `VISIBLE PAGE COPY\n${pageText || "No readable page copy exposed."}`,
    ].filter(Boolean).join("\n");
    return {
      text: signalText,
      images,
      colors,
      fonts,
      logoDataUrl,
      logoName,
      brandEvidence: Boolean(colors.length || fonts.length || logoDataUrl || images.length),
      sourceMedia,
    };
  } catch {
    return { issue: `The website at ${url.hostname} could not be read. Confirm that it is public and does not block automated viewing.` };
  }
}

function websiteImageCandidates(html, baseUrl, css = "") {
  const candidates = [];
  const add = (source, name, logoScore = 0, role = "Website image") => {
    if (!source) return;
    try {
      const url = source.startsWith("data:image/") ? source : new URL(source, baseUrl).toString();
      if (!candidates.some((candidate) => candidate.url === url)) candidates.push({ url, name, logoScore, role });
    } catch {
      // Ignore invalid asset references.
    }
  };
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const source = readTagAttribute(tag, "src") || readTagAttribute(tag, "data-src") || readTagAttribute(tag, "data-lazy-src");
    const label = [readTagAttribute(tag, "alt"), readTagAttribute(tag, "aria-label"), readTagAttribute(tag, "class"), readTagAttribute(tag, "id"), source].filter(Boolean).join(" ");
    let score = /\b(logo|brand|wordmark|logotype)\b/i.test(label) ? 10 : 0;
    if (/\b(header|nav|masthead)\b/i.test(label)) score += 2;
    add(source, readTagAttribute(tag, "alt") || "Website image", score, score > 0 ? "Logo or brand mark" : "Website image");
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = readTagAttribute(tag, "rel");
    if (/\bmask-icon\b/i.test(rel)) add(readTagAttribute(tag, "href"), "Website brand mark", 6, "Logo or brand mark");
    else if (/\bapple-touch-icon\b/i.test(rel)) add(readTagAttribute(tag, "href"), "Website brand mark", 6, "Logo or brand mark");
    else if (/\bicon\b/i.test(rel)) add(readTagAttribute(tag, "href"), "Website icon", -1, "Website icon");
  }
  add(readMeta(html, "og:image"), readMeta(html, "og:image:alt") || "Website preview image", 0, "Social preview");
  add(readMeta(html, "twitter:image"), readMeta(html, "twitter:image:alt") || "Website preview image", 0, "Social preview");
  for (const match of String(css || "").matchAll(/background(?:-image)?\s*:[^;}]*url\(\s*(["']?)([^"')]+)\1\s*\)/gi)) add(match[2], filenameFromUrl(match[2], "Website background"), 0, "Website background");
  return candidates.sort((left, right) => right.logoScore - left.logoScore);
}

function websiteVideoCandidates(html, baseUrl) {
  const candidates = [];
  const add = (source, name, role = "Website video") => {
    if (!source) return;
    try {
      const url = new URL(source, baseUrl).toString();
      if (!/^https?:\/\//i.test(url) || candidates.some((item) => item.url === url)) return;
      candidates.push({ kind: "video", name: name || filenameFromUrl(url, "Website video"), url, role, tags: mediaTags(name, `${role} video`), recommendation: "review" });
    } catch {
      // Ignore invalid media references.
    }
  };
  for (const match of String(html || "").matchAll(/<(video|source)\b[^>]*>/gi)) {
    const tag = match[0];
    add(readTagAttribute(tag, "src"), readTagAttribute(tag, "title") || readTagAttribute(tag, "aria-label") || "Website video");
  }
  for (const match of String(html || "").matchAll(/<iframe\b[^>]*>/gi)) {
    const tag = match[0];
    const source = readTagAttribute(tag, "src");
    if (/\b(youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com|wistia\.)/i.test(source)) add(source, readTagAttribute(tag, "title") || "Embedded video", "Embedded video");
  }
  add(readMeta(html, "og:video") || readMeta(html, "og:video:url"), readMeta(html, "og:title") || "Website video", "Social video");
  add(readMeta(html, "twitter:player"), readMeta(html, "twitter:title") || "Website video", "Social video");
  return candidates.slice(0, 8);
}

function mediaTags(...values) {
  const text = values.filter(Boolean).join(" ").toLowerCase();
  const tags = [];
  for (const [pattern, tag] of [[/logo|brand|wordmark/, "brand"], [/product|demo|interface|app/, "product"], [/team|people|portrait/, "people"], [/event|stage|talk/, "event"], [/case|work|project/, "portfolio"], [/video|film|reel/, "video"], [/social|preview|share/, "social"]]) if (pattern.test(text)) tags.push(tag);
  if (!tags.length) tags.push("website");
  return tags.slice(0, 5);
}

function extractWebsiteColors(source, themeColor) {
  const counts = new Map();
  const add = (value, weight = 1) => {
    const normalized = normalizeCssColor(value);
    if (!normalized) return;
    counts.set(normalized, (counts.get(normalized) || 0) + weight);
  };
  if (themeColor) add(themeColor, 20);
  for (const match of String(source || "").matchAll(/--[a-z0-9_-]*(?:brand|primary|secondary|accent|highlight|foreground|background)[a-z0-9_-]*\s*:\s*(#[0-9a-f]{3,8})\b/gi)) add(match[1], 15);
  for (const match of String(source || "").matchAll(/#[0-9a-f]{3,8}\b/gi)) add(match[0]);
  for (const match of String(source || "").matchAll(/rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})/gi)) {
    add(`#${[match[1], match[2], match[3]].map((value) => Math.max(0, Math.min(255, Number(value))).toString(16).padStart(2, "0")).join("")}`);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([value]) => value)
    .slice(0, 12);
}

function normalizeCssColor(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (/^#[0-9A-F]{3}$/.test(raw)) return `#${raw.slice(1).split("").map((character) => character + character).join("")}`;
  if (/^#[0-9A-F]{6}$/.test(raw)) return raw;
  if (/^#[0-9A-F]{8}$/.test(raw) && raw.slice(7) !== "00") return raw.slice(0, 7);
  return "";
}

function normalizeBrandPalette(brand, detectedColors = []) {
  const chromatic = Array.from(new Set(detectedColors.map(normalizeCssColor).filter((color) => isChromaticColor(color))));
  const used = [];
  for (const key of ["primaryColor", "secondaryColor", "accentColor"]) {
    const current = normalizeCssColor(brand[key]);
    if (isChromaticColor(current) && !used.includes(current)) {
      brand[key] = current;
      used.push(current);
      continue;
    }
    const replacement = key === "primaryColor"
      ? chromatic.find((candidate) => !used.includes(candidate) && used.every((selected) => colorDistance(candidate, selected) >= 42)) || chromatic.find((candidate) => !used.includes(candidate)) || ""
      : "";
    brand[key] = replacement;
    if (replacement) used.push(replacement);
  }
  const neutrals = Array.from(new Set(detectedColors.map(normalizeCssColor).filter((color) => color && !isChromaticColor(color))));
  const light = neutrals.map((color) => [color, colorLightness(color)]).filter(([, value]) => value >= 0.7).sort((left, right) => right[1] - left[1])[0]?.[0];
  const dark = neutrals.map((color) => [color, colorLightness(color)]).filter(([, value]) => value <= 0.35).sort((left, right) => left[1] - right[1])[0]?.[0];
  brand.neutralLightColor = light || (!isChromaticColor(brand.neutralLightColor) ? normalizeCssColor(brand.neutralLightColor) : "") || "#FFFFFF";
  brand.neutralDarkColor = dark || (!isChromaticColor(brand.neutralDarkColor) ? normalizeCssColor(brand.neutralDarkColor) : "") || "#222222";
}

function isChromaticColor(value) {
  const rgb = hexRgb(value);
  if (!rgb) return false;
  const maximum = Math.max(...rgb);
  const minimum = Math.min(...rgb);
  const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
  const lightness = (maximum + minimum) / 510;
  return saturation >= 0.16 && maximum - minimum >= 20 && lightness > 0.06 && lightness < 0.94;
}

function colorLightness(value) {
  const rgb = hexRgb(value);
  return rgb ? (Math.max(...rgb) + Math.min(...rgb)) / 510 : 0.5;
}

function colorDistance(left, right) {
  const a = hexRgb(left);
  const b = hexRgb(right);
  return a && b ? Math.sqrt(a.reduce((sum, channel, index) => sum + (channel - b[index]) ** 2, 0)) : 0;
}

function hexRgb(value) {
  const normalized = normalizeCssColor(value);
  return normalized ? [1, 3, 5].map((index) => Number.parseInt(normalized.slice(index, index + 2), 16)) : null;
}

function extractWebsiteFonts(source) {
  const counts = new Map();
  for (const match of String(source || "").matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    const family = String(match[1] || "").split(",")[0].replace(/["']/g, "").trim();
    if (!family || /^(inherit|initial|unset|var\(|sans-serif|serif|monospace|system-ui)/i.test(family)) continue;
    incrementCount(counts, family);
  }
  for (const match of String(source || "").matchAll(/fonts\.googleapis\.com\/css2?\?[^"')\s]*family=([^&"')\s]+)/gi)) {
    const family = decodeURIComponent(match[1]).replace(/\+/g, " ").split(":")[0].trim();
    if (family) incrementCount(counts, family);
  }
  return topCounts(counts, 8);
}

function htmlToReadableText(html) {
  return decodeXml(String(html || "")
    .replace(/<(script|style|svg|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function readTagAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = String(tag || "").match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  if (quoted) return decodeXml(quoted[2]).trim();
  return decodeXml(String(tag || "").match(new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, "i"))?.[1] || "").trim();
}

async function readWebsiteImage(url) {
  if (typeof url !== "string") return null;
  if (url.startsWith("data:image/")) return url.length <= 3_000_000 ? { dataUrl: url, byteLength: Math.floor(url.length * 0.75) } : null;
  try {
    const response = await safeFetchPublic(new URL(url), { headers: { Accept: "image/*" }, signal: AbortSignal.timeout(12_000) });
    const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
    if (!response.ok || !contentType.startsWith("image/")) return null;
    const bytes = await limitedResponseBytes(response, 3 * 1024 * 1024);
    if (!bytes) return null;
    return { dataUrl: `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`, byteLength: bytes.byteLength };
  } catch {
    return null;
  }
}

async function safeFetchPublic(input, init = {}) {
  let current = input instanceof URL ? new URL(input.toString()) : new URL(input);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    await assertPublicUrl(current);
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    current = new URL(location, current);
  }
  throw new Error("Too many redirects");
}

async function assertPublicUrl(url) {
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("Unsupported public URL");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) throw new Error("Private URL blocked");
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw new Error("Private URL blocked");
}

function isPrivateAddress(value) {
  const address = String(value || "").toLowerCase().split("%")[0];
  if (address === "::1" || address === "::" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe8") || address.startsWith("fe9") || address.startsWith("fea") || address.startsWith("feb")) return true;
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = mapped || (isIP(address) === 4 ? address : "");
  if (!ipv4) return false;
  const [a, b] = ipv4.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

async function limitedResponseBytes(response, maximum) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maximum) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength <= maximum ? bytes : null;
}

function filenameFromUrl(url, fallback) {
  try { return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || fallback).slice(0, 200); } catch { return fallback; }
}

function mimeTypeFromFilename(name) {
  const extension = String(name || "").split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" })[extension] || "application/octet-stream";
}

function isSupportedAnalysisImage(value) {
  return /^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(String(value || ""));
}

async function readPublicFigmaDeck(link) {
  const response = await fetch(link, {
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const html = (await response.text()).slice(0, 2_500_000);
  const initialData = readFigmaInitialData(html);
  const permissionRequest = initialData?.INITIAL_OPTIONS?.request_view_permissions;
  const fileName = permissionRequest?.file_name
    || initialData?.INITIAL_OPTIONS?.editing_file?.name
    || readMeta(html, "og:title")
    || readHtmlTitle(html)
    || "this Figma deck";
  const checkpointUrl = initialData?.EARLY_ARGS?.checkpoint_url;

  if (permissionRequest || !checkpointUrl) {
    return {
      issue: `Figma cannot read “${fileName}” yet. In Figma, open the deck → Share → set link access to “Anyone” with “Can view,” then return here and select Update from sources.`,
    };
  }
  if (!/^https:\/\/www\.figma\.com\/blobs\//i.test(checkpointUrl)) {
    return { issue: `Figma returned an unreadable link for “${fileName}.” Copy a fresh share link and try again.` };
  }

  const checkpointResponse = await fetch(checkpointUrl, { redirect: "follow", signal: AbortSignal.timeout(25_000) });
  if (!checkpointResponse.ok) {
    return { issue: `Figma could not finish reading “${fileName}.” Confirm that link access is “Anyone” with “Can view,” then try again.` };
  }
  const checkpointBytes = new Uint8Array(await checkpointResponse.arrayBuffer());
  if (checkpointBytes.byteLength > 30 * 1024 * 1024) {
    return { issue: `“${fileName}” is too large to read from its Figma link. Split the deck or upload a PDF export.` };
  }

  const deck = parseFigmaDeck(checkpointBytes, fileName);
  const previewUrl = initialData?.INITIAL_OPTIONS?.editing_file?.thumbnail_url || readMeta(html, "og:image");
  const image = await readRemoteImage(previewUrl);
  return { text: deck, image };
}

function readFigmaInitialData(html) {
  const match = html.match(/<script[^>]*data-initial[^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function parseFigmaDeck(bytes, fileName) {
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== "fig-kiwi") throw new Error("Unsupported Figma checkpoint");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = [];
  let offset = 12;
  while (offset + 4 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (length <= 0 || offset + length > bytes.byteLength) throw new Error("Invalid Figma checkpoint");
    chunks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (chunks.length < 2) throw new Error("Incomplete Figma checkpoint");
  const schema = decodeBinarySchema(decompressFigmaChunk(chunks[0]));
  const message = compileSchema(schema).decodeMessage(decompressFigmaChunk(chunks[1]));
  const nodes = (Array.isArray(message?.nodeChanges) ? message.nodeChanges : [])
    .filter((node) => node && node.phase !== "REMOVED" && node.visible !== false);
  const nodeMap = new Map(nodes.map((node) => [figmaNodeId(node), node]).filter(([id]) => id));
  const slideNodes = nodes
    .filter((node) => node.type === "SLIDE")
    .sort((left, right) => figmaSlideOrder(left) - figmaSlideOrder(right));
  const slideIndexById = new Map(slideNodes.map((node, index) => [figmaNodeId(node), index]));
  const textBySlide = slideNodes.map(() => []);
  const fontCounts = new Map();
  const colorCounts = new Map();
  let imageCount = 0;

  for (const node of nodes) {
    const slideIndex = findFigmaSlideIndex(node, nodeMap, slideIndexById);
    if (slideIndex === -1) continue;
    if (node.type === "TEXT") {
      const text = String(node.textData?.characters || node.characters || "").replace(/\s+/g, " ").trim();
      if (text && !textBySlide[slideIndex].includes(text)) textBySlide[slideIndex].push(text);
      const family = String(node.fontName?.family || "").trim();
      const style = String(node.fontName?.style || "").trim();
      if (family) incrementCount(fontCounts, style ? `${family} (${style})` : family);
    }
    for (const paint of Array.isArray(node.fillPaints) ? node.fillPaints : []) {
      if (paint?.visible === false || Number(paint?.opacity ?? 1) <= 0.05) continue;
      if (paint?.type === "SOLID" && paint.color) incrementCount(colorCounts, figmaColorToHex(paint.color));
      if (paint?.type === "IMAGE" || paint?.imageHash || paint?.imageRef) imageCount += 1;
    }
  }

  const slideText = textBySlide
    .map((parts, index) => `Slide ${index + 1}: ${parts.length ? parts.join(" | ") : "No readable text; visual slide."}`)
    .join("\n");
  const fonts = topCounts(fontCounts, 8).join(", ") || "No font names exposed";
  const colors = topCounts(colorCounts, 12).join(", ") || "No solid colors exposed";
  return `CONNECTED FIGMA SLIDES\nDeck: ${fileName}\nAccess: Full deck read through external-view link\nSlides: ${slideNodes.length}\nFonts used: ${fonts}\nMost-used colors: ${colors}\nImage fills: ${imageCount}\n${slideText}`;
}

function decompressFigmaChunk(chunk) {
  const isZstd = chunk[0] === 0x28 && chunk[1] === 0xb5 && chunk[2] === 0x2f && chunk[3] === 0xfd;
  return isZstd ? decompressZstd(chunk) : inflateSync(chunk);
}

function figmaNodeId(node) {
  return node?.guid ? `${node.guid.sessionID}:${node.guid.localID}` : "";
}

function figmaSlideOrder(node) {
  const numericName = Number.parseFloat(String(node?.name || ""));
  return Number.isFinite(numericName) ? numericName : Number.MAX_SAFE_INTEGER;
}

function findFigmaSlideIndex(node, nodeMap, slideIndexById) {
  let current = node;
  const visited = new Set();
  for (let depth = 0; current && depth < 100; depth += 1) {
    const id = figmaNodeId(current);
    if (slideIndexById.has(id)) return slideIndexById.get(id);
    if (!current.parentIndex?.guid) break;
    const parentId = `${current.parentIndex.guid.sessionID}:${current.parentIndex.guid.localID}`;
    if (visited.has(parentId)) break;
    visited.add(parentId);
    current = nodeMap.get(parentId);
  }
  return -1;
}

function figmaColorToHex(color) {
  const byte = (value) => Math.max(0, Math.min(255, Math.round(Number(value || 0) * 255))).toString(16).padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`.toUpperCase();
}

function incrementCount(map, value) {
  map.set(value, (map.get(value) || 0) + 1);
}

function topCounts(map, limit) {
  return [...map.entries()].sort((left, right) => right[1] - left[1]).slice(0, limit).map(([value]) => value);
}

async function readRemoteImage(url) {
  if (typeof url !== "string" || !url.startsWith("https://")) return undefined;
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
    const contentType = response.headers.get("content-type") || "image/jpeg";
    if (!response.ok || !contentType.startsWith("image/")) return undefined;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 3 * 1024 * 1024) return undefined;
    return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return undefined;
  }
}

function readMeta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forward = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"));
  const reverse = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"));
  return decodeXml(forward?.[1] || reverse?.[1] || "");
}

function readHtmlTitle(html) {
  return decodeXml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim();
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

async function runCollaborativePanel(task, useWeb, env) {
  let evidence = "No external web research was requested. Analyze only the supplied product facts.";
  let sources = [];

  if (useWeb && env.OPENAI_API_KEY) {
    const researchModel = env.OPENAI_RESEARCH_MODEL || env.OPENAI_MODEL || env.AI_RESEARCH_MODEL || "gpt-6.1-terra";
    const research = await createOpenAIResponse({
      env,
      model: researchModel,
      system: `You are an evidence researcher supporting an execution team. Search for current, decision-relevant facts, verified target organizations, market signals, and usable channel evidence. Return a compact evidence brief with prominent source links. Do not mention any AI provider, model, or internal analysis role.`,
      prompt: task,
      useWeb: true,
      maxOutputTokens: 3800,
    });
    evidence = responseText(research);
    sources = collectOpenAISources(research);
  } else if (useWeb) {
    evidence = "Live source retrieval is unavailable with the currently connected services. Analyze the supplied project sources and product facts without inventing current evidence.";
  }

  const sharedPrompt = `${task}\n\nSHARED EVIDENCE BRIEF\n${evidence}\n\nProduce an independent execution package. Complete the research, prioritization, copy, sequences, lists, and operating details that can be delivered now. Do not delegate those tasks to the user. Explicitly identify assumptions and real external blockers. Do not mention any AI provider or model.`;
  const openAIModel = env.OPENAI_PANEL_MODEL || env.OPENAI_MODEL || "gpt-6.1-terra";
  const googleModel = env.GOOGLE_MODEL || "gemini-3.8-flash";
  const anthropicModel = env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

  const analysisPromises = [];
  if (env.OPENAI_API_KEY) analysisPromises.push(createOpenAIResponse({
      env,
      model: openAIModel,
      system: `${operatorSystem} Be rigorous about execution, prioritization, and measurable outcomes.`,
      prompt: sharedPrompt,
      useWeb: false,
      maxOutputTokens: 3200,
    }).then((response) => ({ name: "Analysis A", text: responseText(response) })));
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) analysisPromises.push(generateGoogleText({
      env,
      model: googleModel,
      system: `${operatorSystem} Be rigorous about market context, alternative interpretations, and audience nuance.`,
      prompt: sharedPrompt,
      maxOutputTokens: 3200,
    }).then((response) => ({ name: "Analysis B", text: response.text })));
  if (env.ANTHROPIC_API_KEY) analysisPromises.push(generateAnthropicText({
      env,
      model: anthropicModel,
      system: `${operatorSystem} Be rigorous about messaging quality, human impact, risks, and strategic coherence.`,
      prompt: sharedPrompt,
      maxOutputTokens: 3200,
    }).then((response) => ({ name: "Analysis C", text: response.text })));

  const opinions = await Promise.all(analysisPromises);
  if (opinions.length === 1) {
    return {
      id: crypto.randomUUID(),
      model: "Standard analysis",
      output: opinions[0].text,
      sources,
      createdAt: new Date().toISOString(),
    };
  }
  const transcript = opinions.map((opinion) => `## ${opinion.name}\n${opinion.text}`).join("\n\n");
  const synthesisSystem = `Synthesize the independent work into one concise, execution-ready package rather than a consultancy memo. Preserve valid risks and reject weak claims, but complete all work that can be done now. Lead with the execution status, concrete completed work, and launch-ready assets. Never tell the user to perform work you can include yourself. Never mention AI providers, model names, or internal analysis labels.`;
  const synthesisPrompt = `${task}\n\nSHARED EVIDENCE\n${evidence}\n\nINDEPENDENT WORK\n${transcript}\n\nReturn only these compact sections: Status; Completed now; Launch-ready queue; Exact messages and assets; Tracking; One next action. When delivery access is missing, say PREPARED — NOT LAUNCHED plainly and never imply execution occurred.`;
  let output;
  let id = crypto.randomUUID();
  if (env.OPENAI_API_KEY) {
    const synthesis = await createOpenAIResponse({ env, model: env.OPENAI_SYNTHESIS_MODEL || openAIModel, system: synthesisSystem, prompt: synthesisPrompt, useWeb: false, maxOutputTokens: 7500 });
    output = responseText(synthesis);
    id = synthesis.id || id;
  } else if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    output = (await generateGoogleText({ env, model: googleModel, system: synthesisSystem, prompt: synthesisPrompt, maxOutputTokens: 7500 })).text;
  } else {
    output = (await generateAnthropicText({ env, model: anthropicModel, system: synthesisSystem, prompt: synthesisPrompt, maxOutputTokens: 7500 })).text;
  }

  return {
    id,
    model: opinions.length === 3 ? "Three-way strategy review" : "Collaborative review",
    output,
    sources,
    createdAt: new Date().toISOString(),
  };
}

async function createOpenAIResponse({ env, model, system, prompt, useWeb, maxOutputTokens }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: system,
      input: prompt,
      max_output_tokens: maxOutputTokens,
      ...(useWeb
        ? {
            tools: [{ type: "web_search", search_context_size: "medium" }],
            tool_choice: "auto",
            include: ["web_search_call.action.sources"],
          }
        : {}),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("The analysis service could not complete this request. Please try again.");
    error.statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }
  return body;
}

async function generateProductBrainStructured({ env, system, prompt, images = [], useWeb = false }) {
  const supportedImages = images.filter(isSupportedAnalysisImage);
  let lastError;
  if (env.OPENAI_API_KEY) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || env.AI_MODEL || "gpt-6.1-terra",
          instructions: system,
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }, ...supportedImages.map((imageUrl) => ({ type: "input_image", image_url: imageUrl, detail: "high" }))] }],
          max_output_tokens: 5000,
          ...(useWeb ? { tools: [{ type: "web_search", search_context_size: "medium" }], tool_choice: "auto" } : {}),
          text: { format: { type: "json_schema", name: "product_brain", strict: true, schema: productBrainSchema() } },
        }),
      });
      if (!response.ok) throw providerRequestError(response.status);
      return JSON.parse(responseText(await response.json()));
    } catch (error) {
      lastError = error;
    }
  }
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) {
    try {
      return await generateGoogleStructured({ env, system, prompt, images: supportedImages });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("No analysis service is connected.");
}

async function generateGoogleText({ env, model, system, prompt, maxOutputTokens }) {
  try {
    const google = createGoogleGenerativeAI({ apiKey: env.GOOGLE_GENERATIVE_AI_API_KEY });
    return await generateText({ model: google(model), system, prompt, maxOutputTokens });
  } catch {
    const error = new Error("The analysis service could not complete this request. Please try again.");
    error.statusCode = 502;
    throw error;
  }
}

async function generateStructuredObject({ env, name, system, prompt, images = [], schema }) {
  const supportedImages = images.filter(isSupportedAnalysisImage);
  if (env.OPENAI_API_KEY) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || env.AI_MODEL || "gpt-6.1-terra",
        instructions: system,
        input: [{ role: "user", content: [{ type: "input_text", text: prompt }, ...supportedImages.map((imageUrl) => ({ type: "input_image", image_url: imageUrl, detail: "high" }))] }],
        max_output_tokens: 6000,
        text: { format: { type: "json_schema", name, strict: true, schema } },
      }),
    });
    if (!response.ok) throw providerRequestError(response.status);
    return JSON.parse(responseText(await response.json()));
  }
  return generateGoogleStructured({ env, system, prompt, images: supportedImages, schema });
}

async function generateGoogleStructured({ env, system, prompt, images = [], schema = productBrainSchema() }) {
  const model = env.GOOGLE_MODEL || "gemini-3.8-flash";
  const imageParts = images.map(dataUrlToGooglePart).filter(Boolean);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": env.GOOGLE_GENERATIVE_AI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }, ...imageParts] }],
      generationConfig: {
        maxOutputTokens: 5000,
        responseMimeType: "application/json",
        responseJsonSchema: schema,
      },
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw providerRequestError(response.status);
  const text = (data.candidates || []).flatMap((candidate) => candidate.content?.parts || []).map((part) => part.text || "").join("\n").trim();
  if (!text) throw new Error("No structured response was returned.");
  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
}

function dataUrlToGooglePart(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,(.+)$/s);
  return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
}

async function generateAnthropicText({ env, model, system, prompt, maxOutputTokens }) {
  try {
    const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });
    return await generateText({ model: anthropic(model), system, prompt, maxOutputTokens });
  } catch {
    const error = new Error("The analysis service could not complete this request. Please try again.");
    error.statusCode = 502;
    throw error;
  }
}

function requireProviderKeys(mode, env) {
  const ready = Boolean(env.OPENAI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY);
  if (ready) return;

  const error = new Error("Connect your private analysis APIs under Connections first.");
  error.statusCode = 503;
  throw error;
}

function providerRequestError(status) {
  const error = new Error("The connected service could not complete this request.");
  error.statusCode = status >= 400 && status < 500 ? 400 : 502;
  return error;
}

const operatorSystem = `You are Market Agent, an autonomous senior marketing operator—not a consultant handing work back to the user. Use only supplied product facts for product claims and cite current market evidence when available. Complete every task possible inside the current run: research, targeting, prioritization, campaign design, final copy, sequences, asset briefs, launch queues, tracking structure, and measurement rules. Never tell the user to do work you can deliver yourself. Be concise and action-first: lead with execution status, completed work, and ready-to-use assets; avoid essays, repeated caveats, and generic advice. Ask for only identity, budget, private account access, legal approval, or authorization that truly requires the user. When a connector is unavailable, label the work PREPARED — NOT LAUNCHED, prepare the exact ready-to-execute payload, and give one missing-access action. Never invent customers, prospects, quotes, metrics, or results. Never imply that content was published or messages were sent. Never mention AI providers, model names, or internal analysis roles.`;

const starterGuideSystem = `You are Market Agent's low-cost setup assistant. The user has not connected private analysis APIs yet. Help only with connecting API keys and understanding capability levels. Explain that either OpenAI or Gemini is enough to unlock core reasoning and image creation; Gemini also enables video creation; Claude is an optional independent reviewer; and all three together produce the strongest collaborative strategy. Give concise, non-technical, step-by-step instructions. Direct the user to Connections in this app and never request that they paste a key into chat. Do not perform marketing work, analyze private project materials, or claim that a connection is active.`;

function buildContext(workspace) {
  const sources = Array.isArray(workspace.sources) ? workspace.sources : [];
  const sourceText = sources.length
    ? sources.map((source) => `- ${source.label || source.url}: ${source.url}`).join("\n")
    : "- No source URLs have been supplied yet.";
  const projectMemory = Array.isArray(workspace.chatMessages)
    ? workspace.chatMessages.slice(-16).map((item) => `${item?.role === "assistant" ? "Agent" : "User"}: ${String(item?.content || "").slice(0, 3000)}`).join("\n")
    : "";
  return `
PRODUCT WORKSPACE
Name: ${workspace.name || "Unnamed product"}
Website: ${workspace.website || "Not supplied"}
Description: ${workspace.description || "Not supplied"}
Primary audience: ${workspace.audience || "Not supplied"}
Value proposition: ${workspace.valueProposition || "Not supplied"}
Voice: ${workspace.voice || "Not supplied"}
Claims and guardrails: ${workspace.guardrails || "No claims supplied; do not invent any."}
Additional product notes: ${workspace.notes || "None supplied"}

VERIFIED SOURCE URLS
${sourceText}

SAVED PROJECT CONVERSATION
${projectMemory || "No saved conversation yet."}
`.trim();
}

function responseText(response) {
  const text = (
    response.output_text ||
    (response.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((content) => content.type === "output_text")
      .map((content) => content.text || "")
      .join("\n")
  ).trim();
  if (text) return text;
  throw new Error("The analysis service returned no text for this request.");
}

function formatOpenAIResponse(response, _model) {
  return {
    id: response.id || crypto.randomUUID(),
    model: "Standard analysis",
    output: responseText(response),
    sources: collectOpenAISources(response),
    createdAt: new Date().toISOString(),
  };
}

function collectOpenAISources(response) {
  const collected = [];
  const add = (title, url) => {
    if (!url || collected.some((entry) => entry.url === url)) return;
    collected.push({ title: title || url, url });
  };

  for (const item of response.output || []) {
    if (item.type === "web_search_call") {
      for (const source of item.action?.sources || []) add(source.title, source.url);
    }
    if (item.type === "message") {
      for (const content of item.content || []) {
        for (const annotation of content.annotations || []) {
          if (annotation.type === "url_citation") add(annotation.title, annotation.url);
        }
      }
    }
  }
  return collected;
}

export function createRunRecord(result, action = "chat", prompt = "", projectId = "project-default") {
  const createdAt = result.createdAt || new Date().toISOString();
  const dateLabel = new Date(createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return {
    id: crypto.randomUUID(),
    projectId,
    remoteId: result.id,
    action,
    title: `${actionTitles[action] || actionTitles.chat} · ${dateLabel}`,
    prompt,
    output: result.output,
    sources: result.sources || [],
    status: "Draft",
    model: result.model,
    intensity: result.intensity,
    createdAt,
  };
}
