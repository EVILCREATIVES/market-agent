import { Readable } from "node:stream";
import { readDeliveryMedia } from "../server/delivery.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).send("Method not allowed");
  try {
    const { mediaUrl, mediaKind } = await readDeliveryMedia(req.query?.token);
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(mediaUrl, { headers, redirect: "follow" });
    if (!upstream.ok || !upstream.body) return res.status(upstream.status || 502).send("Media unavailable");
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || (mediaKind === "video" ? "video/mp4" : "image/jpeg"));
    for (const name of ["content-length", "content-range", "accept-ranges"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.method === "HEAD") {
      await upstream.body.cancel().catch(() => undefined);
      return res.end();
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    return res.status(error.statusCode || 404).send(error.message || "Media unavailable");
  }
}
