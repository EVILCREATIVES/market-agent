# Connector launch checklist

This is the one-time setup for the Market Agent platform owner. It is not an end-user onboarding checklist. After these apps are registered, every signed-in user connects and authorizes their own accounts from Market Agent.

Production base URL: `https://market-agent-lime-gamma.vercel.app`

## Cost boundary

- Social, email, newsletter, and analytics authorizations belong to the signed-in user and selected project.
- Each user supplies their own private API credential for image or video creation. Provider usage is therefore charged to that user's provider account, never to the platform owner's API account.
- Demo and $29.99 managed access are text-only. Platform credentials cannot be used for customer image or video generation.
- Each user chooses an account-wide monthly creative-production approval limit. Every media item also requires a separate approval for the displayed estimate before generation begins.
- Setting the approval limit to `$0` disables all paid media generation for that user.
- This is an application-side guard based on estimated provider usage, not a provider-issued billing cap. Provider invoices can differ, so users should also configure a billing limit in their provider account when that provider offers one.
- PayPal subscription receipts go to the platform owner's PayPal business account. This is income, not a provider cost passed through to end users.

## Redirects and server variables

| Provider | Production redirect or webhook | Vercel server variables |
| --- | --- | --- |
| Google | `/api/google-callback` and `/api/google-analytics-callback` | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` |
| LinkedIn | `/api/social-callback` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| Instagram | `/api/social-callback` | `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET` |
| TikTok | `/api/social-callback` | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` |
| X | `/api/social-callback` | `X_CLIENT_ID`, `X_CLIENT_SECRET` |
| Discord | `/api/social-callback` | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` |
| Reddit | `/api/social-callback` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` |
| Mailchimp | `/api/mailchimp-callback` | `MAILCHIMP_CLIENT_ID`, `MAILCHIMP_CLIENT_SECRET` |
| PayPal | `/api/paypal-webhook` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_PLAN_ID`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_ENVIRONMENT` |

Use the full production origin before each path. Keep every secret server-only in Vercel; never put it in a variable whose name begins with `VITE_`.

## Already configured

- Google: enable Gmail API, Google Analytics Admin API, and Google Analytics Data API. The app requests send-only Gmail access and read-only Analytics access. Each user signs into their own Google account and selects their own property.
- LinkedIn: enable Sign In with LinkedIn using OpenID Connect and Share on LinkedIn. Personal posting uses `w_member_social`; organization posting must remain unavailable unless LinkedIn separately approves the required organization products and the user is an authorized page administrator.

## Requires platform-owner approval

### Instagram

1. Create a Meta app and add Instagram API with Instagram Login.
2. Register the full social callback URL.
3. Request `instagram_business_basic` and `instagram_business_content_publish`.
4. Complete Meta's business verification and app review before inviting general users.
5. Add the app ID and secret to Vercel, then redeploy.

The user must connect an Instagram professional account. Market Agent publishes only after that user approves the individual image or Reel.

### TikTok

1. Create a TikTok developer app and add Login Kit and Content Posting API.
2. Register the full social callback URL and request `user.info.basic` and `video.publish`.
3. Complete the Content Posting API audit. Unaudited clients are restricted by TikTok and are not production-ready.
4. Verify the Market Agent URL prefix required for photo publishing when TikTok supplies the verification file. Video publishing uses direct file upload and does not need a public media URL.
5. Add the client key and secret to Vercel, then redeploy.

Market Agent reads the connected creator's current visibility and interaction choices before showing the final approval. It does not silently choose another visibility.

### X

1. Create an X developer project and OAuth 2.0 web app.
2. Register the full social callback URL.
3. Enable read and write access. The app requests `tweet.read`, `tweet.write`, `users.read`, `media.write`, and `offline.access`.
4. Confirm the X API plan and limits in the developer portal. Any X platform fees belong to the Market Agent platform account unless the commercial model explicitly passes them through; do not describe X publishing as cost-free.
5. Add the client ID and secret to Vercel, then redeploy.

### Mailchimp

1. Register an OAuth application in Mailchimp.
2. Register the full Mailchimp callback URL.
3. Add the client ID and secret to Vercel, then redeploy.

Each user authorizes their own Mailchimp account and selects an audience for each project. Subscriber consent, Mailchimp plan limits, and Mailchimp delivery charges stay with that user's Mailchimp account.

### Discord

1. Create a Discord application and add the full social callback URL under OAuth2 redirects.
2. No personal-account automation and no password are used. Market Agent requests `identify`, `guilds`, and `webhook.incoming`.
3. Add the client ID and secret to Vercel, then redeploy.

During connection, a server administrator chooses the exact server channel. The resulting webhook is encrypted and isolated to that Market Agent user and project. This first version is publish-only and keeps every message behind item-level approval; reading and responding to member messages requires a separately reviewed Discord bot with message-content access.

### Reddit

1. Request and obtain external Reddit Data API access under Reddit's Responsible Builder requirements.
2. Register an OAuth web application with the full social callback URL.
3. Add the client ID, secret, and an accurate Reddit user-agent string to Vercel, then redeploy.
4. Register the app with Reddit's current app-registration program and plan migration as Reddit's platform requirements evolve.

Each user authorizes their own Reddit account and selects one eligible community for each project. Market Agent reads the current community rules before preparing a queue item and publishes only after item-level approval. It never votes, follows users, or generates covert personal endorsements.

### PayPal

1. Create a PayPal business developer app, first in Sandbox.
2. Create the `$29.99/month` subscription product and plan.
3. Register the full webhook URL and subscribe to subscription activation, update, suspension, cancellation, expiration, and payment-failure events, plus completed, refunded, and reversed subscription payments.
4. Add the Sandbox credentials, plan ID, webhook ID, and `PAYPAL_ENVIRONMENT=sandbox` to Vercel; redeploy and complete a full test subscription.
5. Repeat with the Live app and Live plan before changing `PAYPAL_ENVIRONMENT=live`.

## End-to-end acceptance test

For each connector:

1. Sign in as a normal test user, not the platform owner.
2. Connect the user's provider account from one project.
3. Confirm a second user and a second project cannot see that connection.
4. Prepare an external action and verify that nothing is sent or published before item-level approval.
5. Approve the test item and verify the provider's real result and Market Agent's status or analytics.
6. Disconnect the provider and verify that future delivery is blocked.

Never share a password, one-time code, access token, client secret, or private API key in chat. Enter secrets only in the provider portal, Vercel, or Market Agent's encrypted connection screen.
