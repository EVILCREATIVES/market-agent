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

export interface SocialConnectionStatus {
  configured: boolean;
  connected: boolean;
  accountId: string;
  accountLabel: string;
  scopes: string[];
  connectedAt: string | null;
  canPublish: boolean;
}
