import { createHmac, timingSafeEqual } from "node:crypto";
import { get } from "@vercel/blob";

export function createBrandLogoAccessUrl({ userId, projectId, pathname, origin }, env = process.env) {
  const expectedPrefix = `market-agent-assets/${encodeURIComponent(userId)}/${encodeURIComponent(projectId)}/brand-logos/`;
  const safePathname = String(pathname || "");
  if (!safePathname.startsWith(expectedPrefix)) throw brandLogoError("The logo upload destination is invalid.", 400);
  const payload = Buffer.from(JSON.stringify({ p: safePathname }), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey(env)).update(payload).digest("base64url");
  return `${brandLogoOrigin(origin, env)}/api/brand-logo?token=${encodeURIComponent(`${payload}.${signature}`)}`;
}

export async function getBrandLogo(token, ifNoneMatch = "", env = process.env) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) throw brandLogoError("Invalid logo link.", 401);
  const expected = createHmac("sha256", signingKey(env)).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) throw brandLogoError("Invalid logo link.", 401);
  let pathname = "";
  try { pathname = String(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.p || ""); } catch { throw brandLogoError("Invalid logo link.", 401); }
  if (!pathname.startsWith("market-agent-assets/") || !pathname.includes("/brand-logos/")) throw brandLogoError("Invalid logo link.", 401);
  const result = await get(pathname, { access: "private", ifNoneMatch: ifNoneMatch || undefined });
  if (!result) throw brandLogoError("Logo not found.", 404);
  if (result.statusCode === 304) return result;
  if (result.statusCode !== 200 || !String(result.blob?.contentType || "").startsWith("image/")) throw brandLogoError("Logo not found.", 404);
  return result;
}

function brandLogoOrigin(requestOrigin, env) {
  const value = String(env.APP_BASE_URL || env.MAILCHIMP_REDIRECT_BASE_URL || requestOrigin || "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(value)) throw brandLogoError("The application URL is not configured.", 503);
  return value;
}

function signingKey(env) {
  const value = String(env.BRAND_ASSET_SIGNING_SECRET || env.CONNECTION_ENCRYPTION_KEY || "");
  if (value.length < 24) throw brandLogoError("Secure logo links are not configured.", 503);
  return value;
}

function brandLogoError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
