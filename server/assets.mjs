import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { get, put } from "@vercel/blob";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { analyzeProjectAsset, generateProjectDocument, safeFetchPublic } from "./agent.mjs";
import { getPool } from "./db.mjs";
import { getUserMediaBudgetCents } from "./media-budget.mjs";

let tablesReady = false;

export async function listProjectAssets(userId, projectId, env = process.env) {
  const safeProjectId = requiredText(projectId, "Choose a project first.", 200);
  await ensureTables(env);
  const [assets, proposals] = await Promise.all([
    getPool(env).query(
      "SELECT * FROM market_agent_project_assets WHERE user_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 200",
      [userId, safeProjectId],
    ),
    getPool(env).query(
      "SELECT * FROM market_agent_asset_proposals WHERE user_id = $1 AND project_id = $2 ORDER BY created_at DESC LIMIT 100",
      [userId, safeProjectId],
    ),
  ]);
  return { assets: assets.rows.map(serializeAsset), proposals: proposals.rows.map(serializeProposal) };
}

export async function registerUploadedAsset(userId, payload, env = process.env) {
  const projectId = requiredText(payload?.projectId, "Choose a project first.", 200);
  const name = requiredText(payload?.name, "The uploaded asset needs a name.", 250);
  const blobPath = requiredText(payload?.blobPath, "The uploaded file could not be found.", 2000);
  if (!blobPath.startsWith(`market-agent-assets/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}/`)) throw httpError(400, "The uploaded file path is invalid.");
  return createAndAnalyzeAsset(userId, {
    projectId,
    name,
    sourceKind: "upload",
    assetKind: normalizeAssetKind(payload?.kind),
    mimeType: String(payload?.mimeType || "application/octet-stream").slice(0, 200),
    sizeBytes: Math.max(0, Number(payload?.sizeBytes || 0)),
    blobPath,
    sourceUrl: "",
    detail: String(payload?.detail || "").slice(0, 500),
    text: payload?.text,
    images: payload?.images,
    workspace: payload?.workspace,
  }, env);
}

export async function registerLinkedAsset(userId, payload, env = process.env) {
  const projectId = requiredText(payload?.projectId, "Choose a project first.", 200);
  const sourceUrl = requiredText(payload?.sourceUrl, "Paste a public asset link first.", 2000);
  let url;
  try { url = new URL(sourceUrl); } catch { throw httpError(400, "Paste a complete public link."); }
  if (!/^https?:$/.test(url.protocol)) throw httpError(400, "Only public web links are supported.");
  const isFigma = /(^|\.)figma\.com$/i.test(url.hostname);
  return createAndAnalyzeAsset(userId, {
    projectId,
    name: String(payload?.name || (isFigma ? "Figma asset" : url.hostname)).slice(0, 250),
    sourceKind: "link",
    assetKind: isFigma ? "figma" : "link",
    mimeType: "text/html",
    sizeBytes: 0,
    blobPath: "",
    sourceUrl: url.toString(),
    detail: isFigma ? "Public Figma link" : "Public asset link",
    text: "",
    images: [],
    workspace: payload?.workspace,
  }, env);
}

