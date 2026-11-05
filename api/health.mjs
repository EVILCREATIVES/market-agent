export default function handler(_req, res) {
  const providers = {
    openAI: Boolean(process.env.OPENAI_API_KEY),
    gemini: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    claude: Boolean(process.env.ANTHROPIC_API_KEY),
  };
  res.status(200).json({
    ok: true,
    agentConfigured: providers.openAI && providers.gemini && providers.claude,
    providers,
    databaseConfigured: Boolean(process.env.DATABASE_URL),
    authConfigured: Boolean(process.env.NEON_AUTH_BASE_URL),
    analyticsConfigured: Boolean(process.env.GA_PROPERTY_ID),
    model: "Balanced analysis",
    runtime: "Secure cloud runtime",
    persistence: "cloud-postgres",
  });
}
