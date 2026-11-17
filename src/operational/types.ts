export type AgentAction = "research" | "campaign" | "social" | "audience" | "chat";
export type RunStatus = "Draft" | "Approved";

export interface ProductSource {
  id: string;
  label: string;
  url: string;
}

export interface ProductMaterial {
  id: string;
  name: string;
  kind: "document" | "image" | "video";
  addedAt: string;
  assetId?: string;
  summary?: string;
  tags?: string[];
  routingRationale?: string;
}

export interface SourceMediaAsset {
  id: string;
  kind: "image" | "video";
  name: string;
  url: string;
  role: string;
  tags: string[];
  recommendation: "reuse" | "adapt" | "review";
}

export interface BrandIdentity {
  logoDataUrl: string;
  logoName: string;
  logoVariants: BrandLogoVariant[];
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  neutralLightColor: string;
  neutralDarkColor: string;
  typography: string;
  fontFamilies: string[];
  fontSources: BrandFontSource[];
  typographySystems: BrandTypographySystem[];
  sourceTypographySystems: BrandTypographySystem[];
  lookAndFeel: string;
  photographyStyle: string;
  imageryStyle: string;
  notes: string;
}

export interface BrandLogoVariant {
  id: string;
  name: string;
  url: string;
  usage: "primary" | "email" | "light" | "dark" | "icon" | "other";
  createdAt: string;
}

export interface BrandTypographySystem {
  source: "website" | "deck" | "document" | "manual";
  sourceLabel: string;
  usage: string;
  families: string[];
  sample: string;
  verified: boolean;
}

export interface BrandFontSource {
  family: string;
  url: string;
  weight: string;
  style: string;
  format: string;
  source?: string;
  usage?: string;
}

export type GrowthObjective = "visibility" | "leads" | "sales" | "audience" | "newsletter";
export type PrimaryConversion = "contact_form" | "demo_request" | "newsletter_signup" | "purchase" | "reply" | "custom";

export interface ProjectGrowthPlan {
  objective: GrowthObjective | "";
  primaryConversion: PrimaryConversion | "";
  analyticsEvent: string;
  selectedBy: "assistant" | "user";
  rationale: string;
  targetValue: number;
  targetPeriodDays: number;
}

export interface ProductWorkspace {
  id: string;
  name: string;
  website: string;
  description: string;
  segmentation: string;
  positioning: string;
  manifesto: string;
  audience: string;
  valueProposition: string;
  voice: string;
  guardrails: string;
  notes: string;
  issueNotes: { high: string; attention: string; context: string };
  acceptedIssueNotes: string[];
  sourcePriority: "best-evidence" | "website" | "deck";
  sourceGuidance: string;
  sources: ProductSource[];
  materials: ProductMaterial[];
  sourceMedia: SourceMediaAsset[];
  brand: BrandIdentity;
  reviewSummary: string;
  openQuestions: string[];
  questionAnswers: Record<string, string>;
  additionalContextDraft: string;
  sourceWarnings: string[];
  protectedFields: string[];
  chatMessages: ProjectChatMessage[];
  emailIdentity: {
    senderName: string;
    businessDetails: string;
    physicalAddress: string;
    addressPreference: "ask" | "include" | "omit";
  };
  growth: ProjectGrowthPlan;
  updatedAt: string;
}

export interface ProjectChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: Array<{ id: string; name: string; kind: "document" | "image" | "video"; destinations: string[] }>;
  createdAt: string;
}

export interface RunAssetReference {
  id: string;
  name: string;
  kind: "document" | "image" | "video";
  summary: string;
  tags: string[];
  routingRationale: string;
}

export interface AgentRun {
  id: string;
  projectId: string;
  remoteId?: string;
  action: AgentAction;
  title: string;
  prompt: string;
  output: string;
  sources: Array<{ title: string; url: string }>;
  status: RunStatus;
  model: string;
  executionMode?: "single" | "panel";
  campaignPlan?: CampaignPlan | null;
  intensity?: CampaignIntensity;
  issueFindings?: {
    high: string[];
    attention: string[];
  };
  assetReferences?: RunAssetReference[];
  createdAt: string;
}

export interface CampaignPlan {
  items: Array<{
    channel: DeliveryJob["channel"];
    recipient: string;
    subject: string;
    text: string;
    mediaUrl: string;
    sourceAssetId?: string;
    mediaKind: "" | "image" | "video";
    privacyLevel: string;
    aiGenerated: boolean;
    scheduledAt: string;
    rationale: string;
  }>;
}

