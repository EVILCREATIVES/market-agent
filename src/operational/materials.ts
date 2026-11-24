import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export type MaterialKind = "document" | "image" | "video";

export interface PreparedMaterial {
  name: string;
  kind: MaterialKind;
  mimeType: string;
  text: string;
  images: string[];
  detail: string;
  typographySystems?: PreparedTypographySystem[];
}

export interface PreparedTypographySystem {
  source: "deck" | "document";
  sourceLabel: string;
  usage: string;
  families: string[];
  sample: string;
  verified: boolean;
}

const MAX_FILE_BYTES = 150 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;
const MAX_SVG_BYTES = 10 * 1024 * 1024;
const SVG_MIME_TYPE = "image/svg+xml";

export function isSvgFile(file: Pick<File, "name" | "type">) {
  return file.type.toLowerCase() === SVG_MIME_TYPE || file.name.toLowerCase().endsWith(".svg");
}

export async function prepareFileForUpload(file: File) {
  if (!isSvgFile(file)) return file;
  if (file.size > MAX_SVG_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);
  const svg = sanitizeSvgMarkup(await file.text());
  return new File([svg], file.name, { type: SVG_MIME_TYPE, lastModified: file.lastModified });
}

export async function prepareMaterial(file: File): Promise<PreparedMaterial> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 150 MB.`);
  const extension = file.name.split(".").pop()?.toLowerCase() || "";

  if (file.type === "application/pdf" || extension === "pdf") return preparePdf(file);
  if (extension === "pptx") return prepareZipDocument(file, "presentation");
  if (extension === "docx") return prepareZipDocument(file, "document");
  if (isSvgFile(file)) return prepareSvg(file);
  if (file.type.startsWith("image/")) return prepareImage(file);
  if (file.type.startsWith("video/")) return prepareVideo(file);
  if (["txt", "md", "csv", "rtf"].includes(extension) || file.type.startsWith("text/")) {
    const text = (await file.text()).slice(0, MAX_TEXT_CHARS);
    return { name: file.name, kind: "document", mimeType: file.type || "text/plain", text, images: [], detail: `${text.length.toLocaleString()} characters read` };
  }

  throw new Error(`${file.name} is not supported yet. Use PDF, PPTX, DOCX, text, SVG, image, or video.`);
}

export async function prepareLogo(file: File) {
  if (!file.type.startsWith("image/") && !isSvgFile(file)) throw new Error("Choose an image or SVG file for the logo.");
  if (file.size > 20 * 1024 * 1024) throw new Error("The logo file is larger than 20 MB.");
  if (isSvgFile(file)) {
    const svg = sanitizeSvgMarkup(await file.text());
    return renderSvg(svg, 1200, "image/png");
  }
  return resizeLogo(file, 1200);
}

async function preparePdf(file: File): Promise<PreparedMaterial> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const document = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const textParts: string[] = [];
  const pageLimit = Math.min(document.numPages, 100);

  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (pageText) textParts.push(`Page ${pageNumber}\n${pageText}`);
    if (textParts.join("\n\n").length >= MAX_TEXT_CHARS) break;
  }

  const images: string[] = [];
  for (const pageIndex of representativeIndices(document.numPages, 8)) {
    const page = await document.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1.15 });
    const canvas = window.document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) continue;
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: context, canvas, viewport }).promise;
    images.push(canvas.toDataURL("image/jpeg", 0.68));
  }

  const text = textParts.join("\n\n").slice(0, MAX_TEXT_CHARS);
  return {
    name: file.name,
    kind: "document",
    mimeType: "application/pdf",
    text,
    images,
    detail: `${document.numPages} pages read`,
  };
}

async function prepareZipDocument(file: File, type: "presentation" | "document"): Promise<PreparedMaterial> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const isPresentation = type === "presentation";
  const pattern = isPresentation ? /^ppt\/slides\/slide\d+\.xml$/ : /^word\/document\.xml$/;
  const entries = Object.keys(zip.files).filter((name) => pattern.test(name)).sort(numericNameSort);
  const textParts: string[] = [];
  const deckFonts = new Set<string>();

  for (const [index, name] of entries.entries()) {
    const xml = await zip.file(name)?.async("text");
    if (!xml) continue;
    if (isPresentation) for (const family of extractOfficeTypefaceNames(xml)) deckFonts.add(family);
    const text = extractXmlText(xml);
    if (text) textParts.push(isPresentation ? `Slide ${index + 1}\n${text}` : text);
  }

  if (isPresentation && deckFonts.size) textParts.unshift(`VERIFIED TYPOGRAPHY — UPLOADED DECK\nSource: ${file.name}\nEvidence: typefaces explicitly assigned in slide content (theme-only and fallback fonts excluded).\nFont families: ${[...deckFonts].join(", ")}`);

  const mediaPattern = isPresentation ? /^ppt\/media\// : /^word\/media\//;
  const mediaNames = Object.keys(zip.files).filter((name) => mediaPattern.test(name) && !zip.files[name].dir).slice(0, 10);
  const images: string[] = [];
  for (const name of mediaNames) {
    const mimeType = mimeFromName(name);
    if (!mimeType.startsWith("image/")) continue;
    const bytes = await zip.file(name)?.async("uint8array");
    if (!bytes) continue;
    try {
      const copy = Uint8Array.from(bytes);
      if (mimeType === SVG_MIME_TYPE) {
        const svg = sanitizeSvgMarkup(new TextDecoder().decode(copy));
        images.push(await renderSvg(svg, 1400, "image/png"));
      } else {
        images.push(await resizeImage(new Blob([copy.buffer], { type: mimeType }), 1400, 0.72));
      }
    } catch {
      // Some embedded formats are not browser-decodable; the document text is still usable.
    }
    if (images.length >= 8) break;
  }

  const text = textParts.join("\n\n").slice(0, MAX_TEXT_CHARS);
  return {
    name: file.name,
    kind: "document",
    mimeType: file.type || (isPresentation ? "application/vnd.openxmlformats-officedocument.presentationml.presentation" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    text,
    images,
    detail: isPresentation ? `${entries.length} slides read` : `${text.length.toLocaleString()} characters read`,
    typographySystems: isPresentation && deckFonts.size ? [{ source: "deck", sourceLabel: file.name, usage: "Typefaces explicitly used in slide content.", families: [...deckFonts], sample: "Research → Meaning → Identity → Story → Art", verified: true }] : [],
  };
}

async function prepareImage(file: File): Promise<PreparedMaterial> {
  const image = await resizeImage(file, 1800, 0.8);
  return { name: file.name, kind: "image", mimeType: "image/jpeg", text: "", images: [image], detail: "Image ready for analysis" };
}

async function prepareSvg(file: File): Promise<PreparedMaterial> {
  if (file.size > MAX_SVG_BYTES) throw new Error(`${file.name} is larger than 10 MB.`);
  const svg = sanitizeSvgMarkup(await file.text());
  const image = await renderSvg(svg, 1800, "image/png");
  return {
    name: file.name,
    kind: "image",
    mimeType: SVG_MIME_TYPE,
    text: extractSvgText(svg),
    images: [image],
    detail: "SVG vector artwork sanitized and rendered for analysis",
  };
}

async function prepareVideo(file: File): Promise<PreparedMaterial> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await once(video, "loadedmetadata");
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error(`Could not read ${file.name}.`);
    const images: string[] = [];
    const frameCount = Math.min(6, Math.max(3, Math.ceil(video.duration / 20)));
    for (let index = 0; index < frameCount; index += 1) {
      video.currentTime = Math.min(video.duration - 0.05, (video.duration * (index + 0.5)) / frameCount);
      await once(video, "seeked");
      const scale = Math.min(1, 1200 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      images.push(canvas.toDataURL("image/jpeg", 0.68));
    }
    return { name: file.name, kind: "video", mimeType: file.type || "video/mp4", text: "", images, detail: `${images.length} representative frames captured` };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function resizeImage(blob: Blob, maxDimension: number, quality: number) {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    bitmap.close();
  }
}

async function resizeLogo(blob: Blob, maxDimension: number) {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}

function sanitizeSvgMarkup(source: string) {
  const parsed = new DOMParser().parseFromString(String(source || ""), SVG_MIME_TYPE);
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName.toLowerCase() !== "svg") {
    throw new Error("The SVG file is not valid.");
  }
  const root = parsed.documentElement;
  root.querySelectorAll("script, foreignObject, iframe, object, embed, audio, video, link, meta").forEach((element) => element.remove());
  root.querySelectorAll("style").forEach((element) => {
    const safeCss = sanitizeSvgCss(element.textContent || "");
    if (safeCss.trim()) element.textContent = safeCss;
    else element.remove();
  });
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        if (!safeSvgReference(value)) element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        const safeStyle = sanitizeSvgCss(value);
        if (safeStyle.trim()) element.setAttribute(attribute.name, safeStyle);
        else element.removeAttribute(attribute.name);
        continue;
      }
      if (/url\s*\(/i.test(value) && !allSvgUrlsAreLocal(value)) element.removeAttribute(attribute.name);
    }
  }
  if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return new XMLSerializer().serializeToString(root);
}

function sanitizeSvgCss(value: string) {
  return String(value || "")
    .replace(/@import[\s\S]*?(?:;|$)/gi, "")
    .replace(/expression\s*\([^)]*\)/gi, "")
    .replace(/url\s*\(\s*(['"]?)(?!#)[^)]*\1\s*\)/gi, "")
    .replace(/javascript\s*:/gi, "");
}

function safeSvgReference(value: string) {
  return /^#[A-Za-z_][\w:.-]*$/.test(value)
    || /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=\s]+$/i.test(value);
}

function allSvgUrlsAreLocal(value: string) {
  const urls = [...value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/gi)].map((match) => match[2].trim());
  return urls.length > 0 && urls.every((url) => /^#[A-Za-z_][\w:.-]*$/.test(url));
}

async function renderSvg(svg: string, maxDimension: number, outputType: "image/png") {
  const url = URL.createObjectURL(new Blob([svg], { type: SVG_MIME_TYPE }));
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    await image.decode();
    const width = image.naturalWidth || 300;
    const height = image.naturalHeight || 150;
    if (!width || !height) throw new Error("The SVG has no visible dimensions.");
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The SVG preview could not be created.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(outputType);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function extractSvgText(svg: string) {
  const parsed = new DOMParser().parseFromString(svg, SVG_MIME_TYPE);
  return Array.from(parsed.querySelectorAll("title, desc, text"))
    .map((node) => node.textContent?.replace(/\s+/g, " ").trim() || "")
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_TEXT_CHARS);
}

function extractXmlText(xml: string) {
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(parsed.getElementsByTagNameNS("*", "t"))
    .map((node) => node.textContent?.trim() || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractOfficeTypefaceNames(xml: string) {
  const families = new Set<string>();
  for (const match of String(xml || "").matchAll(/\btypeface\s*=\s*["']([^"']+)["']/gi)) {
    const family = match[1].trim();
    if (!family || /^\+(?:mj|mn)-/i.test(family) || /^(none|inherit)$/i.test(family)) continue;
    families.add(family);
  }
  return [...families].slice(0, 12);
}

function representativeIndices(total: number, maximum: number) {
  if (total <= maximum) return Array.from({ length: total }, (_, index) => index);
  return Array.from(new Set(Array.from({ length: maximum }, (_, index) => Math.round((index * (total - 1)) / (maximum - 1)))));
}

function numericNameSort(left: string, right: string) {
  const leftNumber = Number(left.match(/(\d+)(?=\.xml$)/)?.[1] || 0);
  const rightNumber = Number(right.match(/(\d+)(?=\.xml$)/)?.[1] || 0);
  return leftNumber - rightNumber;
}

function mimeFromName(name: string) {
  const extension = name.split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml" } as Record<string, string>)[extension || ""] || "application/octet-stream";
}

function once(target: HTMLMediaElement, event: "loadedmetadata" | "seeked") {
  return new Promise<void>((resolve, reject) => {
    const onSuccess = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("The media file could not be read.")); };
    const cleanup = () => {
      target.removeEventListener(event, onSuccess);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(event, onSuccess, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}
