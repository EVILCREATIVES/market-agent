import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateText } from "ai";
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
    const result = await runBalancedPanel(task, useWeb, env);
    return { ...result, intensity };
  }

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

export async function runProjectConversation(payload, env = process.env) {
  if (!env.OPENAI_API_KEY) {
    const error = new Error("The secure analysis service is not fully configured.");
    error.statusCode = 503;
    throw error;
  }
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
  const model = env.OPENAI_MODEL || env.AI_MODEL || "gpt-6.1-terra";
  const response = await createOpenAIResponse({
    env,
    model,
    system: `${operatorSystem} You are also the project's persistent conversational partner. Keep replies compact, attentive, and grounded in the saved project and conversation.`,
    prompt,
    useWeb: Boolean(payload?.useWeb),
    maxOutputTokens: 2200,
  });
  return {
    reply: responseText(response),
    sources: collectOpenAISources(response),
    createdAt: new Date().toISOString(),
  };
}

function normalizeCampaignIntensity(value) {
  return ["careful", "assertive", "aggressive"].includes(value) ? value : "assertive";
}

function needsDeliveryAccess(action, prompt) {
  return action === "campaign" || action === "social" || /\b(send|email|message|outreach|publish|post|campaign|buyer|prospect|lead|pipeline|launch|demo)\b/i.test(String(prompt || ""));
}

export async function buildProductBrain(payload, env = process.env) {
  if (!env.OPENAI_API_KEY) {
    const error = new Error("The secure analysis service is not fully configured.");
    error.statusCode = 503;
    throw error;
  }

  const projectId = String(payload?.projectId || "project-default");
  const projectName = String(payload?.projectName || "New project").slice(0, 200);
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
    .filter((value) => typeof value === "string" && value.startsWith("data:image/"))
    .concat(connectedMaterial.images)
    .slice(0, 18);

  if (!materialText.trim() && !images.length && !links.length) {
    const error = new Error("Add at least one file or source link first.");
    error.statusCode = 400;
    throw error;
  }

  const prompt = `Build a factual product brain for the project named "${projectName}" from the supplied materials and public source links.

SOURCE LINKS
${links.length ? links.map((link) => `- ${link}`).join("\n") : "No links supplied."}

EXTRACTED MATERIAL
${materialText || "Visual materials are attached."}

Infer only what is strongly supported. Derive the visual identity from the supplied deck pages, images, and documents: choose the most representative visible colors as six-digit hex values, describe typography, and summarize the imagery style. Consolidate duplicates and contradictions. Put uncertainties and facts that need confirmation in the notes and unknowns fields. The result is a draft for the user to review, not a claim of certainty. Never mention internal systems, providers, or model names.`;

  const model = env.OPENAI_MODEL || env.AI_MODEL || "gpt-6.1-terra";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions: "You are a meticulous product-onboarding analyst. Extract a useful marketing source of truth from user materials. Preserve factual nuance, identify uncertainty, and never invent proof, customers, metrics, pricing, or capabilities.",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...images.map((imageUrl) => ({ type: "input_image", image_url: imageUrl, detail: "high" })),
        ],
      }],
      max_output_tokens: 5000,
      ...(links.length ? { tools: [{ type: "web_search", search_context_size: "medium" }], tool_choice: "auto" } : {}),
      text: {
        format: {
          type: "json_schema",
          name: "product_brain",
          strict: true,
          schema: productBrainSchema(),
        },
      },
    }),
  });

  if (!response.ok) {
    const error = new Error("The project materials could not be analyzed. Please try again.");
    error.statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(responseText(await response.json()));
  } catch {
    const error = new Error("The project materials were read, but the product brain could not be assembled. Please try again.");
    error.statusCode = 502;
    throw error;
  }

  const normalized = normalizeBrainResult(parsed, projectName, links[0] || "");
  if (connectedMaterial.issues.length) {
    normalized.unknowns = normalized.unknowns.filter((question) => !/what (content|visual identity).*(deck|figma)|what.*(deck|figma).*(contain|show)|describe.*(deck|figma)/i.test(question));
  }
  return { projectId, ...normalized, sourceWarnings: connectedMaterial.issues };
}