export type CampaignIntensity = "careful" | "assertive" | "aggressive";

export interface AppState {
  projects: ProductWorkspace[];
  activeProjectId: string;
  runs: AgentRun[];
  schedules: Record<string, AgentSchedule>;
}

export interface AgentSchedule {
  enabled: boolean;
  action: Exclude<AgentAction, "chat">;
  prompt: string;
  useWeb: boolean;
  autonomyLevel: "draft" | "prepare" | "publish";
  trustedChannels: Array<"linkedin" | "instagram" | "x" | "discord">;
  lastRunAt: string | null;
}

export interface HealthState {
  checked: boolean;
  apiOnline: boolean;
  agentConfigured: boolean;
  databaseConfigured: boolean;
  authConfigured: boolean;
  analyticsConfigured: boolean;
  mediaConfigured?: boolean;
  model: string;
  runtime: string;
}

export type ApiProvider = "openai" | "google" | "anthropic";

export interface ApiCredentialConnection {
  connected: boolean;
  hint: string;
  connectedAt: string | null;
  updatedAt: string | null;
}

export interface ApiCredentialStatus {
  ready: boolean;
  collaborationReady: boolean;
  mediaReady: boolean;
  videoReady: boolean;
  connectedCount: number;
  credentials: Record<ApiProvider, ApiCredentialConnection>;
}

export interface BillingStatus {
  checked: boolean;
  configured: boolean;
  paypalConfigured: boolean;
  platformApisConfigured: boolean;
  active: boolean;
  status: string;
  subscriptionId: string;
  payerEmail: string;
  planName: string;
  price: string;
  currency: string;
  mediaIncluded: boolean;
  collaborationReady: boolean;
  trial: {
    active: boolean;
    daysRemaining: number;
    endsAt: string;
  };
}

export type MediaJobStatus = "awaiting_budget" | "approved" | "running" | "complete" | "failed" | "cancelled";

