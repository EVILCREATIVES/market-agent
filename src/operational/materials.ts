import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

export type MaterialKind = "document" | "image" | "video";

export interface PreparedMaterial {
  name: string;
  kind: MaterialKind;
  mimeType: string;
  text: string;
  images: string[];
  detail: string;
}

const MAX_FILE_BYTES = 150 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;

export async function prepareMaterial(file: File): Promise<PreparedMaterial> {
  if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than 150 MB.`);
  const extension = file.name.split(".").pop()?.toLowerCase() || "";

  if (file.type === "application/pdf" || extension === "pdf") return preparePdf(file);
  if (extension === "pptx") return prepareZipDocument(file, "presentation");
  if (extension === "docx") return prepareZipDocument(file, "document");
  if (file.type.startsWith("image/")) return prepareImage(file);
  if (file.type.startsWith("video/")) return prepareVideo(file);
  if (["txt", "md", "csv", "rtf"].includes(extension) || file.type.startsWith("text/")) {
    const text = (await file.text()).slice(0, MAX_TEXT_CHARS);
    return { name: file.name, kind: "document", mimeType: file.type || "text/plain", text, images: [], detail: `${text.length.toLocaleString()} characters read` };
  }

  throw new Error(`${file.name} is not supported yet. Use PDF, PPTX, DOCX, text, image, or video.`);
}

export async function prepareLogo(file: File) {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file for the logo.");
  if (file.size > 20 * 1024 * 1024) throw new Error("The logo file is larger than 20 MB.");
  return resizeImage(file, 900, 0.86);
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

  for (const [index, name] of entries.entries()) {
    const xml = await zip.file(name)?.async("text");
    if (!xml) continue;
    const text = extractXmlText(xml);
    if (text) textParts.push(isPresentation ? `Slide ${index + 1}\n${text}` : text);
  }

  const mediaPattern = isPresentation ? /^ppt\/media\// : /^word\/media\//;
  const mediaNames = Object.keys(zip.files).filter((name) => mediaPattern.test(name) && !zip.files[name].dir).slice(0, 10);
  const images: string[] = [];
  for (const name of mediaNames) {
    const mimeType = mimeFromName(name);
    if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml") continue;
    const bytes = await zip.file(name)?.async("uint8array");
    if (!bytes) continue;
    try {
      const copy = Uint8Array.from(bytes);
      images.push(await resizeImage(new Blob([copy.buffer], { type: mimeType }), 1400, 0.72));
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
  };
}

async function prepareImage(file: File): Promise<PreparedMaterial> {
  const image = await resizeImage(file, 1800, 0.8);
  return { name: file.name, kind: "image", mimeType: "image/jpeg", text: "", images: [image], detail: "Image ready for analysis" };
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

function extractXmlText(xml: string) {
  const parsed = new DOMParser().parseFromString(xml, "application/xml");
  return Array.from(parsed.getElementsByTagNameNS("*", "t"))
    .map((node) => node.textContent?.trim() || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
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
