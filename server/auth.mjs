import { createRemoteJWKSet, jwtVerify } from "jose";
import { getPool } from "./db.mjs";

const keySets = new Map();

export async function requireUser(req, env = process.env) {
  const authorization = req.headers?.authorization || req.headers?.Authorization || "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    const error = new Error("Please sign in.");
    error.statusCode = 401;
    throw error;
  }

  if (!env.NEON_AUTH_BASE_URL) {
    const error = new Error("Authentication is not configured.");
    error.statusCode = 503;
    throw error;
  }

  const baseUrl = env.NEON_AUTH_BASE_URL.replace(/\/$/, "");
  const jwksUrl = env.NEON_AUTH_JWKS_URL || `${baseUrl}/.well-known/jwks.json`;
  let jwks = keySets.get(jwksUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUrl));
    keySets.set(jwksUrl, jwks);
  }

  let payload;
  try {
    ({ payload } = await jwtVerify(authorization.slice(7), jwks, {
      issuer: new URL(baseUrl).origin,
    }));
  } catch {
    const error = new Error("Your session expired. Please sign in again.");
    error.statusCode = 401;
    throw error;
  }

  if (!payload.sub) {
    const error = new Error("Unauthorized.");
    error.statusCode = 401;
    throw error;
  }

  const result = await getPool(env).query(
    'SELECT email FROM neon_auth."user" WHERE id = $1 LIMIT 1',
    [payload.sub],
  );
  const email = String(result.rows[0]?.email || payload.email || "").toLowerCase();
  return { userId: payload.sub, email };
}
