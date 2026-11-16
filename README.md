# Market Agent

Market Agent is a private, cloud-hosted, multi-project marketing workspace. Each project keeps its own Brand, research, campaigns, content, and automation schedule. The Brand covers segmentation, positioning, manifesto, and identity. LUMEN is one project and case study—not the identity of the application.

It starts empty on purpose. There are no fictional prospects, campaigns, replies, analytics, or user identities.

## What works

- Private email/password accounts with isolated workspaces for every user
- Cross-device Brand and generated-work persistence in Postgres
- Project creation and switching with isolated context, work history, and schedules
- Automatic Brand onboarding from PDF, PowerPoint, Word, text, images, video frames, Google Slides, Figma previews, and website links
- Editable visual identity with logo, colors, typography, imagery style, and brand guidance
- Live web research through OpenAI's hosted web-search tool
- Independent OpenAI, Gemini, and Claude analysis with a final balanced synthesis
- Market research, audience analysis, campaign, social-pack, and custom workflows
- Saved and editable drafts with approval states and source links
- Per-project Google Analytics connection with verified live GA4 reports
- Per-project Gmail, Mailchimp, LinkedIn, Instagram, TikTok, X, Discord, and Reddit authorization
- In-app newsletter drafting, branded HTML preview, consent-based subscriber registration, approved send/schedule, and live campaign reporting
- An exact, structured campaign queue created before approval—delivery never reinterprets approved prose
- Whole-campaign schedule approval, idempotent delivery, bounded retries, dead-letter recovery, and one-recipient direct email with opt-out suppression
- Live per-item, channel, campaign, and website performance fed back into the next agent cycle
- Optional daily autonomy at three trust levels: draft only, prepare for approval, or publish on explicitly trusted organic channels
- Email, paid media, TikTok, YouTube, Shopify, and Reddit remain separately gated even when trusted publishing is enabled
- A 10-day text-only demo with document analysis, campaign reasoning, and LinkedIn access
- A $29.99/month PayPal-managed text plan with server-enforced entitlements and usage limits
- A bring-your-own-API path for full capabilities, including image and video where supported
- Git-backed Vercel deployment; the owner computer does not need to stay on

Direct delivery is available only after the relevant account is connected and the required platform permission is present. Users can approve individual items, approve a complete dated campaign once, or explicitly grant standing permission for supported low-risk organic channels.

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
- `CRON_SECRET` — protects the manual fallback automation endpoint; production delivery uses private Vercel Schedules
- `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, and `ANTHROPIC_API_KEY` — platform-funded demo and managed text access; never a fallback for BYOK users
- `OPENAI_MODEL`, `GOOGLE_MODEL`, and `ANTHROPIC_MODEL` — optional model overrides
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `CONNECTION_ENCRYPTION_KEY` — Gmail and Google Analytics OAuth plus encrypted token storage
- `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` — LinkedIn OAuth and member posting
- `LINKEDIN_ORGANIZATION_ACCESS=true` — request approved Community Management scopes for per-project company-page selection; leave false until LinkedIn approves the app
- `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, and `INSTAGRAM_CONFIG_ID` — Instagram Unified Login and professional-account publishing
- `TIKTOK_CLIENT_KEY` and `TIKTOK_CLIENT_SECRET` — TikTok Login Kit and Content Posting API
- `X_CLIENT_ID` and `X_CLIENT_SECRET` — X OAuth 2.0 posting
- `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` — per-project authorization of a user-selected Discord channel webhook
- `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, and `REDDIT_USER_AGENT` — per-user Reddit authorization, community selection, rule checks, and approved text posts
- `MAILCHIMP_CLIENT_ID` and `MAILCHIMP_CLIENT_SECRET` — per-user Mailchimp OAuth for audiences, newsletters, subscribers, and campaign reports
- `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, and `PAYPAL_PLAN_ID` — $29.99 monthly subscription checkout
- `PAYPAL_WEBHOOK_ID` — signature-verified subscription lifecycle updates
- `PAYPAL_ENVIRONMENT` — `sandbox` while testing; set to `live` only for the production PayPal app and plan

The Google Cloud project must enable Gmail API, Google Analytics Admin API, and Google Analytics Data API. Add these production redirect URIs to the Google OAuth client:

- `https://www.marketagent.shop/api/google-callback`
- `https://www.marketagent.shop/api/google-analytics-callback`

Each social developer app must likewise register `https://www.marketagent.shop/api/social-callback` and obtain its required publishing scope.

The Mailchimp registered app must use `https://marketagent.shop/api/mailchimp-callback` as its OAuth redirect URI. Users authorize their own Mailchimp account; its plan limits and delivery charges remain on that user.

The PayPal app must send subscription webhooks to `https://www.marketagent.shop/api/paypal-webhook`. Subscribe to subscription activated, updated, suspended, cancelled, expired, and payment-failed events, plus subscription payment completed, refunded, and reversed events.

The one-time platform-owner setup is documented in [`docs/CONNECTOR_SETUP.md`](docs/CONNECTOR_SETUP.md). Ordinary users never need the developer credentials: they click Connect, authorize their own account, choose the relevant project destination, and approve each external action.

## Social publishing boundary

Content generation works. Direct publishing requires separate authorization and platform approval:

- LinkedIn: personal-profile posting through `w_member_social`; company-page posting additionally requires Community Management API approval
- Instagram: professional account and Meta/Instagram OAuth
- TikTok: OAuth, `video.publish`, and Content Posting API audit
- X: developer app, funded API access, and user OAuth
- Discord: OAuth `webhook.incoming`; the server administrator chooses the exact channel during connection
- Reddit: approved external Data API access, user OAuth, and a project community selected from the connected account

Publishing is behind an explicit item approval, one dated campaign approval, or a revocable standing permission for supported organic channels, with a database audit record. Email, newsletters, paid media, TikTok, YouTube, Shopify, and Reddit remain separately gated. A developer app without the platform's required product approval may authorize successfully but will not be shown as operational without its write scope.

## Architecture

- `src/CloudApp.tsx` — authentication boundary
- `src/OperationalApp.tsx` — workspace interface and workflows
- `server/auth.mjs` — Neon JWT verification and user authentication
- `server/db.mjs` — cloud persistence and migration helpers
- `server/agent.mjs` — direct OpenAI, Gemini, and Claude runtime
- `server/autonomy.mjs` — observe → plan → prepare/publish cycle using live performance
- `server/delivery.mjs` — exact campaign queue, approvals, scheduling, retries, receipts, and opt-out enforcement
- `server/growth.mjs` and `server/channel-analytics.mjs` — live outcome and per-item feedback loop
- `server/billing.mjs` — trial, PayPal subscription, entitlement, and shared-key usage enforcement
- `api/` — Vercel Functions for state, agent cycles, connectors, delivery, and private schedules
- `server/migrations/` — ordered, checksummed database migrations with an applied-migration ledger
- `test/` and `.github/workflows/ci.yml` — safety regression tests and CI build checks
