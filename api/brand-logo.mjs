import { Readable } from "node:stream";
import { requireUser } from "../server/auth.mjs";
import { createBrandLogoAccessUrl, getBrandLogo } from "../server/brand-logos.mjs";

export default async function handler(req, res) {
  try {
    if (req.method === "POST") {
      const { userId } = await requireUser(req);
      const projectId = String(req.body?.projectId || "").trim().slice(0, 200);
      const pathname = String(req.body?.pathname || "").trim();
      if (!projectId || !pathname) return res.status(400).json({ error: "Project and logo upload are required." });
      const origin = `${String(req.headers["x-forwarded-proto"] || "https").split(",")[0]}://${String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0]}`;
      return res.status(200).json({ url: createBrandLogoAccessUrl({ userId, projectId, pathname, origin }) });
    }
    if (req.method === "GET") {
      const result = await getBrandLogo(req.query?.token, req.headers["if-none-match"] || "");
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (result.blob?.etag) res.setHeader("ETag", result.blob.etag);
      if (result.statusCode === 304) return res.status(304).end();
      res.setHeader("Content-Type", result.blob.contentType);
      return Readable.fromWeb(result.stream).pipe(res);
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.message || "The logo could not be read." });
  }
}