export async function refineProductBrain(payload, env = process.env) {
  if (!env.OPENAI_API_KEY) {
    const error = new Error("The secure analysis service is not fully configured.");
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
      primaryColor: workspace.brand?.primaryColor || "#222222",
      secondaryColor: workspace.brand?.secondaryColor || "#f4f1e8",
      accentColor: workspace.brand?.accentColor || "#4d9a75",
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
  const model = env.OPENAI_MODEL || env.AI_MODEL || "gpt-6.1-terra";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      instructions: "You maintain a factual product and brand source of truth. Apply user corrections precisely, preserve nuance, and return only structured data. Never mention internal systems or model names.",
      input: prompt,
      max_output_tokens: 5000,
      text: { format: { type: "json_schema", name: "product_brain", strict: true, schema: productBrainSchema() } },
    }),
  });
  if (!response.ok) {
    const error = new Error("The answers could not be applied. Please try again.");
    error.statusCode = response.status >= 400 && response.status < 500 ? 400 : 502;
    throw error;
  }

  try {
    const parsed = JSON.parse(responseText(await response.json()));
    const normalized = normalizeBrainResult(parsed, safeWorkspace.name, safeWorkspace.website);
    normalized.unknowns = removeRepeatedQuestions(normalized.unknowns, answers.map((item) => item.question));
    return normalized;
  } catch {
    const error = new Error("The answers were read, but the product brain could not be updated. Please try again.");
    error.statusCode = 502;
    throw error;
  }
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
          typography: { type: "string" },
          imageryStyle: { type: "string" },
          notes: { type: "string" },
        },
        required: ["primaryColor", "secondaryColor", "accentColor", "typography", "imageryStyle", "notes"],
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
        primaryColor: colorField(brand.primaryColor, "#222222"),
        secondaryColor: colorField(brand.secondaryColor, "#f4f1e8"),
        accentColor: colorField(brand.accentColor, "#4d9a75"),
        typography: stringField(brand.typography),
        imageryStyle: stringField(brand.imageryStyle),
        notes: stringField(brand.notes),
      },
    },
    reviewSummary: stringField(parsed?.reviewSummary, "The product brain is ready for review."),
    unknowns: Array.isArray(parsed?.unknowns) ? removeRepeatedQuestions(parsed.unknowns.map((value) => String(value)).filter(Boolean), []).slice(0, 12) : [],
  };
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

