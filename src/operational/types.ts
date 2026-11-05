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

export interface BrandIdentity {
  logoDataUrl: string;
  logoName: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  typography: string;
  imageryStyle: string;
  notes: string;
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
  sources: ProductSource[];
  materials: ProductMaterial[];
  brand: BrandIdentity;
  reviewSummary: string;
  openQuestions: string[];
  questionAnswers: Record<string, string>;
  additionalContextDraft: string;
  sourceWarnings: string[];
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
  model: string;
  runtime: string;
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
