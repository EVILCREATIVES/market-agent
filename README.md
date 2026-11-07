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
- Per-project Google Analytics connection with verified live GA4 reports
- Per-project Gmail, Mailchimp, LinkedIn, Instagram, TikTok, and X authorization
- In-app newsletter drafting, branded HTML preview, consent-based subscriber registration, approved send/schedule, and live campaign reporting
- A server-backed delivery queue with an explicit approval before every real send or publish action
- Optional daily cloud automation that creates a draft without publishing it
- A 10-day text-only demo with document analysis, campaign reasoning, and LinkedIn access
- A $29.99/month PayPal-managed text plan with server-enforced entitlements and usage limits
- A bring-your-own-API path for full capabilities, including image and video where supported
- Gitless Vercel deployment; the owner computer does not need to stay on

Direct delivery is available only after the relevant account is connected, the required platform permission is present, the saved work is approved, and the user approves the individual queue item.

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

The deployment's three AI keys fund only the limited demo and active managed subscriptions. Users who connect their own APIs run exclusively on their encrypted account-level credentials. Managed and demo access is text-only; media generation is available only through a user's own APIs.

## Required environment

- `DATABASE_URL` — injected by the Neon Marketplace integration
- `NEON_AUTH_BASE_URL` and `VITE_NEON_AUTH_URL` — injected by Neon Auth
- `CRON_SECRET` — protects the daily automation endpoint
- `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, and `ANTHROPIC_API_KEY` — platform-funded demo and managed text access; never a fallback for BYOK users
- `OPENAI_MODEL`, `GOOGLE_MODEL`, and `ANTHROPIC_MODEL` — optional model overrides
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `CONNECTION_ENCRYPTION_KEY` — Gmail and Google Analytics OAuth plus encrypted token storage
- `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` — LinkedIn OAuth and posting
- `INSTAGRAM_APP_ID` and `INSTAGRAM_APP_SECRET` — Instagram professional-account OAuth and publishing
- `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` — TikTok Login Kit and Content Posting API
- `X_CLIENT_ID` and `X_CLIENT_SECRET` — X OAuth 2.0 posting
- `MAILCHIMP_CLIENT_ID` and `MAILCHIMP_CLIENT_SECRET` — per-user Mailchimp OAuth for audiences, newsletters, subscribers, and campaign reports
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_PLAN_ID` — $29.99 monthly subscription checkout
- `PAYPAL_WEBHOOK_ID` — signature-verified subscription lifecycle updates
- `PAYPAL_ENVIRONMENT` — `sandbox` while testing; set to `live` only for the production PayPal app and plan

The Google Cloud project must enable Gmail API, Google Analytics Admin API, and Google Analytics Data API. Add these production redirect URIs to the Google OAuth client:

- `https://market-agent-lime-gamma.vercel.app/api/google-callback`
- `https://market-agent-lime-gamma.vercel.app/api/google-analytics-callback`

Each social developer app must likewise register `https://market-agent-lime-gamma.vercel.app/api/social-callback` and obtain its required publishing scope.

The Mailchimp registered app must use `https://market-agent-lime-gamma.vercel.app/api/mailchimp-callback` as its OAuth redirect URI. Users authorize their own Mailchimp account; its plan limits and delivery charges remain on that user.

The PayPal app must send subscription webhooks to `https://market-agent-lime-gamma.vercel.app/api/paypal-webhook`. Subscribe to subscription activated, updated, suspended, cancelled, expired, and payment-failed events, plus subscription payment completed, refunded, and reversed events.

## Social publishing boundary

Content generation works. Direct publishing requires separate authorization and platform approval:

- LinkedIn: personal-profile posting through `w_member_social`; company-page posting additionally requires Community Management API approval
- Instagram: professional account and Meta/Instagram OAuth
- TikTok: OAuth, `video.publish`, and Content Posting API audit
- X: developer app, funded API access, and user OAuth

Publishing is behind explicit per-item approval and a database audit record. A developer app without the platform's required product approval may authorize successfully but will not be shown as operational without its write scope.

## Architecture

- `src/CloudApp.tsx` — authentication boundary
- `src/OperationalApp.tsx` — workspace interface and workflows
- `server/auth.mjs` — Neon JWT verification and user authentication
- `server/db.mjs` — cloud persistence and migration helpers
- `server/agent.mjs` — direct OpenAI, Gemini, and Claude runtime
- `server/billing.mjs` — trial, PayPal subscription, entitlement, and shared-key usage enforcement
- `api/` — Vercel Functions for state, AI runs, health, and daily automation
- `server/migrations/` — versioned database schema