async function createAndAnalyzeAsset(userId, asset, env) {
  await ensureTables(env);
  const id = randomUUID();
  await getPool(env).query(
    `INSERT INTO market_agent_project_assets
      (id, user_id, project_id, name, source_kind, asset_kind, mime_type, size_bytes, blob_path, source_url, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, userId, asset.projectId, asset.name, asset.sourceKind, asset.assetKind, asset.mimeType, asset.sizeBytes, asset.blobPath, asset.sourceUrl, asset.detail],
  );
  try {
    const decision = await analyzeProjectAsset({
      name: asset.name,
      kind: asset.assetKind,
      mimeType: asset.mimeType,
      detail: asset.detail,
      sourceUrl: asset.sourceUrl,
      text: asset.text,
      images: asset.images,
      workspace: asset.workspace,
    }, env);
    const updated = await getPool(env).query(
      `UPDATE market_agent_project_assets
       SET status = 'ready', tags = $3::text[], summary = $4, recommendation = $5,
           rationale = $6, suggested_changes = $7::text[], error = '', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, decision.tags, decision.summary, decision.recommendation, decision.rationale, decision.suggestedChanges],
    );
    const related = await getPool(env).query(
      `SELECT id FROM market_agent_project_assets
       WHERE user_id = $1 AND project_id = $2 AND status = 'ready'
       ORDER BY created_at DESC LIMIT 30`,
      [userId, asset.projectId],
    );
    const relatedAssetIds = Array.from(new Set([id, ...related.rows.map((row) => row.id)]));
    for (const proposal of decision.proposedDeliverables) {
      await getPool(env).query(
        `INSERT INTO market_agent_asset_proposals
          (id, user_id, project_id, kind, title, description, rationale, source_asset_ids)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8::text[]
         WHERE NOT EXISTS (
           SELECT 1 FROM market_agent_asset_proposals
           WHERE user_id = $2 AND project_id = $3 AND kind = $4
             AND LOWER(title) = LOWER($5) AND status IN ('awaiting_approval', 'running', 'complete')
         )`,
        [randomUUID(), userId, asset.projectId, proposal.kind, proposal.title, proposal.description, proposal.rationale, relatedAssetIds],
      );
    }
    return { asset: serializeAsset(updated.rows[0]), ...(await listProjectAssets(userId, asset.projectId, env)) };
  } catch (error) {
    const failed = await getPool(env).query(
      `UPDATE market_agent_project_assets SET status = 'failed', error = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, safeError(error)],
    );
    return { asset: serializeAsset(failed.rows[0]), ...(await listProjectAssets(userId, asset.projectId, env)) };
  }
}

export async function approveAssetProposal(userId, payload, env = process.env) {
  const id = requiredText(payload?.id, "Choose a proposed deliverable first.", 100);
  const approvedBudgetCents = Number(payload?.approvedBudgetCents);
  await ensureTables(env);
  const pool = getPool(env);
  const client = await pool.connect();
  let row;
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT * FROM market_agent_asset_proposals WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [id, userId],
    );
    row = result.rows[0];
    if (!row) throw httpError(404, "Proposed deliverable not found.");
    if (row.status !== "awaiting_approval") throw httpError(409, "This proposal is no longer waiting for approval.");
    if (!Number.isInteger(approvedBudgetCents) || approvedBudgetCents !== Number(row.estimated_cost_cents)) {
      throw httpError(400, "Approve the exact maximum estimate shown.");
    }
    const monthlyCapCents = await getUserMediaBudgetCents(userId, env, client, true);
    const monthly = await client.query(
      `SELECT
        (SELECT COALESCE(SUM(approved_budget_cents), 0) FROM market_agent_media_jobs
          WHERE user_id = $1 AND approved_at >= date_trunc('month', NOW()) AND status <> 'cancelled')
        +
        (SELECT COALESCE(SUM(approved_budget_cents), 0) FROM market_agent_asset_proposals
          WHERE user_id = $1 AND approved_at >= date_trunc('month', NOW()) AND status <> 'cancelled')
        AS cents`,
      [userId],
    );
    if (Number(monthly.rows[0]?.cents || 0) + approvedBudgetCents > monthlyCapCents) {
      throw httpError(409, `This would exceed your $${(monthlyCapCents / 100).toFixed(2)} monthly creative-production limit.`);
    }
    const updated = await client.query(
      `UPDATE market_agent_asset_proposals
       SET status = 'running', approved_budget_cents = $3, approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, approvedBudgetCents],
    );
    row = updated.rows[0];
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  try {
    const assets = await getPool(env).query(
      `SELECT name, asset_kind, mime_type, blob_path, tags, summary, recommendation, rationale, suggested_changes
       FROM market_agent_project_assets
       WHERE user_id = $1 AND project_id = $2 AND id = ANY($3::text[])`,
      [userId, row.project_id, row.source_asset_ids],
    );
    const content = await generateProjectDocument({
      kind: row.kind,
      title: row.title,
      description: row.description,
      rationale: row.rationale,
      workspace: payload?.workspace,
      assets: assets.rows.map((asset) => ({
        name: asset.name,
        kind: asset.asset_kind,
        tags: asset.tags,
        summary: asset.summary,
        recommendation: asset.recommendation,
        rationale: asset.rationale,
        suggestedChanges: asset.suggested_changes,
      })),
    }, env);
    const visuals = await loadProposalVisuals(assets.rows, env);
    const bytes = await renderPdf(content, row.kind, payload?.workspace?.brand, visuals);
    const blob = await put(`market-agent-deliverables/${userId}/${row.project_id}/${row.id}.pdf`, bytes, {
      access: "private",
      addRandomSuffix: true,
      contentType: "application/pdf",
      cacheControlMaxAge: 31_536_000,
    });
    const complete = await getPool(env).query(
      `UPDATE market_agent_asset_proposals
       SET status = 'complete', blob_path = $3, actual_cost_cents = NULL, error = '', updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, blob.pathname],
    );
    return { proposal: serializeProposal(complete.rows[0]), ...(await listProjectAssets(userId, row.project_id, env)) };
  } catch (error) {
    const failed = await getPool(env).query(
      `UPDATE market_agent_asset_proposals SET status = 'failed', error = $3, updated_at = NOW()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [id, userId, safeError(error)],
    );
    return { proposal: serializeProposal(failed.rows[0]), ...(await listProjectAssets(userId, row.project_id, env)) };
  }
}