export interface MediaJob {
  id: string;
  projectId: string;
  kind: "image" | "video";
  title: string;
  prompt: string;
  status: MediaJobStatus;
  aspectRatio: string;
  resolution: string;
  durationSeconds: number | null;
  estimatedCostCents: number;
  approvedBudgetCents: number;
  actualCostCents: number | null;
  currency: "USD";
  assetUrl: string;
  mimeType: string;
  error: string;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MediaBudgetSummary {
  monthlyCapCents: number;
  approvedThisMonthCents: number;
  actualThisMonthCents: number;
  billingOwner: "user";
}

export interface ProjectAsset {
  id: string;
  projectId: string;
  name: string;
  sourceKind: "upload" | "link";
  kind: "document" | "image" | "video" | "figma" | "link";
  mimeType: string;
  sizeBytes: number;
  sourceUrl: string;
  detail: string;
  status: "analyzing" | "ready" | "failed";
  tags: string[];
  summary: string;
  recommendation: "reuse" | "adapt" | "replace" | "archive" | "review";
  rationale: string;
  suggestedChanges: string[];
  error: string;
  downloadable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AssetProposal {
  id: string;
  projectId: string;
  kind: "pdf" | "deck";
  title: string;
  description: string;
  rationale: string;
  sourceAssetIds: string[];
  status: "awaiting_approval" | "approved" | "running" | "complete" | "failed" | "cancelled";
  estimatedCostCents: number;
  approvedBudgetCents: number;
  error: string;
  downloadable: boolean;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionStatus {
  analytics: AnalyticsConnectionStatus;
  mailchimp: MailchimpConnectionStatus;
  shopify: ShopifyConnectionStatus;
  gmail: {
    configured: boolean;
    connected: boolean;
    accountEmail: string;
    scopes: string[];
    connectedAt: string | null;
    canSend: boolean;
  };
  linkedin: SocialConnectionStatus;
  instagram: SocialConnectionStatus;
  tiktok: SocialConnectionStatus;
  youtube: SocialConnectionStatus;
  x: SocialConnectionStatus;
  discord: SocialConnectionStatus;
  reddit: SocialConnectionStatus;
}

export interface ShopifyConnectionStatus {
  configured: boolean;
  connected: boolean;
  storeDomain: string;
  storeName: string;
  scopes: string[];
  connectedAt: string | null;
  canManage: boolean;
}

export interface MailchimpConnectionStatus {
  configured: boolean;
  connected: boolean;
  accountLabel: string;
  accountEmail: string;
  audiences: Array<{ id: string; name: string; memberCount: number }>;
  audienceId: string;
  audienceName: string;
  connectedAt: string | null;
  canManage: boolean;
}

export interface NewsletterDraft {
  id: string;
  projectId: string;
  direction: string;
  content: {
    subject: string;
    previewText: string;
    headline: string;
    introduction: string;
    sections: Array<{ heading: string; body: string }>;
    ctaLabel: string;
    ctaUrl: string;
    closing: string;
    logoUrl: string;
    logoVariantId: string;
    logoHidden: boolean;
    heroImageUrl: string;
    heroImageAlt: string;
    senderName: string;
    businessDetails: string;
    physicalAddress: string;
    addressPreference: "ask" | "include" | "omit";
    issues: string[];
  };
  html: string;
  status: "draft" | "preparing" | "scheduled" | "sent" | "failed";
  externalId: string;
  archiveUrl: string;
  error: string;
  approvedAt: string | null;
  scheduledFor: string | null;
  sentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactImport {
  id: string;
  projectId: string;
  sourceName: string;
  status: "staged" | "importing" | "imported" | "partial" | "failed";
  columnMap: Record<string, string>;
  totalCount: number;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  consentedCount: number;
  unknownCount: number;
  deniedCount: number;
  importedCount: number;
  failedCount: number;
  importMode: "" | "confirmed" | "double-opt-in";
  error: string;
  preview: Array<{ email: string; firstName: string; lastName: string; company: string; consent: "confirmed" | "unknown" | "denied" }>;
  createdAt: string;
  updatedAt: string;
}

export interface NewsletterDashboard {
  audience: {
    id: string;
    name: string;
    memberCount: number;
    unsubscribeCount: number;
    cleanedCount: number;
    openRate: number;
    clickRate: number;
    signupUrl: string;
  };
  members: Array<{ id: string; email: string; firstName: string; lastName: string; status: string; confirmedAt: string | null }>;
  campaigns: Array<{
    id: string;
    title: string;
    subject: string;
    status: string;
    archiveUrl: string;
    sendTime: string | null;
    emailsSent: number;
    uniqueOpens: number;
    openRate: number;
    uniqueClicks: number;
    clickRate: number;
    unsubscribed: number;
    bounces: number;
  }>;
  drafts: NewsletterDraft[];
  contactImports: ContactImport[];
  conversionCampaigns: ProspectConversionCampaign[];
  prospectInvitationRecipientCount: number;
  subscriberRegistry: {
    counts: { total: number; pending: number; confirmed: number; unsubscribed: number; bounced: number };
    preview: NewsletterSubscriber[];
  };
  welcome: {
    enabled: boolean;
    subject: string;
    body: string;
    enabledAt: string | null;
  };
  fetchedAt: string;
}

export interface ProspectConversionCampaign {
  id: string;
  status: "active" | "paused";
  eyebrow: string;
  title: string;
  description: string;
  ctaLabel: string;
  privacyNote: string;
  promotionText: string;
  invitationSubject: string;
  invitationBody: string;
  publicUrl: string;
  invitation: {
    total: number;
    scheduled: number;
    sent: number;
    failed: number;
    cancelled: number;
    startsAt: string | null;
    endsAt: string | null;
  };
  views: number;
  ctaClicks: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewsletterSubscriber {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  status: "pending" | "confirmed" | "unsubscribed" | "bounced";
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  bouncedAt: string | null;
  welcomeStatus: "not_sent" | "sending" | "sent" | "failed";
  welcomeSentAt: string | null;
  updatedAt: string | null;
}

export interface AnalyticsConnectionStatus {
  configured: boolean;
  authorized: boolean;
  connected: boolean;
  accountEmail: string;
  propertyId: string;
  propertyName: string;
  properties: Array<{ id: string; name: string; account: string }>;
  connectedAt: string | null;
  canRead: boolean;
}

export interface SocialConnectionStatus {
  configured: boolean;
  connected: boolean;
  accountId: string;
  accountLabel: string;
  scopes: string[];
  connectedAt: string | null;
  canPublish: boolean;
  destinations?: Array<{ id: string; name: string; label: string }>;
  destinationId?: string;
  destinationName?: string;
  approvalRequired?: boolean;
  approvalStatus?: "pending_approval" | "approved";
}

export type DeliveryJobStatus = "awaiting_approval" | "scheduled" | "running" | "submitted" | "complete" | "failed" | "dead_letter" | "cancelled";

export interface DeliveryJob {
  id: string;
  projectId: string;
  runId: string;
  channel: "gmail" | "linkedin" | "instagram" | "tiktok" | "youtube" | "x" | "discord" | "reddit" | "shopify";
  payload: {
    recipient: string;
    subject: string;
    text: string;
    mediaUrl: string;
    mediaKind: "" | "image" | "video";
    sourceAssetId?: string;
    privacyLevel: string;
    aiGenerated: boolean;
    madeForKids: boolean;
    disableComment: boolean;
    disableDuet: boolean;
    disableStitch: boolean;
    commercialContentToggle: boolean;
    brandOrganicToggle: boolean;
    brandContentToggle: boolean;
    musicConsent: boolean;
    scheduledAt: string;
    campaignApprovalId?: string;
    tracking?: { url: string; campaignId: string; campaignName: string; source: string; medium: string; content: string } | null;
    rationale: string;
  };
  status: DeliveryJobStatus;
  externalId: string;
  result: Record<string, unknown>;
  error: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  approvedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TikTokPublishingOptions {
  id: string;
  provider: "tiktok";
  accountLabel: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoDurationSec: number;
}

export interface YouTubePublishingOptions {
  id: string;
  provider: "youtube";
  accountLabel: string;
  privacyLevelOptions: Array<"private" | "unlisted" | "public">;
}

export interface AnalyticsReport {
  propertyId: string;
  propertyName: string;
  range: string;
  totals: Record<string, number | null>;
  previousTotals: Record<string, number | null>;
  changes: Record<string, { current: number | null; previous: number | null; absolute: number | null; percent: number | null }>;
  timeline: Array<Record<string, string | number>>;
  channels: Array<Record<string, string | number>>;
  previousChannels: Array<Record<string, string | number>>;
  campaigns: Array<Record<string, string | number>>;
  previousCampaigns: Array<Record<string, string | number>>;
  campaignEvents: Array<Record<string, string | number>>;
  previousCampaignEvents: Array<Record<string, string | number>>;
  keyEvents: Array<Record<string, string | number>>;
  acquisition: Array<Record<string, string | number>>;
  landingPages: Array<Record<string, string | number>>;
  pages: Array<Record<string, string | number>>;
  downloads: Array<Record<string, string | number>>;
  outboundLinks: Array<Record<string, string | number>>;
  videos: Array<Record<string, string | number>>;
  transitions: Array<Record<string, string | number>>;
  fetchedAt: string;
}

export interface SocialAnalyticsReport {
  provider: "linkedin" | "instagram" | "tiktok" | "youtube" | "x" | "discord" | "reddit";
  label: string;
  range: string;
  connected: boolean;
  accountLabel: string;
  availability: "live" | "delivery_only" | "permission_required" | "not_connected" | "temporarily_unavailable";
  note: string;
  requiredAction: string;
  totals: Record<string, number | null>;
  comparison: {
    baselineAt: string;
    label: string;
    metrics: Record<string, { current: number; previous: number; absolute: number; percent: number | null }>;
  } | null;
  account: Record<string, string | number>;
  metrics: Array<{ key: string; label: string }>;
  posts: Array<{
    id: string;
    providerId: string;
    title: string;
    publishedAt: string;
    status: string;
    url: string;
    metrics: Record<string, number>;
  }>;
  fetchedAt: string;
}

export interface GrowthReportMetric {
  key: "visibility" | "audience" | "visits" | "leads";
  label: string;
  value: number | null;
  previous: number | null;
  change: number | null;
  changePercent: number | null;
  unit: string;
  source: string;
  note: string;
}

export interface GrowthReport {
  range: string;
  days: number;
  goal: ProjectGrowthPlan;
  metrics: GrowthReportMetric[];
  funnel: Array<{ key: string; label: string; value: number | null; source: string }>;
  channels: Array<{ provider: string; label: string; visibility: number | null; audienceCurrent: number | null; audienceChange: number | null; visits: number | null; leads: number | null; availability: string }>;
  campaigns: Array<{ id: string; name: string; source: string; medium: string; sessions: number; leads: number | null }>;
  keyEvents: Array<{ eventName: string; count: number }>;
  recommendations: Array<{ level: "positive" | "attention" | "setup"; title: string; detail: string; action: string }>;
  tracking: { startedAt: string; attributed: boolean; note: string };
  fetchedAt: string;
}
