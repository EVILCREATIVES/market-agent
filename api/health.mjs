export default function handler(_req, res) {
  res.status(200).json({
    ok: true,
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    authConfigured: Boolean(process.env.NEON_AUTH_BASE_URL),
    analyticsConfigured: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.CONNECTION_ENCRYPTION_KEY),
    runtime: "Secure cloud runtime",
    persistence: "cloud-postgres",
  });
}
