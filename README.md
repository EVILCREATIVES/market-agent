# Market Agent

Market Agent is a private, cloud-hosted, multi-project marketing workspace. Each project keeps its own product brain, research, campaigns, content, and automation schedule. The system stores real project context in Neon Postgres, uses Neon managed authentication, performs live market research through the OpenAI Responses API, asks OpenAI, Gemini, and Claude for independent analyses, and saves a balanced synthesis for review. LUMEN is one project and case study—not the identity of the application.

It starts empty on purpose. There are no fictional prospects, campaigns, replies, analytics, or user identities.

## What works

- Private email/password accounts with isolated workspaces for every user
- Cross-device product brain and generated-work persistence in Postgres
- Project creation and switching with isolated context, work history, and schedules
- Automatic product-brain onboarding from PDF, PowerPoint, Word, text, images, video frames, Google Slides, Figma previews, and website links
- Editable visual identity with logo, colors, typography, imagery style, and brand guidance
- Live web research through OpenAI's hosted web-search tool
- Independent OpenAI, Gemini, and Claude analysis with a final balanced synthesis
- Market research, audience analysis, campaign, social-pack, and custom workflows
- Saved and editable drafts with approval states and source links
- Optional daily cloud automation that creates a draft without publishing it
- Gitless Vercel deployment; the owner computer does not need to stay on

Direct social publishing remains off until the relevant social accounts are connected and authorized.

## Local development

The project is already linked to Vercel and Neon. Pull the current cloud variables, migrate the database, and start the app:

```bash
vercel env pull .env.local
npm run db:migrate
npm run dev
```

Open `http://127.0.0.1:4173`.

## Cloud deployment

```bash
npm run build
vercel deploy --prod
```

The application calls each AI provider directly. Add all three keys as encrypted Production environment variables in Vercel, then redeploy.

## Required environment

- `DATABASE_URL` — injected by the Neon Marketplace integration
- `NEON_AUTH_BASE_URL` and `VITE_NEON_AUTH_URL` — injected by Neon Auth
- `CRON_SECRET` — protects the daily automation endpoint
- `OPENAI_API_KEY` — OpenAI generation, research, and synthesis
- `GOOGLE_GENERATIVE_AI_API_KEY` — Gemini's independent panel analysis
- `ANTHROPIC_API_KEY` — Claude's independent panel analysis
- `OPENAI_MODEL`, `GOOGLE_MODEL`, and `ANTHROPIC_MODEL` — optional model overrides

## Social publishing boundary

Content generation works. Direct publishing requires separate authorization and platform approval:

- LinkedIn: OAuth and Community Management API approval
- Instagram: professional account and Meta/Instagram OAuth
- TikTok: OAuth, `video.publish`, and Content Posting API audit
- X: developer app, funded API access, and user OAuth

Publishing should remain behind explicit approval and a complete audit trail.

## Architecture

- `src/CloudApp.tsx` — authentication boundary
- `src/OperationalApp.tsx` — workspace interface and workflows
- `server/auth.mjs` — Neon JWT verification and user authentication
- `server/db.mjs` — cloud persistence and migration helpers
- `server/agent.mjs` — direct OpenAI, Gemini, and Claude runtime
- `api/` — Vercel Functions for state, AI runs, health, and daily automation
- `server/migrations/` — versioned database schema
