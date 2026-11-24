const BLOCKED_ELEMENTS = /<\s*(?:script|foreignObject|iframe|object|embed|audio|video|link|meta)\b/i;
const EVENT_ATTRIBUTE = /\son[a-z][\w:.-]*\s*=/i;
const ACTIVE_CONTENT = /(?:javascript\s*:|vbscript\s*:|data\s*:\s*text\/html|expression\s*\(|@import\b)/i;
const DOCUMENT_DECLARATION = /<!\s*(?:DOCTYPE|ENTITY)\b/i;

export function svgMarkupSafetyError(markup) {
  const source = String(markup || "");
  const opening = source.replace(/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)*/i, "");
  if (!/^<svg\b/i.test(opening)) return "The file is not a valid standalone SVG.";
  if (DOCUMENT_DECLARATION.test(source)) return "SVG document declarations are not allowed.";
  if (BLOCKED_ELEMENTS.test(source)) return "The SVG contains active embedded content.";
  if (EVENT_ATTRIBUTE.test(source)) return "The SVG contains executable event attributes.";
  if (ACTIVE_CONTENT.test(source)) return "The SVG contains an unsafe script or external style reference.";

  for (const match of source.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)) {
    const value = match[2].trim();
    if (/^#[A-Za-z_][\w:.-]*$/.test(value)) continue;
    if (/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value)) continue;
    return "The SVG contains an external resource reference.";
  }
  for (const match of source.matchAll(/url\s*\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    if (!/^#[A-Za-z_][\w:.-]*$/.test(match[2].trim())) return "The SVG contains an external resource reference.";
  }
  return "";
}

export function assertSafeSvgMarkup(markup) {
  const error = svgMarkupSafetyError(markup);
  if (!error) return;
  const unsafe = new Error(error);
  unsafe.statusCode = 400;
  throw unsafe;
}

export function isSvgAsset(name, mimeType) {
  return String(mimeType || "").toLowerCase().split(";", 1)[0].trim() === "image/svg+xml"
    || String(name || "").toLowerCase().endsWith(".svg");
}
