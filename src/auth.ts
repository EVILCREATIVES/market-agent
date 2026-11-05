import { createInternalNeonAuth } from "@neon/auth";
import { BetterAuthReactAdapter } from "@neon/auth/react/adapters";

export const authUrl = import.meta.env.VITE_NEON_AUTH_URL || "";

const neonAuth = createInternalNeonAuth(authUrl || "http://127.0.0.1:8787/auth", {
  adapter: BetterAuthReactAdapter(),
});
export const authClient = neonAuth.adapter;

export async function getAccessToken() {
  const token = await neonAuth.getJWTToken();
  if (!token) throw new Error("Please sign in again.");
  return token;
}

export async function apiFetch(path: string, init: RequestInit = {}) {
  const token = await getAccessToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  return response;
}