export async function cancelAssetProposal(userId, payload, env = process.env) {
  const id = requiredText(payload?.id, "Choose a proposed deliverable first.", 100);
  await ensureTables(env);
  const result = await getPool(env).query(
    `UPDATE market_agent_asset_proposals SET status = 'cancelled', updated_at = NOW()
     WHERE id = $1 AND user_id = $2 AND status = 'awaiting_approval' RETURNING *`,
    [id, userId],
  );
  if (!result.rows[0]) throw httpError(409, "Only an unapproved proposal can be declined.");
  return { proposal: serializeProposal(result.rows[0]), ...(await listProjectAssets(userId, result.rows[0].project_id, env)) };
}

export async function serveProjectFile(userId, req, res, env = process.env) {
  const id = requiredText(req.query?.id, "The file is missing.", 100);
  const type = req.query?.type === "proposal" ? "proposal" : "asset";
  await ensureTables(env);
  const result = type === "proposal"
    ? await getPool(env).query("SELECT title AS name, blob_path, 'application/pdf' AS mime_type FROM market_agent_asset_proposals WHERE id = $1 AND user_id = $2 AND status = 'complete'", [id, userId])
    : await getPool(env).query("SELECT name, blob_path, mime_type FROM market_agent_project_assets WHERE id = $1 AND user_id = $2", [id, userId]);
  const row = result.rows[0];
  if (!row?.blob_path) throw httpError(404, "File not found.");
  const blob = await get(row.blob_path, { access: "private" });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw httpError(404, "File not found.");
  res.statusCode = 200;
  res.setHeader("Content-Type", blob.blob.contentType || row.mime_type || "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFilename(row.name)}${type === "proposal" ? ".pdf" : ""}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  return Readable.fromWeb(blob.stream).pipe(res);
}

async function loadProposalVisuals(assets, env) {
  const visuals = [];
  for (const asset of assets) {
    if (!String(asset.mime_type || "").startsWith("image/") || !asset.blob_path) continue;
    const blob = await get(asset.blob_path, { access: "private" });
    if (!blob || blob.statusCode !== 200 || !blob.stream) continue;
    visuals.push({ mimeType: blob.blob.contentType || asset.mime_type, bytes: Buffer.from(await new Response(blob.stream).arrayBuffer()) });
    if (visuals.length >= 6) break;
  }
  return visuals;
}

export async function renderPdf(content, kind, brand = {}, visuals = []) {
  const document = await PDFDocument.create();
  const { regular, bold } = await embedBrandFonts(document, brand);
  const primary = hexColor(brand?.primaryColor || brand?.accentColor || "#6e50d7");
  const accent = hexColor(brand?.accentColor || brand?.primaryColor || "#6e50d7");
  const light = hexColor(brand?.neutralLightColor || "#ffffff");
  const dark = hexColor(brand?.neutralDarkColor || brand?.secondaryColor || "#222222");
  const embeddedVisuals = [];
  for (const visual of visuals) {
    try {
      embeddedVisuals.push(visual.mimeType.includes("png") ? await document.embedPng(visual.bytes) : await document.embedJpg(visual.bytes));
    } catch {
      // The asset remains cited in the document even when its binary format cannot be embedded.
    }
  }
  const pageSize = kind === "deck" ? [960, 540] : [612, 792];
  const margin = kind === "deck" ? 66 : 54;
  const titleSize = kind === "deck" ? 36 : 28;
  const bodySize = kind === "deck" ? 16 : 11;
  const cover = document.addPage(pageSize);
  cover.drawRectangle({ x: 0, y: 0, width: pageSize[0], height: pageSize[1], color: light });
  cover.drawRectangle({ x: 0, y: 0, width: 14, height: pageSize[1], color: primary });
  drawWrapped(cover, cleanText(content?.title || "Project document"), bold, titleSize, margin, pageSize[1] - margin - 35, pageSize[0] - margin * 2, titleSize * 1.15, dark);
  drawWrapped(cover, cleanText(content?.subtitle || "Prepared from approved project assets"), regular, bodySize + 2, margin, pageSize[1] - margin - 145, pageSize[0] - margin * 2, (bodySize + 2) * 1.45, dark);
  if (embeddedVisuals[0]) {
    const scaled = embeddedVisuals[0].scaleToFit(kind === "deck" ? 340 : 260, kind === "deck" ? 210 : 250);
    cover.drawImage(embeddedVisuals[0], { x: pageSize[0] - margin - scaled.width, y: margin, width: scaled.width, height: scaled.height });
  }

  for (const [sectionIndex, section] of (Array.isArray(content?.sections) ? content.sections.slice(0, 14) : []).entries()) {
    const page = document.addPage(pageSize);
    page.drawRectangle({ x: 0, y: 0, width: pageSize[0], height: pageSize[1], color: light });
    page.drawRectangle({ x: 0, y: pageSize[1] - 9, width: pageSize[0], height: 9, color: primary });
    let y = pageSize[1] - margin;
    y = drawWrapped(page, cleanText(section?.heading || "Section"), bold, kind === "deck" ? 28 : 20, margin, y, pageSize[0] - margin * 2, kind === "deck" ? 34 : 25, dark) - 16;
    y = drawWrapped(page, cleanText(section?.body || ""), regular, bodySize, margin, y, pageSize[0] - margin * 2, bodySize * 1.5, dark) - 12;
    for (const bullet of Array.isArray(section?.bullets) ? section.bullets.slice(0, 10) : []) {
      if (y < margin + 25) break;
      page.drawCircle({ x: margin + 4, y: y - bodySize * 0.35, size: 2.4, color: accent });
      y = drawWrapped(page, cleanText(bullet), regular, bodySize, margin + 18, y, pageSize[0] - margin * 2 - 18, bodySize * 1.45, dark) - 6;
    }
    const visual = embeddedVisuals[sectionIndex + 1];
    if (visual) {
      const scaled = visual.scaleToFit(kind === "deck" ? 280 : 210, kind === "deck" ? 170 : 180);
      page.drawImage(visual, { x: pageSize[0] - margin - scaled.width, y: margin, width: scaled.width, height: scaled.height });
    }
  }
  document.setTitle(cleanText(content?.title || "Project document"));
  document.setCreator("Market Agent");
  return document.save();
}

async function embedBrandFonts(document, brand) {
  const fallbackRegular = await document.embedFont(StandardFonts.Helvetica);
  const fallbackBold = await document.embedFont(StandardFonts.HelveticaBold);
  const sources = Array.isArray(brand?.fontSources) ? brand.fontSources.filter((source) => source?.family && /^https:\/\//i.test(source?.url || "")) : [];
  if (!sources.length) return { regular: fallbackRegular, bold: fallbackBold };
  document.registerFontkit(fontkit);
  const families = Array.isArray(brand?.fontFamilies) ? brand.fontFamilies.map(String) : [];
  const typography = String(brand?.typography || "");
  const displayFamily = selectTypographyFamily(families, typography, /(?:display|headline|heading|title)/i) || families.find((family) => !/inter|sans|serif/i.test(family)) || families[0];
  const bodyFamily = selectTypographyFamily(families, typography, /(?:body|support|copy|text|interface)/i) || families.find((family) => /inter|sans|serif/i.test(family)) || families[1] || families[0];
  const regularSource = selectFontFile(sources, bodyFamily, false);
  const boldSource = selectFontFile(sources, displayFamily, true);
  const cache = new Map();
  const embed = async (source, fallback) => {
    if (!source) return fallback;
    try {
      let bytes = cache.get(source.url);
      if (!bytes) {
        bytes = await fetchFontBytes(source.url);
        if (bytes) cache.set(source.url, bytes);
      }
      return bytes ? await document.embedFont(bytes, { subset: true }) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    regular: await embed(regularSource, fallbackRegular),
    bold: await embed(boldSource, fallbackBold),
  };
}

function selectTypographyFamily(families, typography, rolePattern) {
  return families.find((family) => {
    const index = typography.toLowerCase().indexOf(String(family).toLowerCase());
    return index >= 0 && rolePattern.test(typography.slice(index, index + 80));
  });
}

function selectFontFile(sources, family, preferBold) {
  const matching = sources.filter((source) => !family || String(source.family).toLowerCase() === String(family).toLowerCase());
  const candidates = matching.length ? matching : sources;
  return candidates.sort((left, right) => fontWeightScore(right, preferBold) - fontWeightScore(left, preferBold))[0];
}

function fontWeightScore(source, preferBold) {
  const weight = String(source?.weight || "400").toLowerCase();
  const number = Number(weight.match(/\d{3}/)?.[0] || (/bold/.test(weight) ? 700 : 400));
  const target = preferBold ? 700 : 400;
  return 1000 - Math.abs(number - target) - (/italic|oblique/i.test(source?.style || "") ? 100 : 0);
}

async function fetchFontBytes(url) {
  const response = await safeFetchPublic(url, { headers: { Accept: "font/woff2,font/woff,font/ttf,font/otf,application/octet-stream;q=0.8,*/*;q=0.2" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return null;
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > 4 * 1024 * 1024) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength <= 4 * 1024 * 1024 ? bytes : null;
}

function drawWrapped(page, text, font, size, x, y, maxWidth, lineHeight, color) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
    if (line) { page.drawText(line, { x, y, size, font, color }); y -= lineHeight; }
    line = word;
  }
  if (line) { page.drawText(line, { x, y, size, font, color }); y -= lineHeight; }
  return y;
}

function hexColor(value) {
  const match = String(value || "").match(/^#?([0-9a-f]{6})$/i);
  const hex = match?.[1] || "6e50d7";
  return rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
}

async function ensureTables(env) {
  if (tablesReady) return;
  await getPool(env).query(`
    CREATE TABLE IF NOT EXISTS market_agent_project_assets (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT NOT NULL,
      source_kind TEXT NOT NULL, asset_kind TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '',
      size_bytes BIGINT NOT NULL DEFAULT 0, blob_path TEXT NOT NULL DEFAULT '', source_url TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'analyzing', tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      summary TEXT NOT NULL DEFAULT '', recommendation TEXT NOT NULL DEFAULT 'review', rationale TEXT NOT NULL DEFAULT '',
      suggested_changes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS market_agent_asset_proposals (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', rationale TEXT NOT NULL DEFAULT '',
      source_asset_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], status TEXT NOT NULL DEFAULT 'awaiting_approval',
      estimated_cost_cents INTEGER NOT NULL DEFAULT 15, approved_budget_cents INTEGER NOT NULL DEFAULT 0,
      actual_cost_cents INTEGER, blob_path TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  tablesReady = true;
}

function serializeAsset(row) {
  return {
    id: row.id, projectId: row.project_id, name: row.name, sourceKind: row.source_kind, kind: row.asset_kind,
    mimeType: row.mime_type, sizeBytes: Number(row.size_bytes || 0), sourceUrl: row.source_url, detail: row.detail,
    status: row.status, tags: row.tags || [], summary: row.summary, recommendation: row.recommendation,
    rationale: row.rationale, suggestedChanges: row.suggested_changes || [], error: row.error,
    downloadable: Boolean(row.blob_path), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function serializeProposal(row) {
  return {
    id: row.id, projectId: row.project_id, kind: row.kind, title: row.title, description: row.description,
    rationale: row.rationale, sourceAssetIds: row.source_asset_ids || [], status: row.status,
    estimatedCostCents: Number(row.estimated_cost_cents || 0), approvedBudgetCents: Number(row.approved_budget_cents || 0),
    error: row.error, downloadable: Boolean(row.blob_path), approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function normalizeAssetKind(value) { return ["document", "image", "video"].includes(value) ? value : "document"; }
function cleanText(value) { return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/[^\x20-\x7E\xA0-\xFF]/g, "-").replace(/\s+/g, " ").trim(); }
function safeFilename(value) { return cleanText(value).replace(/[\\/:*?"<>|]/g, "-").slice(0, 160) || "download"; }
function safeError(error) { return String(error?.message || "Asset processing failed.").slice(0, 500); }
function requiredText(value, message, maxLength) { const text = String(value || "").trim(); if (!text) throw httpError(400, message); return text.slice(0, maxLength); }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }
