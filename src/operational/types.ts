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
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  neutralLightColor: string;
  neutralDarkColor: string;
  typography: string;
  fontFamilies: string[];
  fontSources: BrandFontSource[];
  imageryStyle: string;
  notes: string;
}

export interface BrandFontSource {
  family: string;
  url: string;
  weight: string;
  style: string;
  format: string;
}

export interface ProductWorkspace {
  id: string;
  name: string;
  website: string;
  description: string;
  audience: string;
  valueProposition: string;
  voice: string;
  guardrails: string;
  notes: string;
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
  updatedAt: string;
}

export interface ProjectChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
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
  intensity?: CampaignIntensity;
  createdAt: string;
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
  x: SocialConnectionStatus;
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

export interface NewsletterDashboard {
  audience: {
    id: string;
    name: string;
    memberCount: number;
    unsubscribeCount: number;
    cleanedCount: number;
    openRate: number;
    clickRate: number;
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
  fetchedAt: string;
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
}

export type DeliveryJobStatus = "awaiting_approval" | "running" | "submitted" | "complete" | "failed" | "cancelled";

export interface DeliveryJob {
  id: string;
  projectId: string;
  runId: string;
  channel: "gmail" | "linkedin" | "instagram" | "tiktok" | "x";
  payload: {
    recipient: string;
    subject: string;
    text: string;
    mediaUrl: string;
    mediaKind: "" | "image" | "video";
    privacyLevel: string;
    aiGenerated: boolean;
    rationale: string;
  };
  status: DeliveryJobStatus;
  externalId: string;
  result: Record<string, unknown>;
  error: string;
  approvedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsReport {
  propertyId: string;
  propertyName: string;
  range: string;
  totals: Record<string, number>;
  timeline: Array<Record<string, string | number>>;
  channels: Array<Record<string, string | number>>;
  fetchedAt: string;
}