function sameQuestion(left, right) {
  const leftNormalized = String(left || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const rightNormalized = String(right || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized || leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return true;
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

export async function readConnectedMaterial(links) {
  const textParts = [];
  const images = [];
  const issues = [];
  for (const link of links) {
    try {
      const url = new URL(link);
      if (url.hostname === "docs.google.com" && url.pathname.includes("/presentation/d/")) {
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
      }

      if (url.hostname === "figma.com" || url.hostname.endsWith(".figma.com")) {
        try {
          const connected = await readPublicFigmaDeck(link);
          if (connected.text) textParts.push(connected.text);
          if (connected.image && images.length < 4) images.push(connected.image);
          if (connected.issue) issues.push(connected.issue);
        } catch {
          issues.push("Figma could not read this deck. Confirm that Share → link access is set to “Anyone” with “Can view,” then return here and select Update from sources.");
        }
      }
    } catch {
      // A connector can fail independently; the remaining uploaded material is still analyzed.
    }
  }
  return { text: textParts.join("\n\n").slice(0, 100_000), images, issues: Array.from(new Set(issues)) };
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

async function runBalancedPanel(task, useWeb, env) {
  let evidence = "No external web research was requested. Analyze only the supplied product facts.";
  let sources = [];

  if (useWeb) {
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
  }

  const sharedPrompt = `${task}\n\nSHARED EVIDENCE BRIEF\n${evidence}\n\nProduce an independent execution package. Complete the research, prioritization, copy, sequences, lists, and operating details that can be delivered now. Do not delegate those tasks to the user. Explicitly identify assumptions and real external blockers. Do not mention any AI provider or model.`;
  const openAIModel = env.OPENAI_PANEL_MODEL || env.OPENAI_MODEL || "gpt-6.1-terra";
  const googleModel = env.GOOGLE_MODEL || "gemini-3.8-flash";
  const anthropicModel = env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

  const [openAIResponse, googleResponse, anthropicResponse] = await Promise.all([
    createOpenAIResponse({
      env,
      model: openAIModel,
      system: `${operatorSystem} Be rigorous about execution, prioritization, and measurable outcomes.`,
      prompt: sharedPrompt,
      useWeb: false,
      maxOutputTokens: 3200,
    }),
    generateGoogleText({
      env,
      model: googleModel,
      system: `${operatorSystem} Be rigorous about market context, alternative interpretations, and audience nuance.`,
      prompt: sharedPrompt,
      maxOutputTokens: 3200,
    }),
    generateAnthropicText({
      env,
      model: anthropicModel,
      system: `${operatorSystem} Be rigorous about messaging quality, human impact, risks, and strategic coherence.`,
      prompt: sharedPrompt,
      maxOutputTokens: 3200,
    }),
  ]);

  const opinions = [
    { name: "Analysis A", text: responseText(openAIResponse) },
    { name: "Analysis B", text: googleResponse.text },
    { name: "Analysis C", text: anthropicResponse.text },
  ];
  const transcript = opinions.map((opinion) => `## ${opinion.name}\n${opinion.text}`).join("\n\n");
  const synthesisModel = env.OPENAI_SYNTHESIS_MODEL || openAIModel;
  const synthesis = await createOpenAIResponse({
    env,
    model: synthesisModel,
    system: `Synthesize the independent work into one concise, execution-ready package rather than a consultancy memo. Preserve valid risks and reject weak claims, but complete all work that can be done now. Lead with the execution status, concrete completed work, and launch-ready assets. Never tell the user to perform work you can include yourself. Never mention AI providers, model names, or internal analysis labels.`,
    prompt: `${task}\n\nSHARED EVIDENCE\n${evidence}\n\nINDEPENDENT WORK\n${transcript}\n\nReturn only these compact sections: Status; Completed now; Launch-ready queue; Exact messages and assets; Tracking; One next action. When delivery access is missing, say PREPARED — NOT LAUNCHED plainly and never imply execution occurred.`,
    useWeb: false,
    maxOutputTokens: 7500,
  });

  return {
    id: synthesis.id || crypto.randomUUID(),
    model: "Balanced panel",
    output: responseText(synthesis),
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
  const ready = Boolean(env.OPENAI_API_KEY)
    && (mode !== "panel" || (Boolean(env.GOOGLE_GENERATIVE_AI_API_KEY) && Boolean(env.ANTHROPIC_API_KEY)));
  if (ready) return;

  const error = new Error("The secure analysis service is not fully configured.");
  error.statusCode = 503;
  throw error;
}

const operatorSystem = `You are Market Agent, an autonomous senior marketing operator—not a consultant handing work back to the user. Use only supplied product facts for product claims and cite current market evidence when available. Complete every task possible inside the current run: research, targeting, prioritization, campaign design, final copy, sequences, asset briefs, launch queues, tracking structure, and measurement rules. Never tell the user to do work you can deliver yourself. Be concise and action-first: lead with execution status, completed work, and ready-to-use assets; avoid essays, repeated caveats, and generic advice. Ask for only identity, budget, private account access, legal approval, or authorization that truly requires the user. When a connector is unavailable, label the work PREPARED — NOT LAUNCHED, prepare the exact ready-to-execute payload, and give one missing-access action. Never invent customers, prospects, quotes, metrics, or results. Never imply that content was published or messages were sent. Never mention AI providers, model names, or internal analysis roles.`;

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
