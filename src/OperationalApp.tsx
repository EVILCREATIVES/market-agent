import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Bookmark,
  BrainCircuit,
  CalendarDays,
  ChartColumn,
  Check,
  ChevronDown,
  Cloud,
  CircleAlert,
  CircleDollarSign,
  FileCheck2,
  FileText,
  Globe2,
  Heart,
  ImageIcon,
  KeyRound,
  LayoutDashboard,
  Library,
  Link2,
  Linkedin,
  LoaderCircle,
  LogOut,
  Menu,
  Megaphone,
  MessageCircle,
  MessageSquareText,
  MoreHorizontal,
  Paperclip,
  Plus,
  Rocket,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  UsersRound,
  Video,
  WandSparkles,
  X,
} from "lucide-react";
import {
  siAnthropic,
  siDiscord,
  siFigma,
  siGmail,
  siGoogle,
  siGoogleanalytics,
  siGoogledocs,
  siGoogleslides,
  siInstagram,
  siMailchimp,
  siNeon,
  siReddit,
  siShopify,
  siTiktok,
  siX,
  siYoutube,
} from "simple-icons";
import { createDefaultSchedule, createEmptyProject, loadState, mergeCloudState, saveState } from "./operational/storage";
import { prepareLogo, prepareMaterial, type PreparedMaterial } from "./operational/materials";
import { upload } from "@vercel/blob/client";
import { apiFetch, getAccessToken } from "./auth";
import BrandLogo from "./BrandLogo";
import type { AgentAction, AgentRun, AgentSchedule, AnalyticsReport, ApiCredentialStatus, ApiProvider, AppState, AssetProposal, BillingStatus, BrandLogoVariant, ConnectionStatus, ContactImport, DeliveryJob, GrowthObjective, GrowthReport, HealthState, MediaBudgetSummary, MediaJob, NewsletterDashboard, NewsletterDraft, NewsletterSubscriber, PrimaryConversion, ProductSource, ProductWorkspace, ProjectAsset, ProjectChatMessage, ProspectConversionCampaign, RunAssetReference, RunStatus, SocialAnalyticsReport, SourceMediaAsset, TikTokPublishingOptions, YouTubePublishingOptions } from "./operational/types";

type Page = "agent" | "brain" | "issues" | "research" | "campaigns" | "calendar" | "content" | "analytics" | "integrations";
type CampaignIntensity = "careful" | "assertive" | "aggressive";
type ConnectionProvider = "google-analytics" | "google-gmail" | "mailchimp" | "shopify" | "linkedin" | "instagram" | "tiktok" | "youtube" | "x" | "discord" | "reddit";
type ServiceLogoProvider = ConnectionProvider | "neon" | "google" | "anthropic";
type ConnectionGuide = { message: string; targetId: ConnectionProvider | null; targetName: string; recommendedNames: string[] };
type ConnectionGuideTarget = { id: ConnectionProvider; requestId: number } | null;
type IssueFindings = { high?: string[]; attention?: string[] };
type CampaignWorkspaceSection = "overview" | "newsletter" | "linkedin" | "instagram" | "tiktok" | "youtube" | "x" | "discord" | "reddit";

type ServiceIcon = { title: string; path: string; hex: string };
const serviceIcons: Partial<Record<ServiceLogoProvider, ServiceIcon>> = {
  "google-analytics": siGoogleanalytics,
  "google-gmail": siGmail,
  mailchimp: siMailchimp,
  shopify: siShopify,
  instagram: siInstagram,
  tiktok: siTiktok,
  youtube: siYoutube,
  x: siX,
  discord: siDiscord,
  reddit: siReddit,
  neon: siNeon,
  google: siGoogle,
  anthropic: siAnthropic,
};

function ServiceLogo({ provider, name }: { provider?: ServiceLogoProvider; name: string }) {
  if (provider === "linkedin") return <span className="op-service-logo op-service-logo--linkedin" aria-label="LinkedIn"><Linkedin size={20} strokeWidth={2.2} /></span>;
  const icon = provider ? serviceIcons[provider] : undefined;
  if (!icon) return <span className="op-service-logo" aria-hidden="true">{name.slice(0, 2)}</span>;
  const color = provider === "mailchimp" ? "#241c15" : `#${icon.hex}`;
  return <span className={`op-service-logo op-service-logo--${provider}`} style={{ "--service-color": color } as CSSProperties} aria-label={icon.title}><svg viewBox="0 0 24 24" role="img"><path d={icon.path} /></svg></span>;
}

function SourceServiceIcon({ url, compact = false }: { url: string; compact?: boolean }) {
  const kind = connectedSourceKind(url);
  const icon = kind === "figma" ? siFigma : kind === "google-slides" ? siGoogleslides : kind === "google-docs" ? siGoogledocs : null;
  const color = icon ? `#${icon.hex}` : kind === "pdf" ? "#c94f45" : "#6650c1";
  const label = icon?.title || (kind === "pdf" ? "PDF" : "Website");
  return <span className={`op-source-service-icon ${compact ? "compact" : ""}`} style={{ "--source-service-color": color } as CSSProperties} aria-label={label}>
    {icon ? <svg viewBox="0 0 24 24" role="img"><path d={icon.path} /></svg> : kind === "pdf" ? <FileText size={compact ? 12 : 16} /> : <Globe2 size={compact ? 12 : 16} />}
  </span>;
}

const nav = [
  { id: "agent" as const, label: "Agent", icon: LayoutDashboard },
  { id: "brain" as const, label: "Brand", icon: BrainCircuit },
  { id: "research" as const, label: "Research", icon: Search },
  { id: "campaigns" as const, label: "Campaigns", icon: Rocket },
  { id: "calendar" as const, label: "Calendar", icon: CalendarDays },
  { id: "content" as const, label: "Content library", icon: Library },
  { id: "analytics" as const, label: "Growth", icon: ChartColumn },
  { id: "integrations" as const, label: "Integrations", icon: Settings2 },
  { id: "issues" as const, label: "Issues", icon: CircleAlert },
];

const actionMeta: Record<AgentAction, { title: string; description: string }> = {
  research: { title: "Market research", description: "Current audience pain, alternatives, language, and opportunities" },
  campaign: { title: "Campaign execution pack", description: "Targets, final outreach, channel assets, tracking, and an executable schedule" },
  social: { title: "Social content pack", description: "Seven days of channel-specific posts and creative direction" },
  audience: { title: "Audience analysis", description: "Segments, triggers, objections, and ethical prospect signals" },
  chat: { title: "Custom agent run", description: "A specific marketing task for the active project" },
};

const emptyConnections = (): ConnectionStatus => ({
  analytics: { configured: false, authorized: false, connected: false, accountEmail: "", propertyId: "", propertyName: "", properties: [], connectedAt: null, canRead: false },
  mailchimp: { configured: false, connected: false, accountLabel: "", accountEmail: "", audiences: [], audienceId: "", audienceName: "", connectedAt: null, canManage: false },
  shopify: { configured: false, connected: false, storeDomain: "", storeName: "", scopes: [], connectedAt: null, canManage: false },
  gmail: { configured: false, connected: false, accountEmail: "", scopes: [], connectedAt: null, canSend: false },
  linkedin: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
  instagram: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
  tiktok: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
  youtube: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
  x: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
  discord: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
  reddit: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false, destinations: [], destinationId: "", destinationName: "", approvalRequired: true, approvalStatus: "pending_approval" },
});

const emptyApiCredentials = (): ApiCredentialStatus => ({
  ready: false,
  collaborationReady: false,
  mediaReady: false,
  videoReady: false,
  connectedCount: 0,
  credentials: {
    openai: { connected: false, hint: "", connectedAt: null, updatedAt: null },
    google: { connected: false, hint: "", connectedAt: null, updatedAt: null },
    anthropic: { connected: false, hint: "", connectedAt: null, updatedAt: null },
  },
});

const emptyBilling = (): BillingStatus => ({
  checked: false,
  configured: false,
  paypalConfigured: false,
  platformApisConfigured: false,
  active: false,
  status: "none",
  subscriptionId: "",
  payerEmail: "",
  planName: "Managed text plan",
  price: "29.99",
  currency: "USD",
  mediaIncluded: false,
  collaborationReady: false,
  trial: { active: false, daysRemaining: 0, endsAt: "" },
});

export default function OperationalApp({ userId, userEmail, onSignOut }: { userId: string; userEmail: string; onSignOut: () => Promise<void> }) {
  const [state, setState] = useState<AppState>(() => loadState(userId));
  const [page, setPage] = useState<Page>(() => {
    if (typeof window === "undefined") return "agent";
    const saved = window.localStorage.getItem(`market-agent:last-page:${userId}`) as Page | null;
    return saved && nav.some((item) => item.id === saved) ? saved : "agent";
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>({ checked: false, apiOnline: false, agentConfigured: false, databaseConfigured: false, authConfigured: false, analyticsConfigured: false, mediaConfigured: false, model: "", runtime: "" });
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const [cloudSaving, setCloudSaving] = useState(false);
  const cloudRevisionRef = useRef(0);
  const [connections, setConnections] = useState<ConnectionStatus>(() => emptyConnections());
  const [apiCredentials, setApiCredentials] = useState<ApiCredentialStatus>(() => emptyApiCredentials());
  const [apiCredentialsChecked, setApiCredentialsChecked] = useState(false);
  const [billing, setBilling] = useState<BillingStatus>(() => emptyBilling());
  const [accessChoiceOpen, setAccessChoiceOpen] = useState(false);
  const [billingBusy, setBillingBusy] = useState(false);
  const [projectChatOpen, setProjectChatOpen] = useState(false);
  const [connectionGuideTarget, setConnectionGuideTarget] = useState<ConnectionGuideTarget>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => document.querySelectorAll<HTMLTextAreaElement>(".op-page textarea").forEach(resizeLongFormTextarea));
    return () => window.cancelAnimationFrame(frame);
  }, [page, selectedRunId, state]);

  useEffect(() => {
    window.localStorage.setItem(`market-agent:last-page:${userId}`, page);
  }, [page, userId]);

  const refreshConnections = async (projectId = state.activeProjectId) => {
    const response = await apiFetch(`/api/connections?projectId=${encodeURIComponent(projectId)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Connections could not be checked.");
    setConnections(data as ConnectionStatus);
    return data as ConnectionStatus;
  };

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => setHealth({ checked: true, apiOnline: true, agentConfigured: false, databaseConfigured: Boolean(data.databaseConfigured), authConfigured: Boolean(data.authConfigured), analyticsConfigured: Boolean(data.analyticsConfigured), mediaConfigured: false, model: "", runtime: data.runtime || "" }))
      .catch(() => setHealth({ checked: true, apiOnline: false, agentConfigured: false, databaseConfigured: false, authConfigured: false, analyticsConfigured: false, mediaConfigured: false, model: "", runtime: "" }));
  }, []);

  useEffect(() => {
    let active = true;
    apiFetch("/api/state")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Cloud workspace could not be opened.");
        const local = loadState(userId);
        const hasLocalWork = local.runs.length > 0 || local.projects.some((project) => workspaceCompleteness(project) > 20);
        const next = data.isEmpty && hasLocalWork ? local : data.state;
        if (data.isEmpty && hasLocalWork) {
          const initialResponse = await apiFetch("/api/state", { method: "POST", body: JSON.stringify({ state: next, baseRevision: Number(data.revision || 0) }) });
          const initialData = await initialResponse.json();
          if (!initialResponse.ok) throw new Error(initialData.error || "Cloud workspace could not be initialized.");
          cloudRevisionRef.current = Number(initialData.revision || 1);
        } else {
          cloudRevisionRef.current = Number(data.revision || 0);
        }
        if (active) {
          setState(next);
          saveState(next, userId);
          setCloudReady(true);
        }
      })
      .catch((error) => { if (active) setCloudError(error instanceof Error ? error.message : "Cloud workspace could not be opened."); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    if (!cloudReady) return;
    saveState(state, userId);
    setCloudSaving(true);
    const timer = window.setTimeout(() => {
      apiFetch("/api/state", { method: "POST", body: JSON.stringify({ state, baseRevision: cloudRevisionRef.current }) })
        .then(async (response) => {
          const data = await response.json();
          if (response.status === 409 && data.state) {
            cloudRevisionRef.current = Number(data.revision || cloudRevisionRef.current);
            setState((current) => mergeCloudState(current, data.state as AppState));
            setCloudError("A newer change was merged from another tab or background task.");
            return;
          }
          if (!response.ok) throw new Error(data.error || "Cloud save failed.");
          cloudRevisionRef.current = Number(data.revision || cloudRevisionRef.current + 1);
          setCloudError("");
        })
        .catch((error) => setCloudError(error instanceof Error ? error.message : "Cloud save failed."))
        .finally(() => setCloudSaving(false));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [state, cloudReady, userId]);

  useEffect(() => {
    if (!cloudReady) return;
    setConnections(emptyConnections());
    refreshConnections(state.activeProjectId)
      .catch(() => setConnections(emptyConnections()));
  }, [cloudReady, state.activeProjectId]);

  useEffect(() => {
    if (!cloudReady) return;
    apiFetch("/api/api-credentials")
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Private API connections could not be checked.");
        setApiCredentials(data as ApiCredentialStatus);
      })
      .catch(() => setApiCredentials(emptyApiCredentials()))
      .finally(() => setApiCredentialsChecked(true));
  }, [cloudReady]);

  const refreshBilling = async () => {
    const response = await apiFetch("/api/billing");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Plan status could not be checked.");
    setBilling(data as BillingStatus);
    return data as BillingStatus;
  };

  useEffect(() => {
    if (!cloudReady) return;
    refreshBilling().catch(() => setBilling({ ...emptyBilling(), checked: true }));
  }, [cloudReady]);

  useEffect(() => {
    if (!cloudReady || !apiCredentialsChecked || !billing.checked || apiCredentials.ready || billing.active) return;
    const remembered = window.localStorage.getItem(`market-agent-access-choice:${userId}`);
    if (!billing.trial.active || !remembered) setAccessChoiceOpen(true);
  }, [cloudReady, apiCredentialsChecked, apiCredentials.ready, billing.checked, billing.active, billing.trial.active, userId]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("connection");
    if (!result) return;
    const reason = params.get("reason") || "";
    if (window.opener && window.opener !== window) {
      window.opener.postMessage({ type: "market-agent-connection-result", result, reason }, window.location.origin);
      window.close();
      return;
    }
    setPage("integrations");
    const labels: Record<string, string> = { gmail: "Mailbox", analytics: "Google Analytics", mailchimp: "Mailchimp", shopify: "Shopify", linkedin: "LinkedIn", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", discord: "Discord", reddit: "Reddit" };
    const provider = result.replace(/-success$/, "");
    setToast(result === "analytics-select" ? "Google Analytics authorized. Choose the property for this project." : result === "mailchimp-select" ? "Mailchimp connected. Choose the audience for this project." : result === "analytics-success" || result === "gmail-success" || result === "mailchimp-success" ? `${labels[provider] || "Account"} connected and verified.` : result.endsWith("-success") ? `${labels[provider] || "Account"} authorization completed. Publishing permission is shown below.` : reason || "Account connection failed.");
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  };

  const activeProject = state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0];
  const projectRuns = state.runs.filter((run) => run.projectId === activeProject.id);
  const campaignRuns = projectRuns.filter(isCampaignRun);
  const activeSchedule = state.schedules[activeProject.id] || createDefaultSchedule();
  const runtimeReady = apiCredentials.ready || billing.active || billing.trial.active;
  const automationReady = apiCredentials.ready || billing.active;
  const accessMode = apiCredentials.ready ? "byok" : billing.active ? "managed" : billing.trial.active ? "trial" : "expired";
  const connectionGuide = useMemo(() => buildConnectionGuide(activeProject, connections, accessMode), [activeProject, connections, accessMode]);

  useEffect(() => {
    if (!cloudReady || page !== "integrations") return;
    const key = `market-agent-connection-chat-v2:${activeProject.id}`;
    if (window.localStorage.getItem(key)) return;
    const timer = window.setTimeout(() => setProjectChatOpen(true), 240);
    return () => window.clearTimeout(timer);
  }, [activeProject.id, cloudReady, page]);

  const guideConnections = () => {
    const key = `market-agent-connection-chat-v2:${activeProject.id}`;
    window.localStorage.setItem(key, "guided");
    if (connectionGuide.targetId) {
      setConnectionGuideTarget({ id: connectionGuide.targetId, requestId: Date.now() });
      setProjectChatOpen(false);
    }
  };

  const deferConnectionGuide = () => {
    window.localStorage.setItem(`market-agent-connection-chat-v2:${activeProject.id}`, "later");
    setProjectChatOpen(false);
  };

  const updateWorkspace = (workspace: ProductWorkspace) => setState((current) => ({
    ...current,
    projects: current.projects.map((project) => project.id === workspace.id ? workspace : project),
  }));
  const updateSchedule = (schedule: AgentSchedule) => setState((current) => ({
    ...current,
    schedules: { ...current.schedules, [current.activeProjectId]: schedule },
  }));
  const addRun = (run: AgentRun) => {
    setState((current) => ({ ...current, runs: [run, ...current.runs] }));
    setSelectedRunId(run.id);
  };
  const addProactiveIssues = (projectId: string, findings: IssueFindings | undefined) => {
    if (!findings || (!findings.high?.length && !findings.attention?.length)) return;
    setState((current) => ({
      ...current,
      projects: current.projects.map((project) => project.id === projectId ? appendProactiveIssueFindings(project, findings) : project),
    }));
  };
  const attachAssetToCampaign = (runId: string, asset: RunAssetReference, findings?: IssueFindings) => {
    if (!runId) return;
    setState((current) => ({
      ...current,
      runs: current.runs.map((run) => {
        if (run.id !== runId) return run;
        const references = [...(run.assetReferences || []).filter((item) => item.id !== asset.id), asset];
        return {
          ...run,
          assetReferences: references,
          issueFindings: {
            high: Array.from(new Set([...(run.issueFindings?.high || []), ...(findings?.high || [])])),
            attention: Array.from(new Set([...(run.issueFindings?.attention || []), ...(findings?.attention || [])])),
          },
        };
      }),
    }));
  };
  const updateRunStatus = (id: string, status: RunStatus) => setState((current) => ({ ...current, runs: current.runs.map((run) => run.id === id ? { ...run, status } : run) }));
  const updateRunOutput = (id: string, output: string) => setState((current) => ({ ...current, runs: current.runs.map((run) => run.id === id ? { ...run, output } : run) }));
  const deleteRun = async (id: string) => {
    try {
      const response = await apiFetch(`/api/state?runId=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The campaign could not be deleted.");
      cloudRevisionRef.current = Math.max(cloudRevisionRef.current, Number(data.revision || 0));
      setState((current) => ({ ...current, runs: current.runs.filter((run) => run.id !== id) }));
      if (selectedRunId === id) setSelectedRunId(null);
      notify("Campaign deleted. Unpublished scheduled items were cancelled.");
    } catch (error) { notify(error instanceof Error ? error.message : "The campaign could not be deleted."); }
  };

  const createProject = () => {
    const existingNames = new Set(state.projects.map((project) => project.name));
    let name = "New project";
    let suffix = 2;
    while (existingNames.has(name)) name = `New project ${suffix++}`;
    const project = createEmptyProject(name);
    setState((current) => ({
      ...current,
      projects: [...current.projects, project],
      activeProjectId: project.id,
      schedules: { ...current.schedules, [project.id]: createDefaultSchedule() },
    }));
    setProjectMenuOpen(false);
    setSelectedRunId(null);
    setPage("brain");
    notify("New project created. Add its product facts to begin.");
  };

  const switchProject = (projectId: string) => {
    setState((current) => ({ ...current, activeProjectId: projectId }));
    setProjectMenuOpen(false);
    setSelectedRunId(null);
    setPage("agent");
  };

  const navigate = (next: Page) => { setPage(next); setMobileOpen(false); setSelectedRunId(null); };
  const rememberAccessChoice = (choice: "trial" | "byok" | "managed") => {
    window.localStorage.setItem(`market-agent-access-choice:${userId}`, choice);
    setAccessChoiceOpen(false);
  };
  const startManagedSubscription = async () => {
    setBillingBusy(true);
    try {
      const response = await apiFetch("/api/billing", { method: "POST", body: JSON.stringify({ action: "create" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Subscription checkout could not start.");
      if (data.active) { await refreshBilling(); setAccessChoiceOpen(false); return; }
      if (!data.approvalUrl) throw new Error("PayPal did not return a checkout link.");
      window.location.assign(data.approvalUrl);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Subscription checkout could not start.");
    } finally {
      setBillingBusy(false);
    }
  };
  const cancelManagedPlan = async () => {
    if (!window.confirm("Cancel the $29.99 monthly managed text plan? Access continues only through your own connected APIs or any remaining demo period.")) return;
    setBillingBusy(true);
    try {
      const response = await apiFetch("/api/billing", { method: "POST", body: JSON.stringify({ action: "cancel" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The subscription could not be cancelled.");
      setBilling(data as BillingStatus);
      notify("Managed plan cancelled.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The subscription could not be cancelled.");
    } finally {
      setBillingBusy(false);
    }
  };
  const completeness = workspaceCompleteness(activeProject);
  const issueCount = unresolvedIssueCount(activeProject);

  if (cloudError && !cloudReady) {
    return <div className="full-message"><span><CircleAlert size={24} /></span><h1>Cloud workspace unavailable</h1><p>{cloudError}</p><button onClick={() => window.location.reload()}>Try again</button><button className="secondary" onClick={() => void onSignOut()}>Sign out</button></div>;
  }
  if (!cloudReady) {
    return <div className="full-message"><span><LoaderCircle className="spin" size={24} /></span><h1>Loading Market Agent</h1><p>Opening your secure cloud workspace…</p></div>;
  }

  return (
    <div className="op-shell" onInputCapture={(event) => resizeLongFormTextarea(event.target)}>
      <aside className={`op-sidebar ${mobileOpen ? "op-sidebar--open" : ""}`}>
        <div className="op-brand"><BrandLogo /><strong>Market Agent</strong><button onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
        <div className="op-project-switcher">
          <button className="op-workspace" onClick={() => setProjectMenuOpen((open) => !open)} aria-expanded={projectMenuOpen}>
            <span>{projectInitials(activeProject.name)}</span><div><small>Active project</small><strong>{activeProject.name || "Unnamed project"}</strong></div><ChevronDown size={15} />
          </button>
          {projectMenuOpen && <div className="op-project-menu"><div className="op-project-menu__head"><span>Projects</span><small>{state.projects.length}</small></div>{state.projects.map((project) => <button key={project.id} className={project.id === activeProject.id ? "active" : ""} onClick={() => switchProject(project.id)}><span>{projectInitials(project.name)}</span><div><strong>{project.name || "Unnamed project"}</strong><small>{project.id === activeProject.id ? "Active" : "Switch project"}</small></div>{project.id === activeProject.id && <Check size={14} />}</button>)}<button className="op-project-add" onClick={createProject}><Plus size={14} /> Create new project</button></div>}
        </div>
        <nav>{nav.map((item) => { const Icon = item.icon; const count = item.id === "issues" ? issueCount : item.id === "research" ? projectRuns.filter((r) => ["research", "audience"].includes(r.action)).length : item.id === "campaigns" ? campaignRuns.length : item.id === "content" ? projectRuns.filter((r) => r.action === "social").length : 0; return <button key={item.id} className={`${page === item.id ? "active" : ""} ${item.id === "issues" ? "issues" : ""} ${item.id === "issues" && count > 0 ? "attention" : ""}`} onClick={() => navigate(item.id)}><Icon size={17} /><span>{item.label}</span>{count > 0 && <em>{count}</em>}</button>; })}</nav>
        <div className="op-sidebar__bottom"><div className={`op-api-dot ${runtimeReady ? "ready" : ""}`} /><div><strong>{runtimeReady ? "Agent ready" : "Choose access"}</strong><small>{accessMode === "byok" ? "Your private APIs" : accessMode === "managed" ? "Managed text plan" : accessMode === "trial" ? `${billing.trial.daysRemaining}-day demo remaining` : "Connect APIs or subscribe"}</small></div></div>
      </aside>

      <main className="op-main">
        <header className="op-topbar"><button className="op-mobile-menu" onClick={() => setMobileOpen(true)}><Menu size={20} /></button><div className="op-product-state"><span className={completeness >= 60 ? "good" : ""}>{completeness}%</span><div><strong>Brand</strong><small>{completeness >= 60 ? "Ready for grounded work" : "Needs brand context"}</small></div></div><div className="op-topbar__right"><span className={`op-status ${runtimeReady ? "op-status--ready" : ""}`}><i />{runtimeReady ? accessMode === "trial" ? "Demo active" : "Live agent" : "Choose access"}</span><span className="op-cloud-state"><Cloud size={14} />{cloudSaving ? "Saving…" : cloudError ? "Save issue" : "Saved"}</span><button className="op-user-button" title={userEmail} onClick={() => void onSignOut()}><LogOut size={15} /> Sign out</button></div></header>

        <div className="op-page">
          {selectedRunId ? <RunDetail run={state.runs.find((run) => run.id === selectedRunId)!} workspace={activeProject} connections={connections} onBack={() => setSelectedRunId(null)} onConnect={() => navigate("integrations")} onStatus={updateRunStatus} onOutput={updateRunOutput} onDelete={deleteRun} notify={notify} /> : <>
            {page === "agent" && <AgentHome workspace={activeProject} runs={projectRuns} health={{ ...health, agentConfigured: runtimeReady }} connections={connections} schedule={activeSchedule} automationReady={automationReady} onSchedule={updateSchedule} onRun={addRun} onIssuesFound={addProactiveIssues} onOpen={setSelectedRunId} onNavigate={navigate} notify={notify} />}
            {page === "brain" && <ProductBrain key={activeProject.id} userId={userId} workspace={activeProject} onSave={updateWorkspace} onOpenContentLibrary={() => navigate("content")} notify={notify} />}
            {page === "issues" && <IssuesCenter workspace={activeProject} onSave={updateWorkspace} onOpenBrand={() => navigate("brain")} notify={notify} />}
            {page === "research" && <RunLibrary title="Research" description={`Live market and audience work grounded in ${activeProject.name || "this project"}'s Brand.`} empty="No research has been run for this project yet." runs={projectRuns.filter((run) => ["research", "audience"].includes(run.action))} onOpen={setSelectedRunId} onStart={() => navigate("agent")} />}
            {page === "campaigns" && <CampaignWorkspace workspace={activeProject} runs={campaignRuns} connections={connections} onSaveWorkspace={updateWorkspace} onOpen={setSelectedRunId} onStart={() => navigate("agent")} onConnect={() => navigate("integrations")} onGrowth={() => navigate("analytics")} notify={notify} />}
            {page === "calendar" && <CalendarWorkspace workspace={activeProject} runs={campaignRuns} onOpen={setSelectedRunId} onOpenNewsletter={() => { window.sessionStorage.setItem(`market-agent:campaign-section:${activeProject.id}`, "newsletter"); navigate("campaigns"); }} />}
            {page === "content" && <ContentLibrary userId={userId} workspace={activeProject} runs={projectRuns.filter((run) => run.action === "social")} mediaConfigured={apiCredentials.mediaReady} videoConfigured={apiCredentials.videoReady} onSave={updateWorkspace} onIssuesFound={addProactiveIssues} onOpen={setSelectedRunId} onStart={() => navigate("agent")} notify={notify} />}
            {page === "analytics" && <AnalyticsDashboard workspace={activeProject} connections={connections} onSave={updateWorkspace} onConnect={() => navigate("integrations")} />}
            {page === "integrations" && <OperationalIntegrations workspace={activeProject} projectId={activeProject.id} userEmail={userEmail} health={{ ...health, agentConfigured: runtimeReady, mediaConfigured: apiCredentials.mediaReady }} apiCredentials={apiCredentials} onApiCredentials={setApiCredentials} billing={billing} accessMode={accessMode} billingBusy={billingBusy} onSubscribe={() => void startManagedSubscription()} onCancelPlan={() => void cancelManagedPlan()} connections={connections} onConnections={setConnections} guideTarget={connectionGuideTarget} notify={notify} />}
          </>}
        </div>
      </main>
      {mobileOpen && <button className="op-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <ProjectChat userId={userId} workspace={activeProject} activeCampaignRunId={selectedRunId && campaignRuns.some((run) => run.id === selectedRunId) ? selectedRunId : campaignRuns[0]?.id || ""} open={projectChatOpen} onOpen={() => setProjectChatOpen(true)} onClose={() => page === "integrations" ? deferConnectionGuide() : setProjectChatOpen(false)} onSave={updateWorkspace} onCampaignUpdated={(run, revision) => { if (revision) cloudRevisionRef.current = Math.max(cloudRevisionRef.current, revision); setState((current) => ({ ...current, runs: current.runs.map((item) => item.id === run.id ? run : item) })); }} onAttachToCampaign={attachAssetToCampaign} onIssuesFound={addProactiveIssues} guide={page === "integrations" ? connectionGuide : null} onGuideHelp={guideConnections} onGuideLater={deferConnectionGuide} notify={notify} />
      {accessChoiceOpen && <AccessChoice billing={billing} busy={billingBusy} onDemo={() => rememberAccessChoice("trial")} onApis={() => { rememberAccessChoice("byok"); navigate("integrations"); }} onSubscribe={() => { rememberAccessChoice("managed"); void startManagedSubscription(); }} onClose={() => setAccessChoiceOpen(false)} />}
      {toast && <div className="op-toast"><Sparkles size={15} />{toast}<button onClick={() => setToast(null)}><X size={14} /></button></div>}
    </div>
  );
}

function AccessChoice({ billing, busy, onDemo, onApis, onSubscribe, onClose }: { billing: BillingStatus; busy: boolean; onDemo: () => void; onApis: () => void; onSubscribe: () => void; onClose: () => void }) {
  return <><button className="op-access-scrim" aria-label="Close access choices" onClick={onClose} /><aside className="op-access-choice" aria-label="Choose Market Agent access">
    <header><span><Sparkles size={19} /></span><div><small>WELCOME TO MARKET AGENT</small><strong>Choose how you want the agent to work</strong></div><button onClick={onClose} aria-label="Close"><X size={17} /></button></header>
    <p className="op-access-intro">For the best performance, connect your own APIs. If you prefer not to, start the limited demo or choose the managed text plan.</p>
    <div className="op-access-options">
      <article className="recommended"><em>BEST PERFORMANCE</em><span><KeyRound size={19} /></span><h2>Connect your APIs</h2><strong>Provider costs only</strong><p>The setup assistant guides you one connection at a time. Keys remain private to your account.</p><ul><li><Check size={13} />Full reasoning access</li><li><Check size={13} />Image and video where supported</li><li><Check size={13} />All available connectors</li><li><Check size={13} />Your provider billing</li></ul><button onClick={onApis}>Connect my APIs <ArrowRight size={14} /></button></article>
      {billing.trial.active && <article><span><Bot size={19} /></span><h2>10-day demo</h2><strong>$0</strong><p>Upload documents, test project analysis and campaign reasoning, and connect LinkedIn.</p><ul><li><Check size={13} />{billing.trial.daysRemaining} days remaining</li><li><Check size={13} />Limited smart text work</li><li><Check size={13} />LinkedIn connector only</li><li><X size={13} />No image or video creation</li></ul><button onClick={onDemo}>Use the demo instead <ArrowRight size={14} /></button></article>}
      <article><span><CircleDollarSign size={19} /></span><h2>Managed text plan</h2><strong>$29.99 <small>USD / month</small></strong><p>Use Market Agent’s managed services for ongoing research, strategy, campaigns, writing, and balanced review.</p><ul><li><Check size={13} />Three-way text strategy review</li><li><Check size={13} />Ongoing campaign reasoning</li><li><Check size={13} />All available connectors</li><li><Check size={13} />Approval-only X publishing</li><li><X size={13} />No image or video creation</li></ul><button onClick={onSubscribe} disabled={busy || !billing.configured}>{busy ? "Opening PayPal…" : billing.configured ? "Subscribe with PayPal" : "PayPal setup pending"} <ArrowRight size={14} /></button></article>
    </div>
    {!billing.trial.active && <button className="op-access-later" onClick={onClose}>Use the setup assistant for now</button>}
  </aside></>;
}

function ProjectChat({ userId, workspace, activeCampaignRunId, open, onOpen, onClose, onSave, onCampaignUpdated, onAttachToCampaign, onIssuesFound, guide, onGuideHelp, onGuideLater, notify }: { userId: string; workspace: ProductWorkspace; activeCampaignRunId: string; open: boolean; onOpen: () => void; onClose: () => void; onSave: (workspace: ProductWorkspace) => void; onCampaignUpdated: (run: AgentRun, revision: number) => void; onAttachToCampaign: (runId: string, asset: RunAssetReference, findings?: IssueFindings) => void; onIssuesFound: (projectId: string, findings: IssueFindings | undefined) => void; guide: ConnectionGuide | null; onGuideHelp: () => void; onGuideLater: () => void; notify: (message: string) => void }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [uploadingLabel, setUploadingLabel] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const attachmentInput = useRef<HTMLInputElement>(null);
  const messages = workspace.chatMessages || [];

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [open, messages.length, sending]);

  useEffect(() => { setDraft(""); setAttachments([]); }, [workspace.id]);

  const addAttachments = (files: FileList | null) => {
    const incoming = Array.from(files || []);
    if (!incoming.length) return;
    setAttachments((current) => [...current, ...incoming].filter((file, index, all) => all.findIndex((item) => item.name === file.name && item.size === file.size) === index).slice(0, 8));
    if (attachmentInput.current) attachmentInput.current.value = "";
  };

  const registerAttachment = async (file: File, instruction: string, preparedInput?: PreparedMaterial) => {
    const token = await getAccessToken();
    const prepared = preparedInput || await prepareMaterial(file);
    const compact = compactMaterialsForUpload([prepared])[0];
    const safeName = file.name.replace(/[^a-z0-9._-]+/gi, "-").slice(-180) || "asset";
    const pathname = `market-agent-assets/${encodeURIComponent(userId)}/${encodeURIComponent(workspace.id)}/${Date.now()}-${safeName}`;
    const blob = await upload(pathname, file, {
      access: "private",
      handleUploadUrl: "/api/asset-upload",
      clientPayload: JSON.stringify({ projectId: workspace.id }),
      headers: { Authorization: `Bearer ${token}` },
      contentType: file.type || prepared.mimeType,
      multipart: file.size > 5 * 1024 * 1024,
    });
    const response = await apiFetch("/api/assets", {
      method: "POST",
      body: JSON.stringify({ action: "register-upload", projectId: workspace.id, name: file.name, kind: prepared.kind, mimeType: file.type || prepared.mimeType, sizeBytes: file.size, blobPath: blob.pathname, detail: prepared.detail, text: compact.text, images: compact.images, instruction, workspace }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `${file.name} could not be analyzed.`);
    return { prepared, data };
  };

  const stageContactAttachment = async (file: File, instruction: string, prepared: PreparedMaterial) => {
    const response = await apiFetch("/api/newsletters", {
      method: "POST",
      body: JSON.stringify({
        action: "stage-contact-import",
        projectId: workspace.id,
        name: file.name,
        text: prepared.text,
        direction: instruction,
        createDraft: isNewsletterCampaignInstruction(instruction),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `${file.name} could not be read as a contact list.`);
    window.dispatchEvent(new CustomEvent("market-agent-newsletter-updated", { detail: { projectId: workspace.id } }));
    return data as { contactImport: ContactImport; draft?: NewsletterDraft | null; draftError?: string };
  };

  const send = async () => {
    const selectedFiles = [...attachments];
    const content = draft.trim() || (selectedFiles.length ? "Use these assets where they are most useful for this project." : "");
    if (!content || sending) return;
    setDraft("");
    setAttachments([]);
    setSending(true);
    let routedWorkspace = workspace;
    const attachmentRecords: NonNullable<ProjectChatMessage["attachments"]> = [];
    const routingNotes: string[] = [];
    const stagedContactImports: Array<{ contactImport: ContactImport; draft?: NewsletterDraft | null; draftError?: string }> = [];
    try {
      for (const [index, file] of selectedFiles.entries()) {
        setUploadingLabel(`Analyzing ${index + 1} of ${selectedFiles.length} · ${file.name}`);
        const preparedInput = await prepareMaterial(file);
        if (isContactCsv(file, preparedInput)) {
          const data = await stageContactAttachment(file, content, preparedInput);
          stagedContactImports.push(data);
          attachmentRecords.push({ id: data.contactImport.id, name: file.name, kind: "document", destinations: ["campaign"] });
          routingNotes.push(`${file.name}: Campaign contacts. ${data.contactImport.validCount} valid contact${data.contactImport.validCount === 1 ? "" : "s"} staged; ${data.contactImport.duplicateCount} duplicate${data.contactImport.duplicateCount === 1 ? "" : "s"} and ${data.contactImport.invalidCount} invalid row${data.contactImport.invalidCount === 1 ? "" : "s"} excluded. ${data.contactImport.consentedCount} marked consented, ${data.contactImport.unknownCount} need permission confirmation, ${data.contactImport.deniedCount} excluded. This file is not a creative asset and was not added to Brand or Content Library.${data.draft ? " A newsletter draft was created in Campaigns." : data.draftError ? ` Draft creation needs attention: ${data.draftError}` : ""}`);
          continue;
        }
        const { prepared, data } = await registerAttachment(file, content, preparedInput);
        const suggested = Array.isArray(data.routing?.destinations) ? data.routing.destinations.filter((value: string) => ["brand", "campaign", "content"].includes(value)) : [];
        const destinations = Array.from(new Set(["content", ...suggested])) as string[];
        const asset = data.asset as ProjectAsset;
        const reference: RunAssetReference = { id: asset.id, name: asset.name, kind: prepared.kind, summary: asset.summary || "Uploaded project asset", tags: asset.tags || [], routingRationale: String(data.routing?.rationale || asset.rationale || "Placed from project chat.") };
        if (destinations.includes("brand")) {
          const material = { id: `asset-${asset.id}`, assetId: asset.id, name: asset.name, kind: prepared.kind, addedAt: new Date().toISOString(), summary: reference.summary, tags: reference.tags, routingRationale: reference.routingRationale };
          routedWorkspace = { ...routedWorkspace, materials: [...(routedWorkspace.materials || []).filter((item) => item.assetId !== asset.id && item.name !== asset.name), material] };
          onIssuesFound(workspace.id, data.issueFindings as IssueFindings | undefined);
        }
        if (destinations.includes("campaign") && activeCampaignRunId) onAttachToCampaign(activeCampaignRunId, reference, data.issueFindings as IssueFindings | undefined);
        const appliedDestinations = destinations.includes("campaign") && !activeCampaignRunId ? destinations.filter((value) => value !== "campaign") : destinations;
        attachmentRecords.push({ id: asset.id, name: asset.name, kind: prepared.kind, destinations: appliedDestinations });
        const labels = appliedDestinations.map(assetDestinationLabel);
        routingNotes.push(`${asset.name}: ${labels.join(" + ")}. ${reference.routingRationale}${destinations.includes("campaign") && !activeCampaignRunId ? " It is campaign-ready, but no campaign exists yet, so I left it in the Content Library for now." : ""}`);
      }
      setUploadingLabel("");
      const userMessage: ProjectChatMessage = { id: crypto.randomUUID(), role: "user", content, attachments: attachmentRecords, createdAt: new Date().toISOString() };
      const nextHistory = [...messages, userMessage].slice(-80);
      routedWorkspace = { ...routedWorkspace, chatMessages: nextHistory, updatedAt: new Date().toISOString() };
      onSave(routedWorkspace);
      const routedContext = routingNotes.length ? `${content}\n\nATTACHMENT ROUTING ALREADY COMPLETED\n${routingNotes.map((note) => `- ${note}`).join("\n")}\nAcknowledge these completed placements clearly. Do not ask the user to upload or move the files again. A contact list belongs to Campaigns, never Brand or Content Library. Do not claim that no contacts were processed when a staged count is supplied.` : content;
      const response = await apiFetch("/api/chat", { method: "POST", body: JSON.stringify({ projectId: workspace.id, activeCampaignRunId, workspace: routedWorkspace, history: nextHistory, message: routedContext, intent: isTypographyInspectionInstruction(content) ? "inspect-typography" : isBrandSourceRefreshInstruction(content) ? "refresh-brand" : undefined, useWeb: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The project assistant could not reply.");
      if (data.assetAction?.jobs && activeCampaignRunId) window.dispatchEvent(new CustomEvent("market-agent-delivery-updated", { detail: { runId: activeCampaignRunId, jobs: data.assetAction.jobs } }));
      if (data.newsletterAction?.draft) window.dispatchEvent(new CustomEvent("market-agent-newsletter-updated", { detail: { projectId: workspace.id, draft: data.newsletterAction.draft } }));
      if (data.newsletterLogoAction?.draft) window.dispatchEvent(new CustomEvent("market-agent-newsletter-updated", { detail: { projectId: workspace.id, draft: data.newsletterLogoAction.draft } }));
      if (data.campaignAction?.run) onCampaignUpdated(data.campaignAction.run as AgentRun, Number(data.campaignAction.revision || 0));
      if (data.assetAction?.asset && activeCampaignRunId) onAttachToCampaign(activeCampaignRunId, {
        id: String(data.assetAction.asset.id),
        name: String(data.assetAction.asset.name || "Campaign asset"),
        kind: data.assetAction.asset.kind === "video" ? "video" : "image",
        summary: String(data.assetAction.asset.summary || "Selected from the Content Library."),
        tags: Array.isArray(data.assetAction.asset.tags) ? data.assetAction.asset.tags.map(String) : [],
        routingRationale: String(data.assetAction.asset.routingRationale || "Selected from the Content Library to replace the campaign media."),
      });
      const contactCompletion = stagedContactImports.length ? stagedContactImports.map(({ contactImport, draft, draftError }) => {
        const permission = contactImport.unknownCount
          ? `${contactImport.unknownCount} contact${contactImport.unknownCount === 1 ? " has" : "s have"} no confirmed newsletter permission in the file, so ${contactImport.unknownCount === 1 ? "it is" : "they are"} staged but not subscribed.`
          : `${contactImport.consentedCount} contact${contactImport.consentedCount === 1 ? " is" : "s are"} marked as consented in the file.`;
        const next = draft ? "I also created the newsletter draft in Campaigns. Review the contacts once, connect a delivery service when ready, then approve the send or schedule." : draftError ? `The contacts are safe; the draft still needs attention: ${draftError}` : "The list is ready in Campaigns for the newsletter draft.";
        return `**${contactImport.sourceName} is now campaign data — not Content Library material.** I parsed ${contactImport.validCount} valid contact${contactImport.validCount === 1 ? "" : "s"}; ${contactImport.duplicateCount} duplicate${contactImport.duplicateCount === 1 ? " was" : "s were"} and ${contactImport.invalidCount} invalid row${contactImport.invalidCount === 1 ? " was" : "s were"} excluded. ${permission} ${next}\n\n**Nothing has been sent.**`;
      }).join("\n\n") : "";
      const newsletterCompletion = data.newsletterAction?.draft
        ? `**Updated in Campaigns.** I changed the primary link in “${data.newsletterAction.draft.content.subject}” to ${data.newsletterAction.requestedUrl || data.newsletterAction.draft.content.ctaUrl} and regenerated the newsletter preview. Campaign tracking was added automatically.\n\n**Nothing has been sent or scheduled.**`
        : "";
      const newsletterLogoCompletion = data.newsletterLogoAction?.draft
        ? `**Updated in Campaigns.** I changed the logo in “${data.newsletterLogoAction.draft.content.subject}” to **${data.newsletterLogoAction.logo?.name || "the selected Brand logo"}** and regenerated the email preview.\n\n**Nothing has been sent or scheduled.**`
        : "";
      const assistantMessage: ProjectChatMessage = { id: crypto.randomUUID(), role: "assistant", content: contactCompletion || newsletterLogoCompletion || newsletterCompletion || String(data.reply || "I saved that."), createdAt: data.createdAt || new Date().toISOString() };
      const workspaceUpdate = data.workspaceUpdate && typeof data.workspaceUpdate === "object" ? data.workspaceUpdate : null;
      const updatedTypographySystems = Array.isArray(workspaceUpdate?.brand?.typographySystems) ? workspaceUpdate.brand.typographySystems : null;
      const refreshedIssueNotes = typeof workspaceUpdate?.notes === "string" && workspaceUpdate.notes !== routedWorkspace.notes ? mergeAnalyzedIssueNotes(routedWorkspace.issueNotes, classifyWorkspaceNotes(workspaceUpdate.notes)) : routedWorkspace.issueNotes;
      const refreshedMedia = workspaceUpdate && Array.isArray(workspaceUpdate.sourceMedia)
        ? workspaceUpdate.sourceMedia.map((item: Partial<SourceMediaAsset>) => ({
          id: item.id || crypto.randomUUID(),
          kind: item.kind === "video" ? "video" as const : "image" as const,
          name: String(item.name || "Source media"),
          url: String(item.url || ""),
          role: String(item.role || "Source media"),
          tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 8) : [],
          recommendation: item.recommendation === "adapt" || item.recommendation === "review" ? item.recommendation : "reuse" as const,
        })).filter((item: SourceMediaAsset) => Boolean(item.url))
        : routedWorkspace.sourceMedia;
      onSave({
        ...routedWorkspace,
        ...(workspaceUpdate || {}),
        issueNotes: refreshedIssueNotes,
        notes: refreshedIssueNotes ? serializeIssueNotes(refreshedIssueNotes) : routedWorkspace.notes,
        acceptedIssueNotes: retainExistingIssueDecisions(routedWorkspace.acceptedIssueNotes, refreshedIssueNotes),
        brand: { ...routedWorkspace.brand, ...(workspaceUpdate?.brand || {}), sourceTypographySystems: updatedTypographySystems ? updatedTypographySystems.filter((system: ProductWorkspace["brand"]["typographySystems"][number]) => system.verified).map((system: ProductWorkspace["brand"]["typographySystems"][number]) => ({ ...system, families: [...system.families] })) : routedWorkspace.brand.sourceTypographySystems || [] },
        sourceMedia: refreshedMedia,
        protectedFields: (Array.isArray(workspaceUpdate?.protectedFields) ? workspaceUpdate.protectedFields : routedWorkspace.protectedFields || []).filter((field: string) => field !== "notes"),
        chatMessages: [...nextHistory, assistantMessage].slice(-80),
        updatedAt: new Date().toISOString(),
      });
      if (stagedContactImports.length) notify(`${stagedContactImports.length === 1 ? "Contact list" : "Contact lists"} staged in Campaigns. Nothing was sent.`);
      else if (data.newsletterLogoAction?.draft) notify("Newsletter logo updated in Campaigns. Nothing was sent.");
      else if (data.newsletterAction?.draft) notify("Newsletter link updated in Campaigns. Nothing was sent.");
      else if (attachmentRecords.length) notify(`${attachmentRecords.length} ${attachmentRecords.length === 1 ? "asset was" : "assets were"} analyzed and placed by the agent.`);
      else if (workspaceUpdate) notify("Brand updated from the latest source evidence.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The project assistant could not reply.");
    } finally {
      setUploadingLabel("");
      setSending(false);
    }
  };

  return <>
    {!open && <button className="op-project-chat-launcher" onClick={onOpen} aria-label="Open project chat"><MessageSquareText size={20} /><span><strong>Ask the agent</strong><small>It remembers this project</small></span></button>}
    {open && <aside className="op-project-chat" aria-label="Project chat">
      <header><span><Sparkles size={17} /></span><div><strong>Project agent</strong><small>{workspace.name || "Current project"} · memory on</small></div><button onClick={onClose} aria-label="Close project chat"><X size={17} /></button></header>
      <div className="op-project-chat__messages" ref={scrollRef}>
        {guide && <div className="assistant op-project-chat__guide"><span><Sparkles size={13} /></span><div><p>{guide.message}</p><div className="op-project-chat__guide-actions">{guide.targetId && <button onClick={onGuideHelp}>Help me connect{guide.targetName ? ` ${guide.targetName}` : ""}</button>}<button className="secondary" onClick={onGuideLater}>I’ll do it later</button></div></div></div>}
        {messages.length === 0 && !guide && <div className="assistant"><span><Sparkles size={13} /></span><p>I’m here throughout the workspace. Ask me anything, correct the strategy, or give me an instruction—I’ll answer and remember it for this project.</p></div>}
        {messages.map((message) => <div className={message.role} key={message.id}><span>{message.role === "assistant" ? <Sparkles size={13} /> : "You"}</span><div className="op-project-chat__message"><p>{message.content}</p>{message.attachments?.length ? <div className="op-project-chat__message-assets">{message.attachments.map((asset) => <span key={asset.id}>{asset.kind === "image" ? <ImageIcon size={12} /> : asset.kind === "video" ? <Video size={12} /> : <FileText size={12} />}<b>{asset.name}</b><small>{asset.destinations.map(assetDestinationLabel).join(" + ")}</small></span>)}</div> : null}</div></div>)}
        {sending && <div className="assistant thinking"><span><LoaderCircle className="spin" size={13} /></span><p>{uploadingLabel || "Reading the project and your message…"}</p></div>}
      </div>
      {attachments.length > 0 && <div className="op-project-chat__attachments">{attachments.map((file, index) => <span key={`${file.name}-${file.size}`}><Paperclip size={12} /><b>{file.name}</b><button onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${file.name}`}><X size={12} /></button></span>)}</div>}
      <div className="op-project-chat__composer"><input ref={attachmentInput} type="file" multiple hidden accept=".pdf,.pptx,.docx,.txt,.md,.csv,.rtf,image/*,video/*" onChange={(event) => addAttachments(event.target.files)} /><button className="attach" onClick={() => attachmentInput.current?.click()} disabled={sending} aria-label="Add assets"><Paperclip size={16} /></button><textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Ask, correct, instruct, or attach an asset…" /><button onClick={() => void send()} disabled={(!draft.trim() && !attachments.length) || sending} aria-label="Send message"><Send size={16} /></button></div>
    </aside>}
  </>;
}

function assetDestinationLabel(value: string) {
  return ({ content: "Content Library", brand: "Brand", campaign: "Campaign" } as Record<string, string>)[value] || value;
}

function isBrandSourceRefreshInstruction(value: string) {
  const message = value.toLowerCase();
  const changeLanguage = /\b(upd\w*|refresh\w*|rebuild\w*|reread\w*|rerun\w*|re-run|sync\w*|chang\w*|new|latest|reflect\w*|revis\w*|based)\b/i.test(message);
  return (changeLanguage && /\b(brand|brain|profile|identity)\b/i.test(message))
    || (/\b(website|web\s*site|site|source|deck|figma|slides?|presentation|pptx|powerpoint)\b/i.test(message) && (changeLanguage || /\b(read|review|check|analy[sz]\w*)\b/i.test(message)));
}

function isTypographyInspectionInstruction(value: string) {
  const message = value.toLowerCase();
  return /\b(fonts?|typefaces?|typography)\b/i.test(message)
    && /\b(deck|figma|slides?|presentation|pptx|powerpoint)\b/i.test(message)
    && /\b(find|identify|detect|inspect|check|verify|used?|uses?|which|what)\b/i.test(message);
}

function AssistantRoutine({ schedule, automationReady, connections, onSchedule }: { schedule: AgentSchedule; automationReady: boolean; connections: ConnectionStatus; onSchedule: (schedule: AgentSchedule) => void }) {
  const eligible = (["linkedin", "instagram", "x", "discord"] as const).filter((channel) => connections[channel].canPublish);
  const toggleTrusted = (channel: typeof eligible[number]) => onSchedule({ ...schedule, trustedChannels: schedule.trustedChannels.includes(channel) ? schedule.trustedChannels.filter((item) => item !== channel) : [...schedule.trustedChannels, channel] });
  const description = schedule.autonomyLevel === "publish" ? "Each morning, the assistant measures results, prepares exact items, and schedules only the channels you explicitly trust below." : schedule.autonomyLevel === "prepare" ? "Each morning, the assistant measures results and prepares exact campaign items for one review." : "Each morning, the assistant measures results and creates a new draft. Nothing is scheduled or published.";
  return <section className="op-schedule-card op-assistant-routine"><div><span><Bot size={18} /></span><div><small>OPTIONAL ASSISTANT ROUTINE</small><strong>Daily project pulse</strong><p>{description}</p></div><label className="op-switch"><input type="checkbox" checked={schedule.enabled} disabled={!automationReady} onChange={(event) => onSchedule({ ...schedule, enabled: event.target.checked })} /><i /></label></div><div className="op-schedule-fields"><label><span>What should it prepare?</span><select value={schedule.action} onChange={(event) => onSchedule({ ...schedule, action: event.target.value as AgentSchedule["action"] })}><option value="research">Market pulse</option><option value="audience">Audience changes</option><option value="campaign">Campaign opportunities</option><option value="social">Social content ideas</option></select></label><label><span>Autonomy</span><select value={schedule.autonomyLevel} onChange={(event) => onSchedule({ ...schedule, autonomyLevel: event.target.value as AgentSchedule["autonomyLevel"] })}><option value="draft">Draft only</option><option value="prepare">Prepare for approval</option><option value="publish">Publish on trusted channels</option></select></label><label className="wide"><span>Standing direction</span><textarea value={schedule.prompt} onChange={(event) => onSchedule({ ...schedule, prompt: event.target.value })} /></label></div>{schedule.autonomyLevel === "publish" && <div className="op-routine-trust"><strong>Trusted channels</strong><p>Email, paid media, TikTok, YouTube, Shopify, and Reddit always require separate approval.</p>{eligible.length ? <div>{eligible.map((channel) => <label key={channel}><input type="checkbox" checked={schedule.trustedChannels.includes(channel)} onChange={() => toggleTrusted(channel)} /> {deliveryChannelLabel(channel)}</label>)}</div> : <small>Connect LinkedIn, Instagram, X, or Discord before enabling trusted publishing.</small>}</div>}<small>{!automationReady ? "Connect your own APIs or activate the managed plan to run this routine in the cloud." : schedule.lastRunAt ? `Last automatic cycle: ${new Date(schedule.lastRunAt).toLocaleString()}` : "No automatic cycle has run yet."}</small></section>;
}

function AgentHome({ workspace, runs, health, connections, schedule, automationReady, onSchedule, onRun, onIssuesFound, onOpen, onNavigate, notify }: { workspace: ProductWorkspace; runs: AgentRun[]; health: HealthState; connections: ConnectionStatus; schedule: AgentSchedule; automationReady: boolean; onSchedule: (schedule: AgentSchedule) => void; onRun: (run: AgentRun) => void; onIssuesFound: (projectId: string, findings: IssueFindings | undefined) => void; onOpen: (id: string) => void; onNavigate: (page: Page) => void; notify: (message: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState<AgentAction | null>(null);
  const [useWeb, setUseWeb] = useState(true);
  const [balancedPanel, setBalancedPanel] = useState(true);
  const [pendingCampaign, setPendingCampaign] = useState<{ action: AgentAction; direction: string } | null>(null);
  const complete = workspaceCompleteness(workspace);
  const connectedChannels = [
    connections.gmail.canSend && "Email",
    connections.linkedin.canPublish && "LinkedIn",
    connections.instagram.canPublish && "Instagram",
    connections.tiktok.canPublish && "TikTok",
    connections.youtube.canPublish && "YouTube",
    connections.x.canPublish && "X",
    connections.discord.canPublish && "Discord",
    connections.reddit.canPublish && "Reddit",
    connections.mailchimp.canManage && "Newsletter",
  ].filter(Boolean) as string[];

  const executeRun = async (action: AgentAction, direction: string, intensity: CampaignIntensity) => {
    setRunning(action);
    try {
      const response = await apiFetch("/api/agent", { method: "POST", body: JSON.stringify({ action, prompt: direction, workspace, projectId: workspace.id, useWeb, mode: balancedPanel ? "panel" : "single", intensity }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Agent run failed.");
      onRun(data.run as AgentRun);
      const campaignScoped = isCampaignRequest(action, direction);
      if (!campaignScoped) onIssuesFound(workspace.id, data.issueFindings as IssueFindings | undefined);
      setPrompt("");
      const findingCount = (data.issueFindings?.high?.length || 0) + (data.issueFindings?.attention?.length || 0);
      notify(findingCount ? campaignScoped ? `Campaign saved with ${findingCount} ${findingCount === 1 ? "check" : "checks"} inside the campaign.` : "Work saved. The agent also added new findings to Issues." : "Real agent run completed and saved.");
    } catch (error) { notify(error instanceof Error ? error.message : "Agent run failed."); }
    finally { setRunning(null); }
  };

  const requestRun = (action: AgentAction, overridePrompt?: string) => {
    if (complete < 35) { onNavigate("brain"); notify("Add the core product facts before running the agent."); return; }
    if (!health.agentConfigured) { onNavigate("integrations"); notify("Connect either OpenAI or Gemini to start real work."); return; }
    const direction = overridePrompt ?? prompt;
    if (isCampaignRequest(action, direction)) {
      setPendingCampaign({ action, direction });
      return;
    }
    void executeRun(action, direction, "assertive");
  };

  const chooseIntensity = (intensity: CampaignIntensity) => {
    if (!pendingCampaign) return;
    const pending = pendingCampaign;
    setPendingCampaign(null);
    void executeRun(pending.action, pending.direction, intensity);
  };

  return <><div className="op-stack">
    <section className="op-hero"><div className="op-eyebrow"><WandSparkles size={14} /> {workspace.name || "Active project"}</div><h1>What should Market Agent<br />do for this project?</h1><p>Research the live market, turn project truth into campaigns, and create reviewable channel work. The agent completes the work it can do; publishing still requires connected accounts.</p><div className="op-command"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={`Give the agent a specific task for ${workspace.name || "this project"}…`} /><div><span className="op-command-options"><label><input type="checkbox" checked={useWeb} onChange={(event) => setUseWeb(event.target.checked)} /> <Globe2 size={14} /> Live web research</label><label title="Several independent analyses are combined into one execution package."><input type="checkbox" checked={balancedPanel} onChange={(event) => setBalancedPanel(event.target.checked)} /> <UsersRound size={14} /> Balanced review</label></span><button disabled={Boolean(running) || !prompt.trim()} onClick={() => requestRun("chat")}>{running === "chat" ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />} Run task</button></div></div></section>
    <section className={`op-delivery-alert ${connectedChannels.length ? "connected" : ""}`}><span>{connectedChannels.length ? <Check size={18} /> : <Send size={18} />}</span><div><strong>{connectedChannels.length ? `${connectedChannels.join(", ")} ${connectedChannels.length === 1 ? "is" : "are"} connected` : "No delivery channels are connected"}</strong><p>{connectedChannels.length ? "The agent can prepare work for the authorized channels. Publishing still follows campaign approval and each network’s rules." : "The agent can research, select targets, and prepare final messages. It cannot email, message, or publish until an account is authorized."}</p></div><button onClick={() => onNavigate("integrations")}>{connectedChannels.length ? "Manage connections" : "Connection setup"} <ArrowRight size={14} /></button></section>
    {!health.agentConfigured && <section className="op-alert"><CircleAlert size={19} /><div><strong>Connect one core API to start real work.</strong><p>OpenAI or Gemini unlocks reasoning and image creation. Adding all three private APIs gives the strongest strategy review.</p></div><button onClick={() => onNavigate("integrations")}>Connect APIs <ArrowRight size={14} /></button></section>}
    <AssistantRoutine schedule={schedule} automationReady={automationReady} connections={connections} onSchedule={onSchedule} />
    <section><div className="op-section-head"><div><span>Run a complete workflow</span><h2>Real work, saved to the workspace</h2></div></div><div className="op-action-grid">{(["research", "audience", "campaign", "social"] as AgentAction[]).map((action) => { const icons = { research: Globe2, audience: UsersRound, campaign: Rocket, social: MessageSquareText, chat: Bot }; const Icon = icons[action]; return <button key={action} onClick={() => requestRun(action)} disabled={Boolean(running)}><span><Icon size={19} /></span><div><strong>{actionMeta[action].title}</strong><p>{actionMeta[action].description}</p></div>{running === action ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}</button>; })}</div></section>
    <section><div className="op-section-head"><div><span>Workspace record</span><h2>Recent work</h2></div><small>{runs.length} saved {runs.length === 1 ? "run" : "runs"}</small></div>{runs.length ? <div className="op-run-list">{runs.slice(0, 6).map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div> : <EmptyWorkspace onStart={() => onNavigate("brain")} />}</section>
  </div>{pendingCampaign && <><button className="op-intensity-scrim" aria-label="Close campaign style question" onClick={() => setPendingCampaign(null)} /><aside className="op-intensity-panel"><header><span><Rocket size={18} /></span><div><small>One campaign decision</small><strong>How aggressive should this campaign be?</strong></div><button aria-label="Close" onClick={() => setPendingCampaign(null)}><X size={17} /></button></header><div className="op-intensity-body"><p>The agent will do the research, targeting, copy, sequence, and tracking. Choose the pace and pressure.</p><button className="aggressive" onClick={() => chooseIntensity("aggressive")}><span><strong>Aggressive</strong><em>Recommended for this goal</em></span><small>Large first wave, parallel channels, direct commercial language, strong calls to action, fast follow-up.</small><ArrowRight size={16} /></button><button onClick={() => chooseIntensity("assertive")}><span><strong>Assertive</strong></span><small>Meaningful volume, decisive messaging, and fast execution with regular review points.</small><ArrowRight size={16} /></button><button onClick={() => chooseIntensity("careful")}><span><strong>Careful</strong></span><small>Smaller waves, softer calls to action, and more validation before scaling.</small><ArrowRight size={16} /></button><div className="op-intensity-note"><ShieldCheck size={15} /><span>Aggressive changes speed and tactics—not truthfulness, consent, or opt-out rules.</span></div></div></aside></>}</>;
}

function isCampaignRequest(action: AgentAction, direction: string) {
  return action === "campaign" || action === "social" || /\b(campaign|outreach|buyer|buyers|prospect|prospects|lead|leads|pipeline|acquisition|sales|launch|demo shares?|reach\s+\d|growth)\b/i.test(direction);
}

function isCampaignRun(run: AgentRun) {
  return isCampaignRequest(run.action, run.prompt || "");
}

function ProductBrain({ userId, workspace, onSave, onOpenContentLibrary, notify }: { userId: string; workspace: ProductWorkspace; onSave: (workspace: ProductWorkspace) => void; onOpenContentLibrary: () => void; notify: (message: string) => void }) {
  const [form, setForm] = useState<ProductWorkspace>(workspace);
  const [materials, setMaterials] = useState<PreparedMaterial[]>([]);
  const [links, setLinks] = useState<string[]>(() => workspace.sources.map((source) => source.url));
  const [linkInput, setLinkInput] = useState("");
  const [processing, setProcessing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [intakeError, setIntakeError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(() => workspaceCompleteness(workspace) > 20);
  const [reviewSummary, setReviewSummary] = useState(workspace.reviewSummary || "");
  const [unknowns, setUnknowns] = useState<string[]>(() => filterHandledQuestions(filterSourceBackedBrandQuestions(workspace.openQuestions || [], workspace), workspace.questionAnswers || {}));
  const [answers, setAnswers] = useState<Record<string, string>>(workspace.questionAnswers || {});
  const [additionalContext, setAdditionalContext] = useState(workspace.additionalContextDraft || "");
  const [refining, setRefining] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(() => filterHandledQuestions(filterSourceBackedBrandQuestions(workspace.openQuestions || [], workspace), workspace.questionAnswers || {}).length > 0);
  const [questionIndex, setQuestionIndex] = useState(() => {
    const questions = filterHandledQuestions(filterSourceBackedBrandQuestions(workspace.openQuestions || [], workspace), workspace.questionAnswers || {});
    const savedAnswers = workspace.questionAnswers || {};
    return firstUnhandledQuestionIndex(questions, savedAnswers);
  });
  const [chatDraft, setChatDraft] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const metadataRefreshKey = useRef("");

  useEffect(() => {
    const questions = filterHandledQuestions(filterSourceBackedBrandQuestions(workspace.openQuestions || [], workspace), workspace.questionAnswers || {});
    setForm(workspace);
    setReviewSummary(workspace.reviewSummary || "");
    setUnknowns(questions);
    setAnswers(workspace.questionAnswers || {});
    setQuestionIndex(firstUnhandledQuestionIndex(questions, workspace.questionAnswers || {}));
  }, [workspace.id, workspace.updatedAt]);

  useEffect(() => {
    const unresolved = (workspace.sources || []).filter((source) => sourceNeedsTitleRefresh(source));
    if (!unresolved.length) return;
    const key = `${workspace.id}:${unresolved.map((source) => source.url).join("|")}`;
    if (metadataRefreshKey.current === key) return;
    metadataRefreshKey.current = key;
    let active = true;
    apiFetch("/api/source-metadata", { method: "POST", body: JSON.stringify({ links: unresolved.map((source) => source.url) }) })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Source details could not be read.");
        if (!active || !Array.isArray(data.sources)) return;
        const nextSources = mergeConnectedSourceMetadata(workspace.sources || [], data.sources);
        if (nextSources.some((source, index) => source.label !== workspace.sources[index]?.label)) {
          onSave({ ...workspace, sources: nextSources, updatedAt: new Date().toISOString() });
        }
      })
      .catch(() => { /* Generic labels remain usable when a public title is temporarily unavailable. */ });
    return () => { active = false; };
  }, [workspace.id, workspace.updatedAt]);

  const change = (field: keyof ProductWorkspace, value: string) => setForm((current) => ({ ...current, [field]: value }));
  const changeBrand = (field: keyof ProductWorkspace["brand"], value: string) => setForm((current) => ({ ...current, brand: { ...current.brand, [field]: value } }));

  const uploadLogo = async (file?: File) => {
    if (!file) return;
    setLogoUploading(true);
    setLogoError("");
    try {
      const preparedDataUrl = await prepareLogo(file);
      const imageBlob = await (await fetch(preparedDataUrl)).blob();
      const token = await getAccessToken();
      const safeBase = file.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 120) || "logo";
      const pathname = `market-agent-assets/${encodeURIComponent(userId)}/${encodeURIComponent(workspace.id)}/brand-logos/${Date.now()}-${safeBase}.png`;
      const uploaded = await Promise.race([upload(pathname, imageBlob, {
        access: "private",
        handleUploadUrl: "/api/asset-upload",
        clientPayload: JSON.stringify({ projectId: workspace.id }),
        headers: { Authorization: `Bearer ${token}` },
        contentType: "image/png",
      }), new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("The logo upload timed out. Please try again.")), 45_000))]);
      const accessResponse = await apiFetch("/api/brand-logo", { method: "POST", body: JSON.stringify({ projectId: workspace.id, pathname: uploaded.pathname }) });
      const access = await accessResponse.json();
      if (!accessResponse.ok || !access.url) throw new Error(access.error || "The email-safe logo link could not be created.");
      setForm((current) => {
        const first = !(current.brand.logoVariants || []).length;
        const variant: BrandLogoVariant = { id: crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, ""), url: access.url, usage: first ? "primary" : "other", createdAt: new Date().toISOString() };
        const logoVariants = [...(current.brand.logoVariants || []), variant].slice(0, 10);
        return { ...current, brand: { ...current.brand, logoVariants, logoDataUrl: first ? variant.url : current.brand.logoDataUrl, logoName: first ? variant.name : current.brand.logoName } };
      });
      setIntakeError("");
      notify("Logo variant added. Save corrections when the set is ready.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The logo could not be read.";
      setLogoError(message);
      setIntakeError(message);
    } finally {
      setLogoUploading(false);
      if (logoInput.current) logoInput.current.value = "";
    }
  };

  const updateLogoVariant = (id: string, changes: Partial<BrandLogoVariant>) => setForm((current) => {
    let logoVariants = (current.brand.logoVariants || []).map((variant) => variant.id === id ? { ...variant, ...changes } : variant);
    if (changes.usage === "primary") logoVariants = logoVariants.map((variant) => variant.id === id ? { ...variant, usage: "primary" as const } : variant.usage === "primary" ? { ...variant, usage: "other" as const } : variant);
    const primary = logoVariants.find((variant) => variant.usage === "primary") || logoVariants[0];
    return { ...current, brand: { ...current.brand, logoVariants, logoDataUrl: primary?.url || "", logoName: primary?.name || "" } };
  });

  const removeLogoVariant = (id: string) => setForm((current) => {
    let logoVariants = (current.brand.logoVariants || []).filter((variant) => variant.id !== id);
    if (logoVariants.length && !logoVariants.some((variant) => variant.usage === "primary")) logoVariants = logoVariants.map((variant, index) => index === 0 ? { ...variant, usage: "primary" as const } : variant);
    const primary = logoVariants.find((variant) => variant.usage === "primary") || logoVariants[0];
    return { ...current, brand: { ...current.brand, logoVariants, logoDataUrl: primary?.url || "", logoName: primary?.name || "" } };
  });

  const processFiles = async (files: FileList | File[]) => {
    const incoming = Array.from(files).slice(0, Math.max(0, 12 - materials.length));
    if (!incoming.length) return;
    setProcessing(true);
    setIntakeError("");
    const prepared: PreparedMaterial[] = [];
    const errors: string[] = [];
    for (const file of incoming) {
      try {
        prepared.push(await prepareMaterial(file));
      } catch (error) {
        errors.push(error instanceof Error ? error.message : `${file.name} could not be read.`);
      }
    }
    setMaterials((current) => [...current, ...prepared].slice(0, 12));
    if (errors.length) setIntakeError(errors.join(" "));
    setProcessing(false);
  };

  const addLink = () => {
    if (!linkInput.trim()) return;
    try {
      let url = linkInput.trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      new URL(url);
      setLinks((current) => current.includes(url) ? current : [...current, url].slice(0, 15));
      setLinkInput("");
      setIntakeError("");
    } catch {
      setIntakeError("Paste a complete, shareable link.");
    }
  };

  const build = async () => {
    const pendingLinks = [...links];
    if (linkInput.trim()) {
      try {
        let url = linkInput.trim();
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        new URL(url);
        if (!pendingLinks.includes(url)) pendingLinks.push(url);
        setLinks(pendingLinks);
        setLinkInput("");
      } catch {
        setIntakeError("Paste a complete, shareable link.");
        return;
      }
    }
    if (!materials.length && !pendingLinks.length) {
      setIntakeError("Upload at least one file or add a source link.");
      return;
    }
    setBuilding(true);
    setIntakeError("");
    try {
      const response = await apiFetch("/api/onboard", {
        method: "POST",
        body: JSON.stringify({ projectId: workspace.id, projectName: form.name, workspace: form, materials: compactMaterialsForUpload(materials), links: pendingLinks }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The Brand could not be built.");
      const retainedAnswers = { ...(form.questionAnswers || {}), ...answers };
      const nextQuestions = filterHandledQuestions(Array.isArray(data.unknowns) ? data.unknowns : [], retainedAnswers);
      const sources = mergeConnectedSourceMetadata(
        pendingLinks.map((url) => form.sources.find((source) => sameSourceUrl(source.url, url)) || ({ id: crypto.randomUUID(), label: connectedSourceLabel(url), url })),
        Array.isArray(data.sourceMetadata) ? data.sourceMetadata : [],
      );
      const addedAt = new Date().toISOString();
      const materialRecords = [
        ...(workspace.materials || []),
        ...materials.map((material) => ({ id: crypto.randomUUID(), name: material.name, kind: material.kind, addedAt })),
      ].filter((material, index, all) => all.findIndex((candidate) => candidate.name === material.name) === index);
      const extractedMedia: SourceMediaAsset[] = (Array.isArray(data.sourceMedia) ? data.sourceMedia : []).map((item: Partial<SourceMediaAsset>) => ({
        id: crypto.randomUUID(),
        kind: item.kind === "video" ? "video" : "image",
        name: String(item.name || "Source media"),
        url: String(item.url || ""),
        role: String(item.role || "Source media"),
        tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 8) : [],
        recommendation: item.recommendation === "adapt" || item.recommendation === "review" ? item.recommendation : "reuse",
      })).filter((item: SourceMediaAsset) => /^https?:\/\//i.test(item.url) || /^data:image\/(?:svg\+xml|png|jpe?g|webp);base64,/i.test(item.url));
      const sourceMedia = (extractedMedia.length > 0 ? extractedMedia : (workspace.sourceMedia || []))
        .filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index)
        .slice(0, 40);
      const refreshedIssueNotes = typeof data.brain?.notes === "string" && data.brain.notes !== form.notes
        ? mergeAnalyzedIssueNotes(form.issueNotes, classifyWorkspaceNotes(data.brain.notes))
        : form.issueNotes;
      const updated: ProductWorkspace = {
        ...form,
        ...data.brain,
        issueNotes: refreshedIssueNotes,
        notes: refreshedIssueNotes ? serializeIssueNotes(refreshedIssueNotes) : form.notes,
        acceptedIssueNotes: retainExistingIssueDecisions(form.acceptedIssueNotes, refreshedIssueNotes),
        brand: { ...form.brand, ...(data.brain?.brand || {}), sourceTypographySystems: Array.isArray(data.brain?.brand?.typographySystems) ? data.brain.brand.typographySystems.filter((system: ProductWorkspace["brand"]["typographySystems"][number]) => system.verified).map((system: ProductWorkspace["brand"]["typographySystems"][number]) => ({ ...system, families: [...system.families] })) : form.brand.sourceTypographySystems || [] },
        sources,
        materials: materialRecords,
        sourceMedia,
        reviewSummary: data.reviewSummary || "The Brand is ready for review.",
        openQuestions: nextQuestions,
        questionAnswers: retainedAnswers,
        additionalContextDraft: "",
        sourceWarnings: Array.isArray(data.sourceWarnings) ? data.sourceWarnings : [],
        protectedFields: (form.protectedFields || []).filter((field) => field !== "notes"),
        updatedAt: addedAt,
      };
      setForm(updated);
      onSave(updated);
      setReviewSummary(data.reviewSummary || "The Brand is ready for review.");
      setUnknowns(nextQuestions);
      setAnswers(retainedAnswers);
      setQuestionIndex(firstUnhandledQuestionIndex(nextQuestions, retainedAnswers));
      setChatDraft("");
      setAssistantOpen(nextQuestions.length > 0);
      setReviewOpen(true);
      setMaterials([]);
      notify("Brand built and saved. Review only what needs correction.");
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "The Brand could not be built.");
    } finally {
      setBuilding(false);
    }
  };

  const applyAnswers = async () => {
    const retainedAnswers = { ...(form.questionAnswers || {}), ...answers };
    const suppliedAnswers = unknowns
      .map((question) => ({ question, answer: retainedAnswers[question]?.trim() || "" }))
      .filter((item) => item.answer && item.answer !== SKIPPED_ANSWER);
    const remainingBeforeRefine = filterHandledQuestions(unknowns, retainedAnswers);
    if (!suppliedAnswers.length && !additionalContext.trim()) {
      if (remainingBeforeRefine.length === unknowns.length) {
        setIntakeError("Answer a question, choose I don’t know, or add some context first.");
        return;
      }
      const updated: ProductWorkspace = {
        ...form,
        reviewSummary: "No more confirmations are waiting. You can add missing details later if they become available.",
        openQuestions: remainingBeforeRefine,
        questionAnswers: retainedAnswers,
        additionalContextDraft: "",
        updatedAt: new Date().toISOString(),
      };
      setForm(updated);
      onSave(updated);
      setReviewSummary(updated.reviewSummary);
      setUnknowns(remainingBeforeRefine);
      setAnswers(retainedAnswers);
      setAdditionalContext("");
      setQuestionIndex(firstUnhandledQuestionIndex(remainingBeforeRefine, retainedAnswers));
      setAssistantOpen(remainingBeforeRefine.length > 0);
      notify("The assistant remembered your choices and closed those questions.");
      return;
    }
    setRefining(true);
    setIntakeError("");
    try {
      const response = await apiFetch("/api/refine", { method: "POST", body: JSON.stringify({ workspace: form, answers: suppliedAnswers, additionalContext }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The answers could not be applied.");
      const nextQuestions = filterHandledQuestions(Array.isArray(data.unknowns) ? data.unknowns : [], retainedAnswers);
      const refreshedIssueNotes = typeof data.brain?.notes === "string" && data.brain.notes !== form.notes
        ? mergeAnalyzedIssueNotes(form.issueNotes, classifyWorkspaceNotes(data.brain.notes))
        : form.issueNotes;
      const updated: ProductWorkspace = {
        ...form,
        ...data.brain,
        issueNotes: refreshedIssueNotes,
        notes: refreshedIssueNotes ? serializeIssueNotes(refreshedIssueNotes) : form.notes,
        acceptedIssueNotes: retainExistingIssueDecisions(form.acceptedIssueNotes, refreshedIssueNotes),
        brand: { ...form.brand, ...(data.brain?.brand || {}) },
        reviewSummary: data.reviewSummary || "Your answers have been applied.",
        openQuestions: nextQuestions,
        questionAnswers: retainedAnswers,
        additionalContextDraft: "",
        protectedFields: (form.protectedFields || []).filter((field) => field !== "notes"),
        updatedAt: new Date().toISOString(),
      };
      setForm(updated);
      onSave(updated);
      setReviewSummary(updated.reviewSummary);
      setUnknowns(updated.openQuestions);
      setAnswers(retainedAnswers);
      setAdditionalContext("");
      setQuestionIndex(firstUnhandledQuestionIndex(nextQuestions, retainedAnswers));
      setChatDraft("");
      setAssistantOpen(updated.openQuestions.length > 0);
      setReviewOpen(true);
      notify("Your answers were applied and the Brand was updated.");
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "The answers could not be applied.");
    } finally {
      setRefining(false);
    }
  };

  const sendChatAnswer = () => {
    const question = unknowns[questionIndex];
    if (!question || !chatDraft.trim()) return;
    const nextAnswers = { ...(form.questionAnswers || {}), ...answers, [question]: chatDraft.trim() };
    const updated = { ...form, questionAnswers: nextAnswers, updatedAt: new Date().toISOString() };
    setAnswers(nextAnswers);
    setForm(updated);
    onSave(updated);
    setChatDraft("");
    setQuestionIndex((index) => Math.min(unknowns.length, index + 1));
  };

  const skipChatQuestion = () => {
    const question = unknowns[questionIndex];
    if (!question) return;
    const nextAnswers = { ...(form.questionAnswers || {}), ...answers, [question]: SKIPPED_ANSWER };
    const updated = { ...form, questionAnswers: nextAnswers, updatedAt: new Date().toISOString() };
    setAnswers(nextAnswers);
    setForm(updated);
    onSave(updated);
    setChatDraft("");
    setQuestionIndex((index) => Math.min(unknowns.length, index + 1));
  };

  const updateAdditionalContext = (value: string) => {
    const updated = { ...form, additionalContextDraft: value, updatedAt: new Date().toISOString() };
    setAdditionalContext(value);
    setForm(updated);
    onSave(updated);
  };

  const save = () => {
    const protectedFields = Array.from(new Set([...(form.protectedFields || []).filter((field) => field !== "notes"), ...changedBrainFields(workspace, form)]));
    const updated = { ...form, protectedFields, sources: links.map((url) => form.sources.find((source) => sameSourceUrl(source.url, url)) || ({ id: crypto.randomUUID(), label: connectedSourceLabel(url), url })), updatedAt: new Date().toISOString() };
    onSave(updated);
    setForm(updated);
    notify("Corrections saved to the cloud.");
  };

  const updateTypographySystems = (typographySystems: ProductWorkspace["brand"]["typographySystems"]) => setForm((current) => {
    const sourceTypographySystems = current.brand.sourceTypographySystems?.length
      ? current.brand.sourceTypographySystems
      : current.brand.typographySystems.map((system) => ({ ...system, families: [...system.families] }));
    const activeFamilies = new Set(typographySystems.flatMap((system) => system.families).map((family) => family.toLowerCase()));
    return { ...current, brand: { ...current.brand, typographySystems, sourceTypographySystems, fontFamilies: typographySystems.flatMap((system) => system.families).filter((family, index, all) => all.findIndex((candidate) => candidate.toLowerCase() === family.toLowerCase()) === index), fontSources: current.brand.fontSources.filter((source) => activeFamilies.has(source.family.toLowerCase())) } };
  });

  const savedMaterials = workspace.materials || [];
  const hasBrain = workspaceCompleteness(form) > 20;
  const canApplyAnswers = Boolean(additionalContext.trim()) || unknowns.some((question) => isQuestionHandled(answers, question));

  return <div className="op-stack op-brain-onboarding">
    <div className="op-heading"><div className="op-eyebrow">Brand onboarding</div><h1>Give Market Agent the material.<br />It will build the Brand.</h1><p>The agent extracts the strategy and identity from your sources. You only review and correct what it misunderstood.</p></div>

    <section className="op-intake-card">
      <div className="op-intake-grid">
        <div className="op-upload-panel">
          <div className="op-card-head"><div><strong>Upload project material</strong><small>Decks, documents, images, and video</small></div><UploadCloud size={20} /></div>
          <input ref={fileInput} hidden type="file" multiple accept=".pdf,.pptx,.docx,.txt,.md,.csv,.rtf,image/*,video/*" onChange={(event) => event.target.files && void processFiles(event.target.files)} />
          <button className="op-dropzone" onClick={() => fileInput.current?.click()} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void processFiles(event.dataTransfer.files); }}>
            {processing ? <LoaderCircle className="spin" size={28} /> : <UploadCloud size={28} />}
            <strong>{processing ? "Reading your material…" : "Drop files here or choose files"}</strong>
            <span>PDF · PowerPoint · Word · text · images · video</span>
          </button>
        </div>

        <div className="op-connect-panel">
          <div className="op-card-head"><div><strong>Connect source links</strong><small>Shareable or public sources</small></div><Link2 size={20} /></div>
          <div className="op-connector-pills"><span><SourceServiceIcon compact url="https://docs.google.com/presentation/d/example" />Google Slides</span><span><SourceServiceIcon compact url="https://www.figma.com/deck/example" />Figma</span><span><SourceServiceIcon compact url="https://example.com" />Website</span></div>
          <div className="op-link-entry"><input value={linkInput} onChange={(event) => setLinkInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addLink(); } }} placeholder="Paste a Google Slides, Figma, or website link" /><button onClick={addLink}><Plus size={15} /> Add</button></div>
          <p>External-view Google Slides and Figma decks are read directly. If link access is off, Market Agent will tell you exactly what to enable.</p>
        </div>
      </div>

      {(materials.length > 0 || links.length > 0 || savedMaterials.length > 0) && <div className="op-material-list">
        {savedMaterials.map((material) => <div key={material.id} className="saved"><FileCheck2 size={16} /><span><strong>{material.name}</strong><small>Already included</small></span><Check size={14} /></div>)}
        {materials.map((material, index) => <div key={`${material.name}-${index}`}><MaterialIcon kind={material.kind} /><span><strong>{material.name}</strong><small>{material.detail}</small></span><button onClick={() => setMaterials((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></div>)}
        {links.map((url) => <div key={url}><SourceServiceIcon url={url} /><span><strong>{sourceLabelForUrl(url, form.sources)}</strong><small>{url}</small></span><button onClick={() => setLinks((current) => current.filter((item) => item !== url))}><X size={14} /></button></div>)}
      </div>}

      {(form.sourceMedia || []).length > 0 && <SourceMediaStrip media={form.sourceMedia || []} onOpenLibrary={onOpenContentLibrary} />}

      <div className="op-source-guidance">
        <div><strong>When sources disagree</strong><span>Choose which source should lead. The agent still extracts and compares everything.</span></div>
        <div className="op-source-priority" role="group" aria-label="Source priority">
          {([
            ["best-evidence", "Best evidence", "Recommended"],
            ["website", "Website leads", "Current public brand"],
            ["deck", "Deck leads", "Intended direction"],
          ] as const).map(([value, label, detail]) => <button key={value} className={form.sourcePriority === value ? "active" : ""} onClick={() => setForm((current) => ({ ...current, sourcePriority: value }))}><strong>{label}</strong><span>{detail}</span></button>)}
        </div>
        <label><span>Source notes <em>Optional</em></span><textarea value={form.sourceGuidance} onChange={(event) => setForm((current) => ({ ...current, sourceGuidance: event.target.value }))} placeholder="Example: the deck has the new visual identity; the website has the most current product information." /></label>
      </div>

      {intakeError && <div className="op-intake-error"><CircleAlert size={16} />{intakeError}</div>}
      <div className="op-build-row"><div><strong>{hasBrain ? "Update the Brand" : "Build the Brand for me"}</strong><span>The agent extracts segmentation, positioning, manifesto, and visual identity.</span></div><button disabled={building || processing || (!materials.length && !links.length && !linkInput.trim())} onClick={() => void build()}>{building ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{building ? "Building…" : hasBrain ? "Update from sources" : "Build it for me"}</button></div>
    </section>

    {form.sourceWarnings.length > 0 && <section className="op-source-warning"><CircleAlert size={18} /><div><strong>Some connected sources need access</strong>{form.sourceWarnings.map((warning) => <p key={warning}>{warning}</p>)}</div></section>}

    {(reviewSummary || unknowns.length > 0) && <section className="op-brain-result"><Check size={20} /><div><strong>{reviewSummary || "Brand ready"}</strong>{unknowns.length > 0 && <span>{unknowns.length} {unknowns.length === 1 ? "detail needs" : "details need"} your confirmation.</span>}</div>{unknowns.length > 0 && <button onClick={() => setAssistantOpen(true)}><MessageSquareText size={15} /> Continue with project assistant</button>}</section>}

    <section className={`op-review-editor ${reviewOpen ? "open" : ""}`}>
      <button className="op-review-toggle" onClick={() => setReviewOpen((open) => !open)}><span><strong>Review and correct the Brand</strong><small>Only change what the agent misunderstood or could not find.</small></span><ChevronDown size={18} /></button>
      {reviewOpen && <div className="op-form-card">
        <section className="op-brand-editor">
          <div className="op-card-head"><div><strong>Brand strategy</strong><small>Segmentation, positioning, manifesto, and voice—extracted from your sources</small></div><BrainCircuit size={19} /></div>
          <div className="op-form-grid">
            <Field wide label="Brand segmentation" value={form.segmentation} onChange={(value) => change("segmentation", value)} placeholder="Distinct audience segments, needs, behaviors, triggers, and priorities" multiline />
            <Field wide label="Brand positioning" value={form.positioning} onChange={(value) => change("positioning", value)} placeholder="Competitive frame, differentiation, value, reasons to believe, and intended perception" multiline />
            <Field wide label="Brand manifesto" value={form.manifesto} onChange={(value) => change("manifesto", value)} placeholder="The brand's belief, purpose, point of view, and ambition" multiline />
            <Field label="Brand voice" value={form.voice} onChange={(value) => change("voice", value)} placeholder="Tone, language, cadence, and personality" multiline />
            <Field label="Claims and guardrails" value={form.guardrails} onChange={(value) => change("guardrails", value)} placeholder="Approved proof and prohibited claims" multiline />
          </div>
        </section>
        <section className="op-brand-editor">
          <div className="op-card-head"><div><strong>Brand identity</strong><small>Name, logo, color, look and feel, typography, and photography</small></div><ImageIcon size={19} /></div>
          <div className="op-form-grid"><Field label="Brand name" value={form.name} onChange={(value) => change("name", value)} placeholder="Brand name" /><Field label="Website" value={form.website} onChange={(value) => change("website", value)} placeholder="https://…" /></div>
          <div className="op-brand-grid">
            <div className="op-logo-library">
              <div className="op-logo-library__head"><div><strong>Logo variants</strong><small>Keep the primary mark, email version, light and dark versions, and the small icon together. Email uses the version marked Email, then Primary as fallback.</small></div><input ref={logoInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(event) => void uploadLogo(event.target.files?.[0])} /><button disabled={logoUploading || (form.brand.logoVariants || []).length >= 10} onClick={() => logoInput.current?.click()}>{logoUploading ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{logoUploading ? "Adding…" : "Add logo"}</button></div>
              {logoError && <div className="op-logo-library__error"><CircleAlert size={14} /><span>{logoError}</span><button onClick={() => logoInput.current?.click()}>Try again</button></div>}
              {(form.brand.logoVariants || []).length ? <div className="op-logo-library__grid">{form.brand.logoVariants.map((variant) => <article key={variant.id}><div className={`op-logo-variant__preview ${variant.usage === "dark" ? "dark" : ""}`}><img src={variant.url} alt={variant.name} /></div><label><span>Name</span><input value={variant.name} onChange={(event) => updateLogoVariant(variant.id, { name: event.target.value })} /></label><label><span>Use for</span><select value={variant.usage} onChange={(event) => updateLogoVariant(variant.id, { usage: event.target.value as BrandLogoVariant["usage"] })}><option value="primary">Primary</option><option value="email">Email</option><option value="light">Light backgrounds</option><option value="dark">Dark backgrounds</option><option value="icon">Icon / small spaces</option><option value="other">Other</option></select></label><button className="remove" onClick={() => removeLogoVariant(variant.id)}><Trash2 size={13} /> Remove</button></article>)}</div> : <button className="op-logo-library__empty" onClick={() => logoInput.current?.click()}><UploadCloud size={22} /><span><strong>Add the first logo</strong><small>Transparent PNG, JPG, WebP, or SVG. A public email-safe copy is created automatically.</small></span></button>}
            </div>
            <div className="op-color-editor">
              <strong>Core palette</strong>
              <small>Primary brand signal, supporting contrast or surface, and optional accent.</small>
              <BrandColorField label="Primary" value={form.brand.primaryColor} onChange={(value) => changeBrand("primaryColor", value)} />
              <BrandColorField label="Secondary" value={form.brand.secondaryColor} onChange={(value) => changeBrand("secondaryColor", value)} />
              <BrandColorField label="Accent" value={form.brand.accentColor} onChange={(value) => changeBrand("accentColor", value)} />
              <strong className="neutral-title">Neutrals</strong>
              <small>Functional background and text references. A deliberate dark surface may also be the secondary color.</small>
              <BrandColorField label="Light" value={form.brand.neutralLightColor} fallback="#ffffff" onChange={(value) => changeBrand("neutralLightColor", value)} />
              <BrandColorField label="Dark" value={form.brand.neutralDarkColor} fallback="#222222" onChange={(value) => changeBrand("neutralDarkColor", value)} />
            </div>
            <div className="op-brand-fields"><Field label="Look and feel" value={form.brand.lookAndFeel} onChange={(value) => changeBrand("lookAndFeel", value)} placeholder="Overall visual mood, composition, rhythm, and design language" multiline /><Field label="Typography" value={form.brand.typography} onChange={(value) => changeBrand("typography", value)} placeholder="Typefaces, weights, hierarchy, and usage" multiline />{form.brand.fontSources?.length > 0 && <small className="op-font-status">{form.brand.fontSources.length} connected font {form.brand.fontSources.length === 1 ? "file" : "files"} · used when rendering PDFs and decks</small>}<Field label="Photography" value={form.brand.photographyStyle} onChange={(value) => changeBrand("photographyStyle", value)} placeholder="Subject, lighting, framing, treatment, and exclusions" multiline /><Field label="Other imagery" value={form.brand.imageryStyle} onChange={(value) => changeBrand("imageryStyle", value)} placeholder="Illustration, graphics, icons, textures, and motion" multiline /><Field wide label="Visual identity notes" value={form.brand.notes} onChange={(value) => changeBrand("notes", value)} placeholder="Logo rules, spacing, motifs, and usage guidance" multiline /></div>
          </div>
          <TypographySamples brand={form.brand} onChange={updateTypographySystems} />
        </section>
        <div className="op-form-grid"><Field wide label="What the brand offers" value={form.description} onChange={(value) => change("description", value)} placeholder="Products, services, capabilities, and customer value" multiline /></div>
        <div className="op-form-actions"><span>Last saved {new Date(workspace.updatedAt).toLocaleString()} · Saved corrections are protected from source updates.</span><button onClick={save}><Save size={15} /> Save corrections</button></div>
      </div>}
    </section>

    {assistantOpen && unknowns.length > 0 && <aside className="op-secretary-panel">
      <header><div><span><Sparkles size={16} /></span><div><strong>Project assistant</strong><small>{Math.min(questionIndex + 1, unknowns.length)} of {unknowns.length} confirmations</small></div></div><button aria-label="Close project assistant" onClick={() => setAssistantOpen(false)}><X size={17} /></button></header>
      <div className="op-secretary-chat">
        {reviewSummary && <div className="assistant"><span><Sparkles size={13} /></span><p>{reviewSummary}</p></div>}
        {unknowns.slice(0, questionIndex).map((question) => <div className="op-chat-exchange" key={question}><div className="assistant"><span><Sparkles size={13} /></span><p>{question}</p></div>{answers[question] && answers[question] !== SKIPPED_ANSWER ? <div className="user"><p>{answers[question]}</p></div> : <div className="skipped">Not known—won’t ask again</div>}</div>)}
        {questionIndex < unknowns.length ? <div className="assistant current"><span><Sparkles size={13} /></span><p>{unknowns[questionIndex]}</p></div> : <div className="assistant current"><span><Check size={13} /></span><p>That is enough for me to update the Brand. Add anything else you want me to know, or apply the answers now.</p></div>}
      </div>
      {questionIndex < unknowns.length ? <div className="op-chat-composer"><textarea autoFocus value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChatAnswer(); } }} placeholder="Answer naturally…" /><div><button className="secondary" onClick={skipChatQuestion}>I don’t know</button><button disabled={!chatDraft.trim()} onClick={sendChatAnswer}>Send <Send size={14} /></button></div></div> : <div className="op-chat-composer final"><textarea value={additionalContext} onChange={(event) => updateAdditionalContext(event.target.value)} placeholder="Anything else? Optional." /><button disabled={refining || !canApplyAnswers} onClick={() => void applyAnswers()}>{refining ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{refining ? "Updating…" : "Apply answers"}</button></div>}
    </aside>}
  </div>;
}

type CampaignCalendarEvent = {
  id: string;
  runId: string;
  date: string;
  channel: string;
  title: string;
  status: string;
  needsAsset: boolean;
  newsletter: boolean;
};

function CampaignCalendar({ runs, jobs, newsletters, onOpen, onOpenNewsletter }: { runs: AgentRun[]; jobs: DeliveryJob[]; newsletters: NewsletterDraft[]; onOpen: (id: string) => void; onOpenNewsletter: () => void }) {
  const events = buildCampaignCalendarEvents(runs, jobs, newsletters);
  const firstUpcoming = events.find((event) => new Date(event.date).getTime() >= Date.now()) || events.at(-1);
  const [month, setMonth] = useState(() => { const date = firstUpcoming ? new Date(firstUpcoming.date) : new Date(); return new Date(date.getFullYear(), date.getMonth(), 1); });
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1);
  const gridStart = new Date(monthStart);
  gridStart.setDate(1 - monthStart.getDay());
  const days = Array.from({ length: 42 }, (_, index) => { const date = new Date(gridStart); date.setDate(gridStart.getDate() + index); return date; });
  const dateKey = (value: Date | string) => { const date = value instanceof Date ? value : new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  const byDate = new Map<string, CampaignCalendarEvent[]>();
  for (const event of events) { const key = dateKey(event.date); byDate.set(key, [...(byDate.get(key) || []), event]); }
  const upcoming = events.filter((event) => new Date(event.date).getTime() >= new Date().setHours(0, 0, 0, 0) && !["complete", "sent", "cancelled"].includes(event.status)).slice(0, 8);
  return <div className="op-campaign-calendar"><section className="op-calendar-board"><header><div><small>CAMPAIGN SCHEDULE</small><h2>{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2><p>Every approved, planned, incomplete, and published item appears here.</p></div><nav><button aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ArrowLeft size={14} /></button><button onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</button><button aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ArrowRight size={14} /></button></nav></header><div className="op-calendar-weekdays">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}</div><div className="op-calendar-grid">{days.map((day) => { const key = dateKey(day); const dayEvents = byDate.get(key) || []; const outside = day.getMonth() !== month.getMonth(); const today = key === dateKey(new Date()); return <article key={key} className={`${outside ? "outside" : ""} ${today ? "today" : ""}`}><time>{day.getDate()}</time><div>{dayEvents.slice(0, 3).map((event) => <button key={event.id} className={`channel-${event.channel} status-${event.status}`} onClick={() => event.newsletter ? onOpenNewsletter() : onOpen(event.runId)} title={`${event.title} · ${campaignCalendarStatus(event)}`}><i />{event.title}</button>)}{dayEvents.length > 3 && <small>+{dayEvents.length - 3} more</small>}</div></article>; })}</div></section><aside className="op-calendar-agenda"><header><CalendarDays size={18} /><div><small>NEXT EVENTS</small><h3>Upcoming work</h3></div></header>{upcoming.length ? upcoming.map((event) => <button key={`agenda-${event.id}`} onClick={() => event.newsletter ? onOpenNewsletter() : onOpen(event.runId)}><time>{new Date(event.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}<small>{new Date(event.date).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</small></time><span><strong>{event.title}</strong><small>{deliveryChannelLabel(event.channel as DeliveryJob["channel"])} · {campaignCalendarStatus(event)}</small></span><ArrowRight size={13} /></button>) : <div className="op-calendar-empty"><Check size={18} /><p>No future item is ready. Planned gaps remain visible in the month grid.</p></div>}</aside></div>;
}

function CalendarWorkspace({ workspace, runs, onOpen, onOpenNewsletter }: { workspace: ProductWorkspace; runs: AgentRun[]; onOpen: (id: string) => void; onOpenNewsletter: () => void }) {
  const [jobs, setJobs] = useState<DeliveryJob[]>([]);
  const [newsletters, setNewsletters] = useState<NewsletterDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = async () => {
    const errors: string[] = [];
    try {
      const response = await apiFetch(`/api/delivery?projectId=${encodeURIComponent(workspace.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Scheduled campaign items could not be read.");
      setJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch (reason) {
      errors.push(reason instanceof Error ? reason.message : "Scheduled campaign items could not be read.");
    }
    try {
      const response = await apiFetch(`/api/newsletters?projectId=${encodeURIComponent(workspace.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Newsletter schedules could not be read.");
      setNewsletters(Array.isArray(data.drafts) ? data.drafts : []);
    } catch (reason) {
      errors.push(reason instanceof Error ? reason.message : "Newsletter schedules could not be read.");
    }
    setError(errors.join(" "));
    setLoading(false);
  };

  useEffect(() => {
    setJobs([]);
    setNewsletters([]);
    setLoading(true);
    void refresh();
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === workspace.id) void refresh();
    };
    window.addEventListener("market-agent-delivery-updated", handleUpdate);
    window.addEventListener("market-agent-newsletter-updated", handleUpdate);
    const poll = window.setInterval(() => void refresh(), 60_000);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener("market-agent-delivery-updated", handleUpdate);
      window.removeEventListener("market-agent-newsletter-updated", handleUpdate);
    };
  }, [workspace.id]);

  const events = buildCampaignCalendarEvents(runs, jobs, newsletters);
  return <div className="op-stack op-calendar-workspace">
    <div className="op-heading"><div className="op-eyebrow">Project schedule</div><h1>Calendar</h1><p>All planned, approved, scheduled, published, and incomplete campaign work for {workspace.name || "this project"} in one place.</p></div>
    {error && <div className="op-analytics-error"><CircleAlert size={17} />{error}<button onClick={() => { setLoading(true); void refresh(); }}>Try again</button></div>}
    {loading && events.length === 0 ? <div className="op-analytics-loading"><LoaderCircle className="spin" size={22} /> Reading the project schedule…</div> : <CampaignCalendar runs={runs} jobs={jobs} newsletters={newsletters} onOpen={onOpen} onOpenNewsletter={onOpenNewsletter} />}
  </div>;
}

function buildCampaignCalendarEvents(runs: AgentRun[], jobs: DeliveryJob[], newsletters: NewsletterDraft[]): CampaignCalendarEvent[] {
  const events: CampaignCalendarEvent[] = [];
  for (const run of runs) {
    const runJobs = jobs.filter((job) => job.runId === run.id).sort((left, right) => String(left.payload.scheduledAt || left.createdAt).localeCompare(String(right.payload.scheduledAt || right.createdAt)));
    const plan = run.campaignPlan?.items?.length ? run.campaignPlan.items.map((item, index) => ({ date: item.scheduledAt, channel: item.channel, title: calendarTitle(item.text || item.subject, index), needsAsset: ["instagram", "tiktok", "youtube"].includes(item.channel) && !item.mediaUrl })) : extractRunCalendarPlan(run);
    const count = Math.max(plan.length, runJobs.length);
    for (let index = 0; index < count; index += 1) {
      const job = runJobs[index];
      const planned = plan[index];
      const rawDate = job?.payload.scheduledAt || job?.completedAt || job?.createdAt || planned?.date;
      if (!rawDate || !Number.isFinite(new Date(rawDate).getTime())) continue;
      events.push({
        id: job?.id || `plan-${run.id}-${index}`,
        runId: run.id,
        date: new Date(rawDate).toISOString(),
        channel: job?.channel || planned?.channel || "instagram",
        title: planned?.title || calendarTitle(job?.payload.text || job?.payload.subject, index),
        status: job?.status || "planned",
        needsAsset: !job && Boolean(planned?.needsAsset),
        newsletter: false,
      });
    }
  }
  for (const draft of newsletters) {
    const date = draft.scheduledFor || draft.sentAt;
    if (!date) continue;
    events.push({ id: `newsletter-${draft.id}`, runId: "", date, channel: "gmail", title: draft.content.subject || "Newsletter", status: draft.status === "sent" ? "sent" : draft.status, needsAsset: false, newsletter: true });
  }
  return events.sort((left, right) => left.date.localeCompare(right.date));
}

function extractRunCalendarPlan(run: AgentRun) {
  const result: Array<{ date: string; channel: DeliveryJob["channel"]; title: string; needsAsset: boolean }> = [];
  const pattern = /^###\s+(?:(\d+)\s*[·.-]\s*)?Day\s+(\d+)\s*(?:[·.—–-]\s*)?([^\n]+)/gim;
  const start = new Date(run.createdAt);
  for (const match of String(run.output || "").matchAll(pattern)) {
    const day = Math.max(1, Number(match[2] || 1));
    const date = new Date(start);
    date.setDate(start.getDate() + day - 1);
    date.setHours(12, 0, 0, 0);
    const title = String(match[3] || `Post ${match[1] || result.length + 1}`).replace(/^(?:Static|Carousel|Reel|Post|Story)\s*:?\s*/i, "").trim();
    result.push({ date: date.toISOString(), channel: "instagram", title, needsAsset: true });
  }
  return result;
}

function calendarTitle(value: unknown, index: number) {
  const clean = String(value || "").replace(/[*_>#`]/g, "").split("\n").map((line) => line.trim()).find(Boolean) || `Campaign item ${index + 1}`;
  return clean.length > 54 ? `${clean.slice(0, 51)}…` : clean;
}

function campaignCalendarStatus(event: CampaignCalendarEvent) {
  if (event.status === "planned" && event.needsAsset) return "Asset needed";
  return ({ awaiting_approval: "Waiting for approval", scheduled: "Approved and scheduled", running: "Publishing", submitted: "Processing", complete: "Published", failed: "Needs attention", dead_letter: "Delivery stopped", cancelled: "Cancelled", sent: "Sent", planned: "Planned" } as Record<string, string>)[event.status] || event.status;
}

function CampaignOverview({ runs, jobs, newsletters, onOpen, onOpenNewsletter, onStart }: { runs: AgentRun[]; jobs: DeliveryJob[]; newsletters: NewsletterDraft[]; onOpen: (id: string) => void; onOpenNewsletter: () => void; onStart: () => void }) {
  const activeRuns = runs.filter((run) => campaignRunIsActive(run, jobs));
  const archivedRuns = runs.filter((run) => !campaignRunIsActive(run, jobs));
  const activeNewsletters = newsletters.filter((draft) => draft.status !== "sent");
  const archivedNewsletters = newsletters.filter((draft) => draft.status === "sent");
  const activeJobs = jobs.filter(deliveryJobIsActive);
  const completedJobs = jobs.filter((job) => !deliveryJobIsActive(job));
  return <div className="op-campaign-overview">
    <section className="op-campaign-summary"><article><small>Active campaigns</small><strong>{activeRuns.length + activeNewsletters.length}</strong><span>planning or publishing</span></article><article><small>Actions in progress</small><strong>{activeJobs.length}</strong><span>approval, scheduled, or publishing</span></article><article><small>Completed work</small><strong>{completedJobs.filter((job) => job.status === "complete").length + archivedNewsletters.length}</strong><span>available in the archive</span></article></section>
    <section className="op-campaign-plans"><div className="op-section-head"><div><span>Active now</span><h2>Active campaigns</h2></div><small>{activeRuns.length + activeNewsletters.length}</small></div>{activeRuns.length || activeNewsletters.length ? <div className="op-run-list">{activeNewsletters.map((draft) => <button className="op-run-row" key={draft.id} onClick={onOpenNewsletter}><span className="op-run-icon op-run-icon--social"><Send size={17} /></span><div><strong>{draft.content.subject}</strong><p>Newsletter campaign</p><small>{new Date(draft.createdAt).toLocaleString()}</small></div><em className={draft.status === "scheduled" ? "approved" : ""}>{newsletterStatus(draft)}</em><ArrowRight size={16} /></button>)}{activeRuns.map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div> : <div className="op-empty op-empty--compact"><span><Rocket size={22} /></span><h2>No active campaign</h2><p>Start a campaign and it will remain here while it is being planned, approved, scheduled, or published.</p><button onClick={onStart}><Sparkles size={15} /> Start campaign</button></div>}</section>
    {(archivedRuns.length > 0 || archivedNewsletters.length > 0) && <section className="op-campaign-plans op-campaign-archive"><div className="op-section-head"><div><span>Previous work</span><h2>Campaign archive</h2></div><small>{archivedRuns.length + archivedNewsletters.length}</small></div><div className="op-run-list">{archivedNewsletters.map((draft) => <button className="op-run-row" key={draft.id} onClick={onOpenNewsletter}><span className="op-run-icon op-run-icon--social"><Send size={17} /></span><div><strong>{draft.content.subject}</strong><p>Newsletter campaign</p><small>{new Date(draft.sentAt || draft.updatedAt).toLocaleString()}</small></div><em className="approved">Sent</em><ArrowRight size={16} /></button>)}{archivedRuns.map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div></section>}
  </div>;
}

function ChannelCampaignWorkspace({ channel, runs, jobs, connected, onOpen, onStart, onConnect }: { channel: Exclude<CampaignWorkspaceSection, "overview" | "calendar" | "newsletter">; runs: AgentRun[]; jobs: DeliveryJob[]; connected: boolean; onOpen: (id: string) => void; onStart: () => void; onConnect: () => void }) {
  const channelJobs = jobs.filter((job) => job.channel === channel);
  const relatedRuns = runs.filter((run) => channelJobs.some((job) => job.runId === run.id) || runMentionsChannel(run, channel));
  const activeRuns = relatedRuns.filter((run) => {
    const runJobs = channelJobs.filter((job) => job.runId === run.id);
    return !runJobs.length || runJobs.some(deliveryJobIsActive);
  });
  const archivedRuns = relatedRuns.filter((run) => !activeRuns.some((active) => active.id === run.id));
  const activeJobs = channelJobs.filter(deliveryJobIsActive);
  const archivedJobs = channelJobs.filter((job) => !deliveryJobIsActive(job));
  const label = deliveryChannelLabel(channel);
  return <div className="op-channel-campaigns">
    <section className="op-channel-campaigns__hero"><span><ServiceLogo provider={channel} name={label} /></span><div><small>{label.toUpperCase()} CAMPAIGNS</small><h2>{label}</h2><p>Campaign planning, approved publications, schedules, and previous work for this channel stay together here.</p></div><button onClick={connected ? onStart : onConnect}>{connected ? `Start ${label} campaign` : `Connect ${label}`} <ArrowRight size={13} /></button></section>
    <section className="op-campaign-summary"><article><small>Active campaigns</small><strong>{activeRuns.length}</strong><span>for {label}</span></article><article><small>Actions in progress</small><strong>{activeJobs.length}</strong><span>approval or publishing</span></article><article><small>Archived actions</small><strong>{archivedJobs.length}</strong><span>complete, cancelled, or failed</span></article></section>
    <section className="op-campaign-plans"><div className="op-section-head"><div><span>Active now</span><h2>Active {label} campaigns</h2></div><small>{activeRuns.length}</small></div>{activeRuns.length ? <div className="op-run-list">{activeRuns.map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div> : <div className="op-empty op-empty--compact"><span><Send size={22} /></span><h2>No active {label} campaign</h2><p>{connected ? `Start a campaign for ${label}; its approved posts and schedule will appear here.` : `Connect ${label} before preparing real publication actions.`}</p><button onClick={connected ? onStart : onConnect}>{connected ? "Open agent" : `Connect ${label}`}</button></div>}</section>
    {activeJobs.length > 0 && <section className="op-channel-job-list"><div className="op-section-title"><div><small>ACTIVE PUBLICATION ITEMS</small><h2>Approval and schedule</h2></div></div><div>{activeJobs.map((job) => <button key={job.id} onClick={() => onOpen(job.runId)}><span><strong>{job.payload.subject || job.payload.text?.slice(0, 90) || `${label} publication`}</strong><small>{job.payload.scheduledAt ? new Date(job.payload.scheduledAt).toLocaleString() : new Date(job.createdAt).toLocaleString()}</small></span><em>{deliveryStatusLabel(job.status)}</em><ArrowRight size={14} /></button>)}</div></section>}
    {(archivedRuns.length > 0 || archivedJobs.length > 0) && <section className="op-campaign-plans op-campaign-archive"><div className="op-section-head"><div><span>Previous work</span><h2>{label} archive</h2></div><small>{archivedRuns.length || archivedJobs.length}</small></div>{archivedRuns.length ? <div className="op-run-list">{archivedRuns.map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div> : <div className="op-empty op-empty--compact"><p>{archivedJobs.length} previous publication item{archivedJobs.length === 1 ? "" : "s"}.</p></div>}</section>}
  </div>;
}

function ProspectConversionPanel({ dashboard, direction, onDirection, working, mailchimpReady, onCreate, onUpdate, onConnect, notify }: { dashboard: NewsletterDashboard; direction: string; onDirection: (value: string) => void; working: string; mailchimpReady: boolean; onCreate: () => Promise<void>; onUpdate: (campaign: ProspectConversionCampaign, changes: Partial<ProspectConversionCampaign>) => Promise<void>; onConnect: () => void; notify: (message: string) => void }) {
  const campaign = dashboard.conversionCampaigns?.[0] || null;
  const prospectCount = dashboard.contactImports.reduce((sum, item) => sum + item.unknownCount, 0);
  const [draft, setDraft] = useState(() => campaign ? { eyebrow: campaign.eyebrow, title: campaign.title, description: campaign.description, ctaLabel: campaign.ctaLabel, privacyNote: campaign.privacyNote, promotionText: campaign.promotionText } : null);
  useEffect(() => setDraft(campaign ? { eyebrow: campaign.eyebrow, title: campaign.title, description: campaign.description, ctaLabel: campaign.ctaLabel, privacyNote: campaign.privacyNote, promotionText: campaign.promotionText } : null), [campaign?.id, campaign?.updatedAt]);
  const changed = Boolean(campaign && draft && ["eyebrow", "title", "description", "ctaLabel", "privacyNote", "promotionText"].some((key) => draft[key as keyof typeof draft] !== campaign[key as keyof ProspectConversionCampaign]));
  const copy = async (value: string, message: string) => {
    try { await navigator.clipboard.writeText(value); notify(message); } catch { notify("Copy failed. Select and copy the text manually."); }
  };

  return <section className="op-optin-campaign">
    <div className="op-section-title"><div><small>PROSPECT CONVERSION</small><h2>Turn relevant prospects into subscribers</h2><p>The staged contacts remain prospects. This public page gives people a voluntary path into the selected Mailchimp audience.</p></div><em>{prospectCount.toLocaleString()} staged prospect{prospectCount === 1 ? "" : "s"}</em></div>
    {!campaign || !draft ? <div className="op-optin-builder"><div><span><UsersRound size={22} /></span><h3>Build the opt-in campaign</h3><p>The agent will write and publish a branded signup page connected to Mailchimp. Nothing will be emailed to the staged list.</p></div><label><span>Optional direction</span><textarea value={direction} onChange={(event) => onDirection(event.target.value)} placeholder="Example: Offer venue teams a useful visitor-experience brief, LUMEN demo updates, and pilot invitations." /></label><button onClick={() => void onCreate()} disabled={working === "create-optin"}>{working === "create-optin" ? <LoaderCircle className="spin" size={15} /> : <WandSparkles size={15} />}{mailchimpReady ? working === "create-optin" ? "Building page…" : "Approve & publish opt-in page" : "Connect Mailchimp first"}</button>{!mailchimpReady && <button className="secondary" onClick={onConnect}>Open connections</button>}</div> : <div className="op-optin-active">
      <div className="op-optin-editor"><header><div><strong>{campaign.status === "active" ? "Public signup page" : "Signup page paused"}</strong><small>{campaign.publicUrl}</small></div><em className={campaign.status}>{campaign.status}</em></header><label><span>Eyebrow</span><input value={draft.eyebrow} onChange={(event) => setDraft((current) => current && { ...current, eyebrow: event.target.value })} /></label><label><span>Headline</span><input value={draft.title} onChange={(event) => setDraft((current) => current && { ...current, title: event.target.value })} /></label><label><span>Description</span><textarea value={draft.description} onChange={(event) => setDraft((current) => current && { ...current, description: event.target.value })} /></label><div className="op-optin-editor__row"><label><span>Button</span><input value={draft.ctaLabel} onChange={(event) => setDraft((current) => current && { ...current, ctaLabel: event.target.value })} /></label><label><span>Confirmation note</span><input value={draft.privacyNote} onChange={(event) => setDraft((current) => current && { ...current, privacyNote: event.target.value })} /></label></div><label><span>Promotion copy</span><textarea value={draft.promotionText} onChange={(event) => setDraft((current) => current && { ...current, promotionText: event.target.value })} /></label><footer><button disabled={!changed || working === `optin-${campaign.id}`} onClick={() => void onUpdate(campaign, draft)}><Save size={14} /> Save public page</button><button className="secondary" onClick={() => void copy(campaign.publicUrl, "Signup link copied.")}><Link2 size={14} /> Copy link</button><button className="secondary" onClick={() => void copy(draft.promotionText, "Promotion copy copied.")}><Megaphone size={14} /> Copy promotion</button><button className="secondary" onClick={() => void onUpdate(campaign, { status: campaign.status === "active" ? "paused" : "active" })}>{campaign.status === "active" ? "Pause page" : "Publish again"}</button></footer></div>
      <div className="op-optin-preview"><iframe title="Public opt-in page preview" src={`${campaign.publicUrl}?preview=1`} /><a href={campaign.publicUrl} target="_blank" rel="noreferrer">Open full page <ArrowRight size={12} /></a></div>
      <div className="op-optin-funnel"><span><small>Prospects</small><strong>{prospectCount.toLocaleString()}</strong></span><i>→</i><span><small>Page views</small><strong>{campaign.views.toLocaleString()}</strong></span><i>→</i><span><small>Signup clicks</small><strong>{campaign.ctaClicks.toLocaleString()}</strong></span><i>→</i><span><small>Confirmed in audience</small><strong>{dashboard.subscriberRegistry.counts.confirmed.toLocaleString()}</strong></span></div>
    </div>}
  </section>;
}

function ContactImportCard({ contactImport, details, working, deliveryReady, onLoad, onImport, onConnect }: { contactImport: ContactImport; details?: { total: number; contacts: Array<{ email: string; firstName: string; lastName: string; company: string; consent: "confirmed" | "unknown" | "denied" }>; loading?: boolean; search?: string }; working: string; deliveryReady: boolean; onLoad: (contactImport: ContactImport, search?: string, append?: boolean) => Promise<void>; onImport: (contactImport: ContactImport, mode: "confirmed") => Promise<void>; onConnect: () => void }) {
  const [search, setSearch] = useState("");
  const expanded = Boolean(details);
  const contacts = details?.contacts || [];
  return <article><header><div><strong>{contactImport.sourceName}</strong><small>{new Date(contactImport.createdAt).toLocaleString()}</small></div><em className={`status-${contactImport.status}`}>{contactImportStatus(contactImport)}</em></header><div className="op-contact-imports__counts"><span><small>Valid</small><strong>{contactImport.validCount}</strong></span><span><small>Confirmed</small><strong>{contactImport.consentedCount}</strong></span><span><small>Permission unknown</small><strong>{contactImport.unknownCount}</strong></span><span><small>Excluded</small><strong>{contactImport.invalidCount + contactImport.duplicateCount + contactImport.deniedCount}</strong></span></div>
    {!expanded && <>{contactImport.preview.length > 0 && <div className="op-contact-imports__preview">{contactImport.preview.map((contact, index) => <span key={`${contact.email}-${index}`}><b>{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email}</b><small>{contact.company || contact.email} · {contact.consent === "confirmed" ? "permission confirmed" : contact.consent === "denied" ? "excluded" : "permission unknown"}</small></span>)}</div>}<button className="op-contact-imports__open" onClick={() => void onLoad(contactImport)}>{details?.loading ? <LoaderCircle className="spin" size={13} /> : <UsersRound size={13} />} View all {contactImport.validCount} contacts</button><small className="op-contact-imports__preview-note">Showing a protected preview of {Math.min(5, contactImport.validCount)} of {contactImport.validCount}.</small></>}
    {details && <section className="op-contact-directory"><header><form onSubmit={(event) => { event.preventDefault(); void onLoad(contactImport, search); }}><Search size={13} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, email, or company" /><button type="submit" disabled={details.loading}>Search</button></form><button onClick={() => onLoad(contactImport, "__close__")} className="close-directory">Close</button></header><div>{contacts.map((contact, index) => <span key={`${contact.email}-${index}`}><b>{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "Unnamed contact"}</b><a href={`mailto:${contact.email}`}>{contact.email}</a><small>{contact.company || "—"}</small><em className={`consent-${contact.consent}`}>{contact.consent === "confirmed" ? "Confirmed" : contact.consent === "denied" ? "Excluded" : "Permission unknown"}</em></span>)}</div>{details.loading && <p><LoaderCircle className="spin" size={14} /> Loading contacts…</p>}{!details.loading && contacts.length < details.total && <button className="load-more" onClick={() => void onLoad(contactImport, details.search || "", true)}>Show {Math.min(100, details.total - contacts.length)} more</button>}<small>{contacts.length} of {details.total} shown</small></section>}
    {contactImport.error && <p className="error"><CircleAlert size={13} />{contactImport.error}</p>}{["staged", "partial", "failed"].includes(contactImport.status) && <footer>{contactImport.consentedCount > 0 && <button onClick={() => void onImport(contactImport, "confirmed")} disabled={Boolean(working)}><UsersRound size={14} />{working === `import-${contactImport.id}-confirmed` ? "Importing…" : `Import ${contactImport.consentedCount} consented`}</button>}{contactImport.unknownCount > 0 && <small>{contactImport.unknownCount} contact{contactImport.unknownCount === 1 ? " has" : "s have"} unknown permission. Use the Prospect conversion campaign above; they will not be emailed or imported.</small>}{!deliveryReady && <button className="secondary" onClick={onConnect}>Connect delivery</button>}</footer>}
  </article>;
}

function SubscriberRegistry({ dashboard, details, working, mailbox, onLoad, onSaveWelcome, onConnect }: { dashboard: NewsletterDashboard; details: { total: number; subscribers: NewsletterSubscriber[]; loading?: boolean; search?: string; status?: string } | null; working: string; mailbox: ConnectionStatus["gmail"]; onLoad: (search?: string, status?: string, append?: boolean) => Promise<void>; onSaveWelcome: (settings: NewsletterDashboard["welcome"]) => Promise<void>; onConnect: () => void }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [welcome, setWelcome] = useState(dashboard.welcome);
  useEffect(() => setWelcome(dashboard.welcome), [dashboard.welcome.enabled, dashboard.welcome.subject, dashboard.welcome.body, dashboard.welcome.enabledAt]);
  const subscribers = details?.subscribers || dashboard.subscriberRegistry.preview;
  const counts = dashboard.subscriberRegistry.counts;
  const changed = welcome.enabled !== dashboard.welcome.enabled || welcome.subject !== dashboard.welcome.subject || welcome.body !== dashboard.welcome.body;
  return <section className="op-subscriber-registry"><div className="op-section-title"><div><small>SUBSCRIBER REGISTRY</small><h2>Subscribers and consent</h2><p>Mailchimp changes are synchronized here. Only confirmed subscribers are eligible for newsletter delivery.</p></div><button className="secondary" onClick={() => void onLoad()} disabled={details?.loading}>{details?.loading ? "Synchronizing…" : details ? "Refresh" : "View all"}</button></div>
    <div className="op-subscriber-registry__counts"><span><small>Pending</small><strong>{counts.pending}</strong></span><span className="confirmed"><small>Confirmed</small><strong>{counts.confirmed}</strong></span><span><small>Unsubscribed</small><strong>{counts.unsubscribed}</strong></span><span className="bounced"><small>Bounced</small><strong>{counts.bounced}</strong></span></div>
    {details && <form className="op-subscriber-registry__filters" onSubmit={(event) => { event.preventDefault(); void onLoad(search, status); }}><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, email, or company" /><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Every status</option><option value="pending">Pending</option><option value="confirmed">Confirmed</option><option value="unsubscribed">Unsubscribed</option><option value="bounced">Bounced</option></select><button type="submit">Search</button><button type="button" className="secondary" onClick={() => { setSearch(""); setStatus(""); void onLoad("", ""); }}>Clear</button></form>}
    <div className="op-subscriber-registry__list">{subscribers.length ? subscribers.map((subscriber) => <span key={subscriber.email}><b>{[subscriber.firstName, subscriber.lastName].filter(Boolean).join(" ") || "Unnamed subscriber"}</b><a href={`mailto:${subscriber.email}`}>{subscriber.email}</a><small>{subscriber.company || (subscriber.welcomeSentAt ? `Welcome sent ${new Date(subscriber.welcomeSentAt).toLocaleDateString()}` : "—")}</small><em className={`status-${subscriber.status}`}>{subscriber.status === "confirmed" ? "Confirmed" : subscriber.status === "bounced" ? "Bounced" : subscriber.status === "unsubscribed" ? "Unsubscribed" : "Pending confirmation"}</em></span>) : <p>No synchronized subscribers yet.</p>}</div>
    {details && !details.loading && details.subscribers.length < details.total && <button className="op-subscriber-registry__more" onClick={() => void onLoad(details.search || "", details.status || "", true)}>Show {Math.min(100, details.total - details.subscribers.length)} more</button>}
    <div className="op-subscriber-automation"><article><small>CONFIRMATION EXPERIENCE</small><h3>Confirmation email and thank-you page</h3><p>Mailchimp sends and hosts these two required steps. Open its form designer to apply this project’s logo, color, and wording to the selected audience.</p><a href="https://admin.mailchimp.com/audience/forms/" target="_blank" rel="noreferrer">Customize in Mailchimp <ArrowRight size={12} /></a></article><article><header><div><small>OPTIONAL AUTOMATION</small><h3>Welcome after confirmation</h3></div><label className="op-toggle"><input type="checkbox" checked={welcome.enabled} disabled={!mailbox.canSend} onChange={(event) => setWelcome((current) => ({ ...current, enabled: event.target.checked }))} /><span /></label></header><p>{mailbox.canSend ? `Sent once from ${mailbox.accountEmail} after a future subscriber confirms.` : "Connect this project’s mailbox to send a personal welcome after confirmation."}</p><label><span>Subject</span><input value={welcome.subject} onChange={(event) => setWelcome((current) => ({ ...current, subject: event.target.value }))} /></label><label><span>Message · use {"{{first_name}}"} if useful</span><textarea value={welcome.body} onChange={(event) => setWelcome((current) => ({ ...current, body: event.target.value }))} /></label><footer>{!mailbox.canSend && <button className="secondary" onClick={onConnect}>Connect mailbox</button>}<button onClick={() => void onSaveWelcome(welcome)} disabled={!changed || working === "welcome"}>{working === "welcome" ? "Saving…" : "Approve & save"}</button></footer></article></div>
  </section>;
}

function IssuesCenter({ workspace, onSave, onOpenBrand, notify }: { workspace: ProductWorkspace; onSave: (workspace: ProductWorkspace) => void; onOpenBrand: () => void; notify: (message: string) => void }) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [noteBuckets, setNoteBuckets] = useState(() => workspace.issueNotes || classifyWorkspaceNotes(workspace.notes || ""));
  const [noteCorrections, setNoteCorrections] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const answers = workspace.questionAnswers || {};
  const openQuestions = (workspace.openQuestions || []).filter((question) => !isQuestionHandled(answers, question));
  const leftQuestions = Object.entries(answers).filter(([question, answer]) => answer === SKIPPED_ANSWER && !question.startsWith("source-warning:"));
  const sourceWarnings = (workspace.sourceWarnings || []).filter((warning) => answers[`source-warning:${warning}`] !== SKIPPED_ANSWER);
  const acceptedNotes = new Set(workspace.acceptedIssueNotes || []);
  const highNotes = splitIssueNotes(noteBuckets.high);
  const attentionNotes = splitIssueNotes(noteBuckets.attention);

  useEffect(() => setNoteBuckets(workspace.issueNotes || classifyWorkspaceNotes(workspace.notes || "")), [workspace.id, workspace.updatedAt]);

  const saveNotes = () => {
    onSave({ ...workspace, issueNotes: noteBuckets, notes: serializeIssueNotes(noteBuckets), protectedFields: (workspace.protectedFields || []).filter((field) => field !== "notes"), updatedAt: new Date().toISOString() });
    notify("Project notes saved in Issues.");
  };
  const acceptNote = (text: string) => {
    onSave({ ...workspace, issueNotes: noteBuckets, notes: serializeIssueNotes(noteBuckets), acceptedIssueNotes: Array.from(new Set([...(workspace.acceptedIssueNotes || []), text])), protectedFields: (workspace.protectedFields || []).filter((field) => field !== "notes"), updatedAt: new Date().toISOString() });
    notify("Left as-is. The assistant will remember it without treating it as unresolved.");
  };
  const reopenNote = (text: string) => {
    onSave({ ...workspace, acceptedIssueNotes: (workspace.acceptedIssueNotes || []).filter((item) => item !== text), updatedAt: new Date().toISOString() });
  };
  const applyNoteCorrection = async (severity: "high" | "attention", index: number, text: string) => {
    const key = `${severity}:${index}:${text}`;
    const correction = noteCorrections[key]?.trim();
    if (!correction) return;
    setBusy(key);
    try {
      const response = await apiFetch("/api/refine", { method: "POST", body: JSON.stringify({ workspace, answers: [], additionalContext: `Resolve this project issue using the user's correction as authoritative. Update every relevant Brand field and do not repeat the superseded issue.\n\nISSUE\n${text}\n\nUSER CORRECTION\n${correction}` }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The correction could not be applied.");
      const remaining = severity === "high" ? highNotes.filter((_, itemIndex) => itemIndex !== index) : attentionNotes.filter((_, itemIndex) => itemIndex !== index);
      const nextBuckets = {
        ...noteBuckets,
        [severity]: remaining.join("\n\n"),
        context: [noteBuckets.context.trim(), `Resolved correction: ${correction}`].filter(Boolean).join("\n\n"),
      };
      const nextQuestions = filterHandledQuestions(Array.isArray(data.unknowns) ? data.unknowns : workspace.openQuestions, answers);
      const updated: ProductWorkspace = {
        ...workspace,
        ...(data.brain || {}),
        issueNotes: nextBuckets,
        notes: serializeIssueNotes(nextBuckets),
        acceptedIssueNotes: (workspace.acceptedIssueNotes || []).filter((item) => item !== text),
        brand: { ...workspace.brand, ...(data.brain?.brand || {}), sourceTypographySystems: workspace.brand.sourceTypographySystems || [] },
        reviewSummary: data.reviewSummary || workspace.reviewSummary,
        openQuestions: nextQuestions,
        protectedFields: (workspace.protectedFields || []).filter((field) => field !== "notes"),
        updatedAt: new Date().toISOString(),
      };
      setNoteBuckets(nextBuckets);
      setNoteCorrections((current) => ({ ...current, [key]: "" }));
      onSave(updated);
      notify("Correction applied to the Brand and the issue was resolved.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The correction could not be applied.");
    } finally {
      setBusy("");
    }
  };
  const leaveQuestion = (question: string) => {
    onSave({ ...workspace, questionAnswers: { ...answers, [question]: SKIPPED_ANSWER }, updatedAt: new Date().toISOString() });
    notify("Left as-is. The assistant will not keep asking this question.");
  };
  const reopenQuestion = (question: string) => {
    const nextAnswers = { ...answers };
    delete nextAnswers[question];
    onSave({ ...workspace, openQuestions: Array.from(new Set([...(workspace.openQuestions || []), question])), questionAnswers: nextAnswers, updatedAt: new Date().toISOString() });
  };
  const leaveWarning = (warning: string) => {
    onSave({ ...workspace, questionAnswers: { ...answers, [`source-warning:${warning}`]: SKIPPED_ANSWER }, updatedAt: new Date().toISOString() });
    notify("Source issue left as-is.");
  };
  const resolveQuestion = async (question: string) => {
    const answer = drafts[question]?.trim();
    if (!answer) return;
    setBusy(question);
    try {
      const response = await apiFetch("/api/refine", { method: "POST", body: JSON.stringify({ workspace, answers: [{ question, answer }], additionalContext: "" }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The answer could not be applied.");
      const nextAnswers = { ...answers, [question]: answer };
      const nextQuestions = filterHandledQuestions(Array.isArray(data.unknowns) ? data.unknowns : workspace.openQuestions, nextAnswers);
      const refreshedIssueNotes = typeof data.brain?.notes === "string" && data.brain.notes !== workspace.notes
        ? mergeAnalyzedIssueNotes(workspace.issueNotes, classifyWorkspaceNotes(data.brain.notes))
        : workspace.issueNotes;
      const updated: ProductWorkspace = {
        ...workspace,
        ...(data.brain || {}),
        issueNotes: refreshedIssueNotes,
        notes: refreshedIssueNotes ? serializeIssueNotes(refreshedIssueNotes) : workspace.notes,
        acceptedIssueNotes: retainExistingIssueDecisions(workspace.acceptedIssueNotes, refreshedIssueNotes),
        brand: { ...workspace.brand, ...(data.brain?.brand || {}), sourceTypographySystems: workspace.brand.sourceTypographySystems || [] },
        reviewSummary: data.reviewSummary || workspace.reviewSummary,
        openQuestions: nextQuestions,
        questionAnswers: nextAnswers,
        protectedFields: (workspace.protectedFields || []).filter((field) => field !== "notes"),
        updatedAt: new Date().toISOString(),
      };
      onSave(updated);
      setDrafts((current) => ({ ...current, [question]: "" }));
      notify("Answer applied and the issue was resolved.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The answer could not be applied.");
    } finally {
      setBusy("");
    }
  };

  const noteIssueCount = [...highNotes, ...attentionNotes].filter((text) => !isAcceptedIssue(acceptedNotes, text)).length;
  const unresolved = openQuestions.length + sourceWarnings.length + noteIssueCount;
  const notesChanged = JSON.stringify(noteBuckets) !== JSON.stringify(workspace.issueNotes || classifyWorkspaceNotes(workspace.notes || ""));
  return <div className="op-stack op-issues">
    <div className="op-heading"><div className="op-eyebrow">Review only what needs attention</div><h1>Issues</h1><p>Questions, source problems, and working notes live here—not inside the Brand. Resolve an item when useful, or leave it as-is so the assistant does not repeat it.</p></div>
    <section className={`op-issues-summary ${unresolved ? "attention" : "clear"}`}><span>{unresolved ? <CircleAlert size={20} /> : <Check size={20} />}</span><div><strong>{unresolved ? `${unresolved} ${unresolved === 1 ? "issue needs" : "issues need"} a decision` : "No unresolved issues"}</strong><p>{unresolved ? "Nothing here blocks the agent unless the missing fact is essential to a specific task." : "The Brand can be used without further confirmation."}</p></div></section>
    {openQuestions.length > 0 && <section className="op-issues-section"><div className="op-section-title"><div><small>QUESTIONS FROM THE ASSISTANT</small><h2>Resolve or leave as-is</h2></div><em>{openQuestions.length}</em></div><div className="op-issue-list">{openQuestions.map((question) => <article key={question}><header><span><CircleAlert size={16} /></span><strong>{question}</strong></header><textarea value={drafts[question] || ""} onChange={(event) => setDrafts((current) => ({ ...current, [question]: event.target.value }))} placeholder="Answer naturally…" /><footer><button className="secondary" onClick={() => leaveQuestion(question)}>Leave as-is</button><button onClick={() => void resolveQuestion(question)} disabled={!drafts[question]?.trim() || busy === question}>{busy === question ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{busy === question ? "Applying…" : "Apply answer"}</button></footer></article>)}</div></section>}
    {sourceWarnings.length > 0 && <section className="op-issues-section"><div className="op-section-title"><div><small>SOURCE ACCESS OR QUALITY</small><h2>Source issues</h2></div><em>{sourceWarnings.length}</em></div><div className="op-source-issue-list">{sourceWarnings.map((warning) => <article key={warning}><span><Globe2 size={17} /></span><p>{warning}</p><div><button className="secondary" onClick={() => leaveWarning(warning)}>Leave as-is</button><button onClick={onOpenBrand}>Review sources</button></div></article>)}</div></section>}
    {leftQuestions.length > 0 && <section className="op-issues-section op-issues-left"><div className="op-section-title"><div><small>LEFT AS-IS</small><h2>Questions the assistant will not repeat</h2></div><em>{leftQuestions.length}</em></div><div>{leftQuestions.map(([question]) => <article key={question}><span>{question}</span><button onClick={() => reopenQuestion(question)}>Reopen</button></article>)}</div></section>}
    <section className="op-issues-notes"><header><div><small>AGENT-RESOLVABLE NOTES</small><h2>Correct the issue, then let the assistant apply it</h2><p>Red and yellow items are not resolved merely by editing text. Give the correction and apply it; the assistant updates the Brand and moves the resolved information into green context.</p></div><button onClick={saveNotes} disabled={!notesChanged}><Save size={14} /> Save context</button></header><div className="op-agent-note-groups"><AgentIssueNotes severity="high" title="High relevance" description="Must constrain the work" notes={highNotes} accepted={acceptedNotes} corrections={noteCorrections} busy={busy} onCorrection={(key, value) => setNoteCorrections((current) => ({ ...current, [key]: value }))} onApply={applyNoteCorrection} onAccept={acceptNote} onReopen={reopenNote} /><AgentIssueNotes severity="attention" title="Needs attention" description="Worth reviewing" notes={attentionNotes} accepted={acceptedNotes} corrections={noteCorrections} busy={busy} onCorrection={(key, value) => setNoteCorrections((current) => ({ ...current, [key]: value }))} onApply={applyNoteCorrection} onAccept={acceptNote} onReopen={reopenNote} /><label className="op-agent-context"><span><Check size={15} /><strong>Context — no issue</strong><em>Useful background and resolved corrections</em></span><small>Green information is remembered by the assistant without being counted as an unresolved issue.</small><textarea value={noteBuckets.context} onChange={(event) => setNoteBuckets((current) => ({ ...current, context: event.target.value }))} placeholder="No resolved or neutral context yet." /></label></div></section>
  </div>;
}

function AgentIssueNotes({ severity, title, description, notes, accepted, corrections, busy, onCorrection, onApply, onAccept, onReopen }: { severity: "high" | "attention"; title: string; description: string; notes: string[]; accepted: Set<string>; corrections: Record<string, string>; busy: string; onCorrection: (key: string, value: string) => void; onApply: (severity: "high" | "attention", index: number, text: string) => void; onAccept: (text: string) => void; onReopen: (text: string) => void }) {
  return <section className={`op-agent-issue-group ${severity}`}><header><span>{severity === "high" ? <CircleAlert size={16} /> : <CircleAlert size={16} />}</span><div><strong>{title}</strong><small>{description}</small></div><em>{notes.filter((note) => !isAcceptedIssue(accepted, note)).length} open</em></header>{notes.length ? <div>{notes.map((note, index) => { const key = `${severity}:${index}:${note}`; const isAccepted = isAcceptedIssue(accepted, note); return <article className={isAccepted ? "accepted" : ""} key={key}><p>{note}</p>{isAccepted ? <footer><span><Check size={13} /> Left as-is · remembered</span><button onClick={() => onReopen(note)}>Reopen</button></footer> : <><textarea value={corrections[key] || ""} onChange={(event) => onCorrection(key, event.target.value)} placeholder="What is the correct information or instruction?" /><footer><button className="secondary" onClick={() => onAccept(note)}>Leave as-is</button><button onClick={() => onApply(severity, index, note)} disabled={!corrections[key]?.trim() || busy === key}>{busy === key ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}{busy === key ? "Applying…" : "Apply and resolve"}</button></footer></>}</article>; })}</div> : <p className="empty">No open notes in this level.</p>}</section>;
}

function MaterialIcon({ kind }: { kind: PreparedMaterial["kind"] }) {
  if (kind === "image") return <ImageIcon size={16} />;
  if (kind === "video") return <Video size={16} />;
  return <FileText size={16} />;
}

function moveVideoToCoverFrame(video: HTMLVideoElement) {
  try {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const offset = duration ? Math.min(0.5, Math.max(0.08, duration * 0.05)) : 0;
    if (offset > 0 && Math.abs(video.currentTime - offset) > 0.01) video.currentTime = offset;
  } catch {
    // Some remote hosts do not permit seeking; the decoded opening frame remains the fallback.
  }
}

function VideoCover({ src, label }: { src: string; label: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(false), [src]);
  return <span className={`op-video-cover ${ready ? "ready" : ""}`}>
    <video
      key={src}
      src={src}
      muted
      playsInline
      preload="auto"
      aria-label={`${label} video cover`}
      onLoadedMetadata={(event) => moveVideoToCoverFrame(event.currentTarget)}
      onLoadedData={(event) => { moveVideoToCoverFrame(event.currentTarget); setReady(true); }}
      onSeeked={() => setReady(true)}
    />
    {!ready && <span className="op-video-cover__loading"><LoaderCircle className="spin" size={17} /> Loading cover…</span>}
    <i aria-hidden="true"><Video size={13} /></i>
  </span>;
}

function SourceMediaStrip({ media, title = "Useful media extracted", subtitle = "Saved with this project for future content and campaign work.", limit = 12, onOpenLibrary, onDelete, onReplace, managing = false }: { media: SourceMediaAsset[]; title?: string; subtitle?: string; limit?: number; onOpenLibrary?: () => void; onDelete?: (item: SourceMediaAsset) => void; onReplace?: (item: SourceMediaAsset) => void; managing?: boolean }) {
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const visible = media.slice(0, limit);
  const shown = visible.length;
  return <div className={`op-source-media ${managing ? "op-source-media--managing" : ""}`}>
    <header><div><strong>{title}</strong><span>{subtitle}</span></div><aside><em>Showing {shown} of {media.length}</em>{onOpenLibrary && <button onClick={onOpenLibrary}>View all in Content Library <ArrowRight size={13} /></button>}</aside></header>
    <div className="op-source-media__grid">{visible.map((item, index) => <article key={item.id}>
      <button className="op-source-media__preview" onClick={() => setPreviewIndex(index)} aria-label={`Preview ${item.name}`}>
        {item.kind === "image" ? <img src={item.url} alt={item.name} /> : <VideoCover src={item.url} label={item.name} />}
        <span className="op-source-media__expand">Preview</span>
      </button>
      <div className="op-source-media__meta"><strong>{item.name}</strong><small>{item.role} · {item.recommendation}</small><span>{item.tags.slice(0, 3).join(" · ")}</span></div>
      {managing && <div className="op-source-media__manage"><button onClick={() => onReplace?.(item)}><UploadCloud size={12} /> Replace</button><button className="danger" onClick={() => onDelete?.(item)}><Trash2 size={12} /> Delete</button></div>}
    </article>)}</div>
    {previewIndex != null && visible[previewIndex] && <MediaPreviewOverlay items={visible} index={previewIndex} onIndex={setPreviewIndex} onClose={() => setPreviewIndex(null)} onDelete={onDelete ? (item) => { onDelete(item); setPreviewIndex(null); } : undefined} onReplace={onReplace} />}
  </div>;
}

function MediaPreviewOverlay({ items, index, onIndex, onClose, onDelete, onReplace }: { items: SourceMediaAsset[]; index: number; onIndex: (index: number) => void; onClose: () => void; onDelete?: (item: SourceMediaAsset) => void; onReplace?: (item: SourceMediaAsset) => void }) {
  const item = items[index];
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft" && items.length > 1) onIndex((index - 1 + items.length) % items.length);
      if (event.key === "ArrowRight" && items.length > 1) onIndex((index + 1) % items.length);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, items.length, onClose, onIndex]);
  if (!item) return null;
  const previous = () => onIndex((index - 1 + items.length) % items.length);
  const next = () => onIndex((index + 1) % items.length);
  return <div className="op-media-preview" role="dialog" aria-modal="true" aria-label={`Preview ${item.name}`}>
    <button className="op-media-preview__scrim" onClick={onClose} aria-label="Close preview" />
    <section>
      <header><div><strong>{item.name}</strong><span>{index + 1} of {items.length} · {item.role}</span></div><button onClick={onClose} aria-label="Close preview"><X size={19} /></button></header>
      <div className="op-media-preview__stage">
        {items.length > 1 && <button className="previous" onClick={previous} aria-label="Previous asset"><ArrowLeft size={20} /></button>}
        {item.kind === "video" ? <video key={item.url} src={item.url} controls autoPlay playsInline preload="metadata" /> : <img src={item.url} alt={item.name} />}
        {items.length > 1 && <button className="next" onClick={next} aria-label="Next asset"><ArrowRight size={20} /></button>}
      </div>
      <footer><div><span>{item.recommendation}</span>{item.tags.slice(0, 5).map((tag) => <em key={tag}>{tag}</em>)}</div>{(onReplace || onDelete) && <aside>{onReplace && <button onClick={() => onReplace(item)}><UploadCloud size={13} /> Replace</button>}{onDelete && <button className="danger" onClick={() => onDelete(item)}><Trash2 size={13} /> Delete</button>}</aside>}</footer>
    </section>
  </div>;
}

function connectedSourceLabel(value: string) {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./, "");
    if (hostname.includes("docs.google.com") && new URL(value).pathname.includes("/presentation/")) return "Google Slides";
    if (hostname.includes("docs.google.com")) return "Google Docs";
    if (hostname.includes("figma.com")) return "Figma";
    return hostname;
  } catch {
    return "Source link";
  }
}

function connectedSourceKind(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, "");
    if (hostname.includes("figma.com")) return "figma";
    if (hostname.includes("docs.google.com") && url.pathname.includes("/presentation/")) return "google-slides";
    if (hostname.includes("docs.google.com")) return "google-docs";
    if (/\.pdf(?:$|[?#])/i.test(value)) return "pdf";
    return "website";
  } catch {
    return "website";
  }
}

function sameSourceUrl(left: string, right: string) {
  try { return new URL(left).toString() === new URL(right).toString(); }
  catch { return left === right; }
}

function sourceLabelForUrl(url: string, sources: ProductSource[]) {
  return sources.find((source) => sameSourceUrl(source.url, url))?.label || connectedSourceLabel(url);
}

function sourceNeedsTitleRefresh(source: ProductSource) {
  const kind = connectedSourceKind(source.url);
  return ["figma", "google-slides"].includes(kind) && source.label.trim().toLowerCase() === connectedSourceLabel(source.url).toLowerCase();
}

function mergeConnectedSourceMetadata(sources: ProductSource[], metadata: Array<{ url?: string; label?: string }>) {
  return sources.map((source) => {
    const match = metadata.find((item) => item.url && sameSourceUrl(String(item.url), source.url));
    const label = String(match?.label || "").trim();
    return label && !/^https?:\/\//i.test(label) ? { ...source, label: label.slice(0, 180) } : source;
  });
}

const SKIPPED_ANSWER = "__MARKET_AGENT_SKIPPED__";
const QUESTION_STOP_WORDS = new Set([
  "about", "again", "also", "and", "are", "can", "confirm", "could", "does", "for", "from", "have", "how", "into", "is", "its", "now", "please", "should", "that", "the", "their", "them", "there", "these", "this", "today", "what", "when", "where", "which", "who", "why", "with", "would", "you", "your",
]);

function questionTokens(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !QUESTION_STOP_WORDS.has(token))
    .map((token) => token.length > 5 ? token.replace(/(ing|ed|es|s)$/, "") : token);
}

const QUESTION_TOPIC_PATTERNS: Record<string, RegExp> = {
  pricing: /\b(price|prices|pricing|rate|rates|cost|costs|fee|fees|budget|minimum engagement|estimate|estimates)\b/i,
  availability: /\b(available|availability|live|planned|prototype|roadmap|launch|released|commercially)\b/i,
  capabilities: /\b(output|outputs|produce|produces|capability|capabilities|feature|features|deliverable|deliverables)\b/i,
  deployment: /\b(deploy|deployment|hosting|hosted|on premise|on-premise|cloud|installation)\b/i,
  privacy: /\b(consent|retention|deletion|delete|privacy|personal data|guest photo|guest photos|data handling)\b/i,
  proof: /\b(customer|customers|client|clients|pilot|pilots|result|results|case stud|testimonial|metric|metrics)\b/i,
  identity: /\b(brand|branding|logo|logos|colour|colours|color|colors|palette|typeface|typefaces|font|fonts|visual identity|imagery)\b/i,
  audience: /\b(audience|audiences|buyer|buyers|customer segment|customer segments|target market|target markets)\b/i,
  geography: /\b(geography|region|regions|country|countries|market|markets|location|locations|territory|territories)\b/i,
  purchase: /\b(buy|purchase|commission|engage|engagement|contact|booking|book|sales process|procurement)\b/i,
};

function questionTopics(value: string) {
  return Object.entries(QUESTION_TOPIC_PATTERNS)
    .filter(([, pattern]) => pattern.test(String(value || "")))
    .map(([topic]) => topic);
}

function questionsMatch(left: string, right: string) {
  const leftNormalized = String(left || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const rightNormalized = String(right || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized || leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return true;
  const leftTopics = questionTopics(left);
  const rightTopics = questionTopics(right);
  if (leftTopics.some((topic) => rightTopics.includes(topic))) return true;
  const leftTokens = new Set(questionTokens(left));
  const rightTokens = new Set(questionTokens(right));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  return shared >= 3 && smaller > 0 && shared / smaller >= 0.65;
}

function isQuestionHandled(answers: Record<string, string>, question: string) {
  return Object.entries(answers).some(([askedQuestion, answer]) => !askedQuestion.startsWith("source-warning:") && Boolean(answer) && questionsMatch(askedQuestion, question));
}

function unresolvedIssueCount(workspace: ProductWorkspace) {
  const answers = workspace.questionAnswers || {};
  const questions = (workspace.openQuestions || []).filter((question) => !isQuestionHandled(answers, question)).length;
  const warnings = (workspace.sourceWarnings || []).filter((warning) => answers[`source-warning:${warning}`] !== SKIPPED_ANSWER).length;
  const notes = workspace.issueNotes || classifyWorkspaceNotes(workspace.notes || "");
  const accepted = new Set(workspace.acceptedIssueNotes || []);
  return questions + warnings + [...splitIssueNotes(notes.high), ...splitIssueNotes(notes.attention)].filter((note) => !isAcceptedIssue(accepted, note)).length;
}

function splitIssueNotes(value: string) {
  return String(value || "").split(/\n\s*\n/).map((section) => section.trim()).filter(Boolean);
}

function classifyWorkspaceNotes(notes: string): ProductWorkspace["issueNotes"] {
  const result: ProductWorkspace["issueNotes"] = { high: "", attention: "", context: "" };
  for (const section of String(notes || "").split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean)) {
    const normalized = section.toLowerCase();
    const bucket: keyof ProductWorkspace["issueNotes"] = /\[high relevance\]|must not|do not use|unsupported|unverified|not independent evidence|legal|privacy|consent|compliance|prohibited|false|incorrect|material risk|claim/.test(normalized)
      ? "high"
      : /\[context|no issue|confirmed|verified|approved/.test(normalized) ? "context" : "attention";
    const clean = section.replace(/^\[(?:high relevance|needs attention|context[^\]]*)\]\s*/i, "");
    result[bucket] = [result[bucket], clean].filter(Boolean).join("\n\n");
  }
  return result;
}

function mergeAnalyzedIssueNotes(existing: ProductWorkspace["issueNotes"] | undefined, analyzed: ProductWorkspace["issueNotes"]): ProductWorkspace["issueNotes"] {
  const context = Array.from(new Set([...splitIssueNotes(existing?.context || ""), ...splitIssueNotes(analyzed.context)])).join("\n\n");
  return { high: analyzed.high, attention: analyzed.attention, context };
}

function appendProactiveIssueFindings(workspace: ProductWorkspace, findings: IssueFindings): ProductWorkspace {
  const existing = workspace.issueNotes || classifyWorkspaceNotes(workspace.notes || "");
  const accepted = workspace.acceptedIssueNotes || [];
  const append = (current: string, incoming: string[] | undefined) => {
    const items = splitIssueNotes(current);
    for (const raw of incoming || []) {
      const item = String(raw || "").trim();
      if (!item || items.some((existingItem) => issueTextsMatch(existingItem, item)) || accepted.some((acceptedItem) => issueTextsMatch(acceptedItem, item))) continue;
      items.push(item);
    }
    return items.join("\n\n");
  };
  const issueNotes = {
    high: append(existing.high, findings.high),
    attention: append(existing.attention, findings.attention),
    context: existing.context,
  };
  return {
    ...workspace,
    issueNotes,
    notes: serializeIssueNotes(issueNotes),
    protectedFields: (workspace.protectedFields || []).filter((field) => field !== "notes"),
    updatedAt: new Date().toISOString(),
  };
}

function issueTextsMatch(left: string, right: string) {
  const normalize = (value: string) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const leftNormalized = normalize(left);
  const rightNormalized = normalize(right);
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized || leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return true;
  const leftTokens = new Set(questionTokens(left));
  const rightTokens = new Set(questionTokens(right));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  return shared >= 4 && smaller > 0 && shared / smaller >= 0.7;
}

function isAcceptedIssue(accepted: Set<string>, issue: string) {
  return [...accepted].some((acceptedIssue) => issueTextsMatch(acceptedIssue, issue));
}

function retainExistingIssueDecisions(accepted: string[] | undefined, notes: ProductWorkspace["issueNotes"] | undefined) {
  const current = [...splitIssueNotes(notes?.high || ""), ...splitIssueNotes(notes?.attention || "")];
  return (accepted || []).filter((item) => current.some((currentItem) => issueTextsMatch(item, currentItem)));
}

function serializeIssueNotes(notes: ProductWorkspace["issueNotes"]) {
  return [
    notes.high.trim() ? `[HIGH RELEVANCE]\n${notes.high.trim()}` : "",
    notes.attention.trim() ? `[NEEDS ATTENTION]\n${notes.attention.trim()}` : "",
    notes.context.trim() ? `[CONTEXT — NO ISSUE]\n${notes.context.trim()}` : "",
  ].filter(Boolean).join("\n\n");
}

function filterHandledQuestions(questions: unknown[], answers: Record<string, string>) {
  const unique: string[] = [];
  for (const value of questions) {
    const question = String(value || "").trim();
    if (!question || isQuestionHandled(answers, question) || unique.some((existing) => questionsMatch(existing, question))) continue;
    unique.push(question);
  }
  return unique;
}

function filterSourceBackedBrandQuestions(questions: string[], workspace: ProductWorkspace) {
  const hasVisualSource = workspace.sources.length > 0 || workspace.materials.length > 0 || Boolean(workspace.brand.logoDataUrl);
  if (!hasVisualSource) return questions;
  return questions.filter((value) => {
    const question = String(value || "").toLowerCase();
    return !(/\b(primary|secondary|accent|brand|approved)\b.*\b(colou?r|hex|palette)\b/.test(question)
      || /\b(colou?r|hex|palette)\b.*\b(primary|secondary|accent|brand|approved)\b/.test(question)
      || /\b(logos?|typefaces?|typography|fonts?|visual[\s-]+identity|imagery[\s-]+styles?|photography[\s-]+styles?|brand[\s-]+guidelines?)\b/.test(question));
  });
}

const PROTECTABLE_BRAIN_FIELDS = [
  "name", "website", "description", "segmentation", "positioning", "manifesto", "audience", "valueProposition", "voice", "guardrails",
  "brand.logoVariants", "brand.primaryColor", "brand.secondaryColor", "brand.accentColor", "brand.neutralLightColor", "brand.neutralDarkColor", "brand.typography", "brand.fontFamilies", "brand.fontSources", "brand.typographySystems", "brand.lookAndFeel", "brand.photographyStyle", "brand.imageryStyle", "brand.notes",
] as const;

function changedBrainFields(before: ProductWorkspace, after: ProductWorkspace) {
  return PROTECTABLE_BRAIN_FIELDS.filter((path) => brainFieldValue(before, path) !== brainFieldValue(after, path));
}

function brainFieldValue(workspace: ProductWorkspace, path: typeof PROTECTABLE_BRAIN_FIELDS[number]) {
  const value = path.startsWith("brand.") ? workspace.brand?.[path.slice(6) as keyof ProductWorkspace["brand"]] : workspace[path as keyof ProductWorkspace];
  return value && typeof value === "object" ? JSON.stringify(value) : String(value || "").trim();
}

function firstUnhandledQuestionIndex(questions: string[], answers: Record<string, string>) {
  const firstUnanswered = questions.findIndex((question) => !isQuestionHandled(answers, question));
  return firstUnanswered === -1 ? questions.length : firstUnanswered;
}

function colorInputValue(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function BrandColorField({ label, value, onChange, fallback = "#7856ff" }: { label: string; value: string; onChange: (value: string) => void; fallback?: string }) {
  const valid = /^#[0-9a-f]{6}$/i.test(value);
  return <label><span>{label}</span><div>{valid ? <input type="color" value={colorInputValue(value, fallback)} onChange={(event) => onChange(event.target.value)} /> : <span className="op-empty-color">—</span>}<input value={value} onChange={(event) => onChange(event.target.value)} placeholder="Not detected" /></div></label>;
}

function TypographySamples({ brand, onChange }: { brand: ProductWorkspace["brand"]; onChange: (systems: ProductWorkspace["brand"]["typographySystems"]) => void }) {
  const systems = useMemo(() => brand.typographySystems?.length
    ? consolidateTypographySystems(brand.typographySystems)
    : brand.fontFamilies?.length
      ? [{ source: "manual" as const, sourceLabel: "Saved Brand", usage: brand.typography || "Saved typography", families: brand.fontFamilies, sample: "Aa Bb Cc — The quick brown fox jumps over the lazy dog", verified: false }]
      : [], [brand.fontFamilies, brand.typography, brand.typographySystems]);
  const sourceSystems = useMemo(() => consolidateTypographySystems(brand.sourceTypographySystems?.length ? brand.sourceTypographySystems : systems.filter((system) => system.verified)), [brand.sourceTypographySystems, systems]);
  const previewSources = useMemo(() => {
    const seen = new Set<string>();
    return (brand.fontSources || []).filter((source) => {
      const key = source.family.toLowerCase();
      if (seen.has(key) || !/^https:\/\//i.test(source.url)) return false;
      seen.add(key);
      return true;
    }).slice(0, 12).map((source, index) => ({ ...source, alias: `market-agent-font-preview-${index}` }));
  }, [brand.fontSources]);
  const [loadedAliases, setLoadedAliases] = useState<Record<string, boolean>>({});
  const [webFontStatus, setWebFontStatus] = useState<Record<string, "loading" | "loaded" | "unavailable">>({});
  const [editingFont, setEditingFont] = useState<{ systemIndex: number; familyIndex: number } | null>(null);
  const [fontDraft, setFontDraft] = useState("");

  useEffect(() => {
    if (typeof FontFace === "undefined") return;
    let cancelled = false;
    const faces: FontFace[] = [];
    setLoadedAliases({});
    for (const source of previewSources) {
      const safeUrl = source.url.replace(/["\n\r]/g, "");
      const face = new FontFace(source.alias, `url("${safeUrl}")`, { weight: source.weight || "400", style: source.style || "normal" });
      faces.push(face);
      void face.load().then((loaded) => {
        if (cancelled) return;
        document.fonts.add(loaded);
        setLoadedAliases((current) => ({ ...current, [source.alias]: true }));
      }).catch(() => undefined);
    }
    return () => {
      cancelled = true;
      for (const face of faces) document.fonts.delete(face);
    };
  }, [previewSources]);

  const publicPreviewFamilies = useMemo(() => {
    const connected = new Set(previewSources.map((source) => source.family.toLowerCase()));
    return Array.from(new Set(systems
      .filter((system) => system.verified)
      .flatMap((system) => system.families)
      .map((family) => family.trim())
      .filter((family) => family && !connected.has(family.toLowerCase()))));
  }, [previewSources, systems]);

  useEffect(() => {
    let cancelled = false;
    const links: HTMLLinkElement[] = [];
    setWebFontStatus(Object.fromEntries(publicPreviewFamilies.map((family) => [family.toLowerCase(), "loading"])));
    for (const family of publicPreviewFamilies) {
      const key = family.toLowerCase();
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `https://fonts.googleapis.com/css2?family=${family.split(/\s+/).map(encodeURIComponent).join("+")}:wght@400;700&display=swap`;
      link.dataset.marketAgentFontPreview = family;
      link.onload = () => {
        void document.fonts.load(`400 24px "${family.replace(/["\n\r]/g, "")}"`).then((faces) => {
          if (!cancelled) setWebFontStatus((current) => ({ ...current, [key]: faces.length ? "loaded" : "unavailable" }));
        }).catch(() => { if (!cancelled) setWebFontStatus((current) => ({ ...current, [key]: "unavailable" })); });
      };
      link.onerror = () => { if (!cancelled) setWebFontStatus((current) => ({ ...current, [key]: "unavailable" })); };
      document.head.appendChild(link);
      links.push(link);
    }
    return () => {
      cancelled = true;
      for (const link of links) link.remove();
    };
  }, [publicPreviewFamilies]);

  if (!systems.length) return null;
  const sourceForFamily = (family: string) => previewSources.find((source) => source.family.toLowerCase() === family.toLowerCase());
  const systemKey = (system: ProductWorkspace["brand"]["typographySystems"][number]) => system.source === "website" ? "website" : `${system.source}:${system.sourceLabel.toLowerCase().replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^a-z0-9]+/g, " ").trim()}`;
  const originalFor = (system: ProductWorkspace["brand"]["typographySystems"][number]) => sourceSystems.find((candidate) => systemKey(candidate) === systemKey(system));
  const beginFontReplace = (systemIndex: number, familyIndex: number) => {
    setEditingFont({ systemIndex, familyIndex });
    setFontDraft(systems[systemIndex].families[familyIndex]);
  };
  const applyFontReplacement = () => {
    if (!editingFont || !fontDraft.trim()) return;
    onChange(systems.map((system, systemIndex) => systemIndex === editingFont.systemIndex ? { ...system, families: system.families.map((family, familyIndex) => familyIndex === editingFont.familyIndex ? fontDraft.trim() : family), verified: true } : system));
    setEditingFont(null);
    setFontDraft("");
  };
  const removeFont = (systemIndex: number, familyIndex: number) => {
    const system = systems[systemIndex];
    onChange(system.families.length === 1 ? systems.filter((_, index) => index !== systemIndex) : systems.map((candidate, index) => index === systemIndex ? { ...candidate, families: candidate.families.filter((_, fontIndex) => fontIndex !== familyIndex) } : candidate));
    setEditingFont(null);
  };
  const restoreSystem = (systemIndex: number) => {
    const original = originalFor(systems[systemIndex]);
    if (!original) return;
    onChange(systems.map((system, index) => index === systemIndex ? { ...original, families: [...original.families] } : system));
    setEditingFont(null);
  };
  return <div className="op-typography-systems"><header><div><strong>Typography systems</strong><span>Each font can be replaced or removed independently. Restore source returns the complete system to the last typefaces verified from that source; corrections become permanent only when you save the Brand.</span></div></header><div>{systems.map((system, systemIndex) => { const original = originalFor(system); const changed = Boolean(original && JSON.stringify(original) !== JSON.stringify(system)); return <article className={!typographySystemVerified(system, previewSources) ? "unverified" : ""} key={`${system.source}-${system.sourceLabel}-${systemIndex}`}><div className="op-type-system-head"><span>{system.source}</span><strong>{system.sourceLabel}</strong><em>{typographySystemVerified(system, previewSources) ? "Verified" : "Needs verification"}</em><div>{original && <button type="button" disabled={!changed} onClick={() => restoreSystem(systemIndex)}>Restore source</button>}</div></div><p>{system.usage || "Usage not identified"}</p>{!typographySystemVerified(system, previewSources) && <div className="op-type-warning"><CircleAlert size={14} /><span>{system.source === "deck" ? "No deck typeface was verified from actual slide content. The inferred names are hidden; refresh the source or replace a font manually." : "No typeface was verified from this source. Refresh the source or replace a font manually."}</span></div>}{typographySystemVerified(system, previewSources) && system.families.map((family, familyIndex) => { const source = sourceForFamily(family); const connected = Boolean(source && loadedAliases[source.alias]); const publicStatus = webFontStatus[family.toLowerCase()]; const exact = connected || publicStatus === "loaded"; const status = connected ? "Connected font sample" : publicStatus === "loaded" ? "Exact web font sample" : publicStatus === "loading" ? "Loading exact sample…" : "Font file not available"; const fontFamily = connected ? `"${source!.alias}", sans-serif` : `"${family.replace(/["\n\r]/g, "")}", sans-serif`; const editing = editingFont?.systemIndex === systemIndex && editingFont.familyIndex === familyIndex; return <div className={`op-type-sample ${editing ? "editing" : ""}`} key={`${family}-${familyIndex}`}><div>{editing ? <input autoFocus value={fontDraft} onChange={(event) => setFontDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyFontReplacement(); if (event.key === "Escape") setEditingFont(null); }} /> : <strong>{family}</strong>}<span className="op-type-sample__actions">{editing ? <><button type="button" onClick={() => setEditingFont(null)}>Cancel</button><button type="button" className="primary" onClick={applyFontReplacement} disabled={!fontDraft.trim()}>Use font</button></> : <><em>{status}</em><button type="button" onClick={() => beginFontReplace(systemIndex, familyIndex)}>Replace</button><button type="button" className="delete" onClick={() => removeFont(systemIndex, familyIndex)}>Delete</button></>}</span></div>{exact && !editing && <span style={{ fontFamily }}>{system.sample || "Aa Bb Cc — The quick brown fox jumps over the lazy dog"}</span>}</div>; })}</article>; })}</div></div>;
}

function typographySystemVerified(system: ProductWorkspace["brand"]["typographySystems"][number], previewSources: Array<{ family: string }>) {
  if (system.verified) return true;
  if (system.source !== "website" || !system.families.length) return false;
  const connected = new Set(previewSources.map((source) => source.family.toLowerCase()));
  return system.families.every((family) => connected.has(family.toLowerCase()));
}

function consolidateTypographySystems(systems: ProductWorkspace["brand"]["typographySystems"]) {
  const merged = new Map<string, ProductWorkspace["brand"]["typographySystems"][number]>();
  for (const system of systems) {
    const labelKey = system.source === "website" ? "website" : system.sourceLabel.toLowerCase().replace(/\.[a-z0-9]{2,5}$/i, "").replace(/[^a-z0-9]+/g, " ").trim();
    const key = `${system.source}:${labelKey}`;
    const existing = merged.get(key);
    merged.set(key, existing ? { ...existing, ...system, families: Array.from(new Set([...existing.families, ...system.families])), usage: system.usage || existing.usage, sample: system.sample || existing.sample, verified: existing.verified || system.verified } : system);
  }
  return [...merged.values()];
}

function compactMaterialsForUpload(materials: PreparedMaterial[]) {
  let textBudget = 170_000;
  let imageBudget = 2_400_000;
  return materials.map((material) => {
    const text = material.text.slice(0, Math.max(0, textBudget));
    textBudget -= text.length;
    const images: string[] = [];
    for (const image of material.images) {
      if (image.length > imageBudget) continue;
      images.push(image);
      imageBudget -= image.length;
      if (images.length >= 8) break;
    }
    return { ...material, text, images };
  });
}

function isContactCsv(file: File, material: PreparedMaterial) {
  const csv = file.name.toLowerCase().endsWith(".csv") || /csv/i.test(file.type || material.mimeType);
  if (!csv || !material.text.trim()) return false;
  const header = material.text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0].toLowerCase().replace(/[^a-z0-9,@;_-]+/g, "");
  return /(^|[,;])(?:e-?mail|email_?address|mail)([,;]|$)/i.test(header);
}

function isNewsletterCampaignInstruction(value: string) {
  return /\b(newsletter|email campaign|mailing|mailchimp|subscriber|send (?:an |a )?email|email (?:these|the) contacts)\b/i.test(value);
}

function ContentLibrary({ userId, workspace, runs, mediaConfigured, videoConfigured, onSave, onIssuesFound, onOpen, onStart, notify }: { userId: string; workspace: ProductWorkspace; runs: AgentRun[]; mediaConfigured: boolean; videoConfigured: boolean; onSave: (workspace: ProductWorkspace) => void; onIssuesFound: (projectId: string, findings: IssueFindings | undefined) => void; onOpen: (id: string) => void; onStart: () => void; notify: (message: string) => void }) {
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [summary, setSummary] = useState<MediaBudgetSummary>({ monthlyCapCents: 2500, approvedThisMonthCents: 0, actualThisMonthCents: 0, billingOwner: "user" });
  const [budgetDraft, setBudgetDraft] = useState("25.00");
  const [budgetSaving, setBudgetSaving] = useState(false);
  const budgetDirty = useRef(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [direction, setDirection] = useState("");
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [proposals, setProposals] = useState<AssetProposal[]>([]);
  const [assetLink, setAssetLink] = useState("");
  const [assetWorking, setAssetWorking] = useState("");
  const assetInput = useRef<HTMLInputElement>(null);
  const replacementInput = useRef<HTMLInputElement>(null);
  const [replacementTarget, setReplacementTarget] = useState<{ type: "source" | "asset"; id: string; name: string } | null>(null);
  const [preview, setPreview] = useState<{ items: SourceMediaAsset[]; index: number; objectUrl?: string } | null>(null);

  const applyMediaResponse = (data: { job?: MediaJob; jobs?: MediaJob[]; summary?: MediaBudgetSummary }) => {
    if (data.jobs) setJobs(data.jobs);
    if (data.job) setJobs((current) => [data.job!, ...current.filter((job) => job.id !== data.job!.id)]);
    if (data.summary) {
      setSummary(data.summary);
      if (!budgetDirty.current) setBudgetDraft((data.summary.monthlyCapCents / 100).toFixed(2));
    }
  };
  const applyAssetResponse = (data: { assets?: ProjectAsset[]; proposals?: AssetProposal[] }) => {
    if (data.assets) setAssets(data.assets);
    if (data.proposals) setProposals(data.proposals);
  };

  const refresh = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const response = await apiFetch(`/api/media?projectId=${encodeURIComponent(workspace.id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Media library could not be opened.");
      applyMediaResponse(data);
    } catch (error) {
      if (!silent) notify(error instanceof Error ? error.message : "Media library could not be opened.");
    } finally {
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    apiFetch(`/api/media?projectId=${encodeURIComponent(workspace.id)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Media library could not be opened.");
        if (active) applyMediaResponse(data);
      })
      .catch((error) => { if (active) notify(error instanceof Error ? error.message : "Media library could not be opened."); })
      .finally(() => { if (active) setLoading(false); });
    const timer = window.setInterval(() => {
      if (!active) return;
      apiFetch(`/api/media?projectId=${encodeURIComponent(workspace.id)}`)
        .then(async (response) => response.ok ? response.json() : null)
        .then((data) => { if (active && data) applyMediaResponse(data); })
        .catch(() => undefined);
    }, 8000);
    return () => { active = false; window.clearInterval(timer); };
  }, [workspace.id]);

  useEffect(() => {
    let active = true;
    apiFetch(`/api/assets?projectId=${encodeURIComponent(workspace.id)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Existing assets could not be opened.");
        if (active) applyAssetResponse(data);
      })
      .catch((error) => { if (active) notify(error instanceof Error ? error.message : "Existing assets could not be opened."); });
    return () => { active = false; };
  }, [workspace.id]);

  const registerAssetFile = async (file: File) => {
    const token = await getAccessToken();
    const prepared = await prepareMaterial(file);
    const compact = compactMaterialsForUpload([prepared])[0];
    const safeName = file.name.replace(/[^a-z0-9._-]+/gi, "-").slice(-180) || "asset";
    const pathname = `market-agent-assets/${encodeURIComponent(userId)}/${encodeURIComponent(workspace.id)}/${Date.now()}-${safeName}`;
    const blob = await upload(pathname, file, {
      access: "private",
      handleUploadUrl: "/api/asset-upload",
      clientPayload: JSON.stringify({ projectId: workspace.id }),
      headers: { Authorization: `Bearer ${token}` },
      contentType: file.type || prepared.mimeType,
      multipart: file.size > 5 * 1024 * 1024,
    });
    const response = await apiFetch("/api/assets", {
      method: "POST",
      body: JSON.stringify({
        action: "register-upload",
        projectId: workspace.id,
        name: file.name,
        kind: prepared.kind,
        mimeType: file.type || prepared.mimeType,
        sizeBytes: file.size,
        blobPath: blob.pathname,
        detail: prepared.detail,
        text: compact.text,
        images: compact.images,
        workspace,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `${file.name} could not be analyzed.`);
    applyAssetResponse(data);
    if (Array.isArray(data.routing?.destinations) && data.routing.destinations.includes("brand")) onIssuesFound(workspace.id, data.issueFindings as IssueFindings | undefined);
    return data.asset as ProjectAsset;
  };

  const uploadAssets = async (files: FileList | null) => {
    const selected = Array.from(files || []);
    if (!selected.length) return;
    if (!mediaConfigured) { notify("Connect OpenAI or Gemini before adding assets for analysis."); return; }
    setAssetWorking(`Reading 1 of ${selected.length}`);
    try {
      for (const [index, file] of selected.entries()) {
        setAssetWorking(`Analyzing ${index + 1} of ${selected.length}`);
        await registerAssetFile(file);
      }
      notify(`${selected.length} ${selected.length === 1 ? "asset was" : "assets were"} uploaded, tagged, and evaluated.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The assets could not be uploaded.");
    } finally {
      setAssetWorking("");
      if (assetInput.current) assetInput.current.value = "";
    }
  };

  const requestReplacement = (type: "source" | "asset", item: { id: string; name: string }) => {
    if (!mediaConfigured) { notify("Connect OpenAI or Gemini first so the replacement can be analyzed."); return; }
    setReplacementTarget({ type, id: item.id, name: item.name });
    replacementInput.current?.click();
  };

  const replaceAsset = async (files: FileList | null) => {
    const file = files?.[0];
    const target = replacementTarget;
    if (!file || !target) return;
    setAssetWorking(`Replacing ${target.name}`);
    try {
      const replacement = await registerAssetFile(file);
      if (!replacement || replacement.status === "failed") throw new Error("The replacement was uploaded but could not be analyzed, so the existing asset was kept.");
      if (target.type === "source") {
        onSave({ ...workspace, sourceMedia: (workspace.sourceMedia || []).filter((item) => item.id !== target.id), updatedAt: new Date().toISOString() });
      } else {
        const response = await apiFetch("/api/assets", { method: "POST", body: JSON.stringify({ action: "delete-asset", id: target.id }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "The old asset could not be removed.");
        applyAssetResponse(data);
      }
      notify("Replacement uploaded, analyzed, and saved. The previous asset was removed.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The asset could not be replaced.");
    } finally {
      setAssetWorking("");
      setReplacementTarget(null);
      if (replacementInput.current) replacementInput.current.value = "";
    }
  };

  const deleteSourceMedia = (item: SourceMediaAsset) => {
    if (!window.confirm(`Delete “${item.name}” from this project’s Content Library?`)) return;
    onSave({ ...workspace, sourceMedia: (workspace.sourceMedia || []).filter((candidate) => candidate.id !== item.id), updatedAt: new Date().toISOString() });
    notify("Asset deleted from this project.");
  };

  const deleteProjectAsset = async (asset: ProjectAsset) => {
    if (!window.confirm(`Delete “${asset.name}” from this project’s Content Library?`)) return;
    setAssetWorking(asset.id);
    try {
      const response = await apiFetch("/api/assets", { method: "POST", body: JSON.stringify({ action: "delete-asset", id: asset.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The asset could not be deleted.");
      applyAssetResponse(data);
      notify("Asset deleted from this project.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The asset could not be deleted.");
    } finally {
      setAssetWorking("");
    }
  };

  const updateProjectAssetMetadata = async (asset: ProjectAsset, changes: { name: string; summary: string }) => {
    setAssetWorking(asset.id);
    try {
      const response = await apiFetch("/api/assets", { method: "POST", body: JSON.stringify({ action: "update-asset", id: asset.id, name: changes.name, summary: changes.summary }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The asset information could not be saved.");
      applyAssetResponse(data);
      notify("Asset information saved. The assistant will use the corrected name and description.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The asset information could not be saved.");
      throw error;
    } finally {
      setAssetWorking("");
    }
  };

  const closePreview = () => {
    if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
    setPreview(null);
  };

  const previewProjectAsset = async (asset: ProjectAsset) => {
    if (!(["image", "video"] as string[]).includes(asset.kind)) { notify("Preview is available for images and video. Documents remain downloadable."); return; }
    setAssetWorking(asset.id);
    try {
      let url = asset.sourceUrl;
      let objectUrl = "";
      if (asset.downloadable) {
        const response = await apiFetch(`/api/project-asset?id=${encodeURIComponent(asset.id)}&type=asset&disposition=inline`);
        if (!response.ok) { const data = await response.json(); throw new Error(data.error || "The preview could not be opened."); }
        objectUrl = URL.createObjectURL(await response.blob());
        url = objectUrl;
      }
      if (!url) throw new Error("This asset has no previewable file.");
      setPreview({ items: [{ id: asset.id, kind: asset.kind as "image" | "video", name: asset.name, url, role: asset.detail || "Uploaded asset", tags: asset.tags, recommendation: asset.recommendation === "archive" || asset.recommendation === "replace" ? "review" : asset.recommendation }], index: 0, objectUrl });
    } catch (error) {
      notify(error instanceof Error ? error.message : "The preview could not be opened.");
    } finally {
      setAssetWorking("");
    }
  };

  const addAssetLink = async () => {
    if (!assetLink.trim()) return;
    if (!mediaConfigured) { notify("Connect OpenAI or Gemini before adding assets for analysis."); return; }
    setAssetWorking("Reading linked asset");
    try {
      const response = await apiFetch("/api/assets", { method: "POST", body: JSON.stringify({ action: "add-link", projectId: workspace.id, sourceUrl: assetLink.trim(), workspace }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The linked asset could not be analyzed.");
      applyAssetResponse(data);
      if (Array.isArray(data.routing?.destinations) && data.routing.destinations.includes("brand")) onIssuesFound(workspace.id, data.issueFindings as IssueFindings | undefined);
      setAssetLink("");
      notify("The linked asset was tagged and evaluated.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The linked asset could not be analyzed.");
    } finally {
      setAssetWorking("");
    }
  };

  const approveProposal = async (proposal: AssetProposal) => {
    if (!window.confirm(`Approve up to ${money(proposal.estimatedCostCents)} of API usage to create “${proposal.title}”? The document will be produced immediately.`)) return;
    setAssetWorking(proposal.id);
    try {
      const response = await apiFetch("/api/assets", { method: "POST", body: JSON.stringify({ action: "approve-proposal", id: proposal.id, approvedBudgetCents: proposal.estimatedCostCents, workspace }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The proposal could not be approved.");
      applyAssetResponse(data);
      notify(data.proposal?.status === "complete" ? "The approved document is ready." : "Document production started.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The proposal could not be approved.");
    } finally {
      setAssetWorking("");
    }
  };

  const declineProposal = async (proposal: AssetProposal) => {
    setAssetWorking(proposal.id);
    try {
      const response = await apiFetch("/api/assets", { method: "POST", body: JSON.stringify({ action: "cancel-proposal", id: proposal.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The proposal could not be declined.");
      applyAssetResponse(data);
      notify("Proposal declined. Nothing was created or spent.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The proposal could not be declined.");
    } finally {
      setAssetWorking("");
    }
  };

  const downloadProjectFile = async (id: string, type: "asset" | "proposal", name: string) => {
    setAssetWorking(id);
    try {
      const response = await apiFetch(`/api/project-asset?id=${encodeURIComponent(id)}&type=${type}`);
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "The file could not be downloaded."); }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The file could not be downloaded.");
    } finally {
      setAssetWorking("");
    }
  };

  const prepare = async (kind: "image" | "video", adaptation?: ProjectAsset) => {
    setWorking(`prepare-${kind}`);
    try {
      const response = await apiFetch("/api/media", {
        method: "POST",
        body: JSON.stringify({
          action: "prepare",
          projectId: workspace.id,
          kind,
          workspace,
          recentRuns: runs,
          direction: adaptation ? `Adapt the uploaded asset “${adaptation.name}”. ${adaptation.suggestedChanges.join(" ")} Preserve what is useful, correct the identified weaknesses, and follow the saved brand identity.` : direction,
          sourceAssetId: adaptation?.kind === "image" ? adaptation.id : "",
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The creative could not be prepared.");
      applyMediaResponse(data);
      setDirection("");
      notify(`${adaptation ? "The adapted version" : `The ${kind} brief`} is ready. Review the maximum cost and approve it when you want production to start.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The creative could not be prepared.");
    } finally {
      setWorking("");
    }
  };

  const approve = async (job: MediaJob) => {
    const maximum = money(job.estimatedCostCents);
    if (!window.confirm(`Approve an estimated maximum of ${maximum} for this ${job.kind}? Production starts immediately. Your API provider calculates the final charge.`)) return;
    setWorking(job.id);
    try {
      const response = await apiFetch("/api/media", {
        method: "POST",
        body: JSON.stringify({ action: "approve", id: job.id, approvedBudgetCents: job.estimatedCostCents }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Budget approval could not be applied.");
      applyMediaResponse(data);
      notify(data.job?.status === "complete" ? `${job.kind === "image" ? "Image" : "Video"} created and saved.` : "Budget approved. Production has started.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Budget approval could not be applied.");
      await refresh(true);
    } finally {
      setWorking("");
    }
  };

  const cancel = async (job: MediaJob) => {
    setWorking(job.id);
    try {
      const response = await apiFetch("/api/media", { method: "POST", body: JSON.stringify({ action: "cancel", id: job.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The request could not be cancelled.");
      applyMediaResponse(data);
      notify("The unapproved request was cancelled. Nothing was spent.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The request could not be cancelled.");
    } finally {
      setWorking("");
    }
  };

  const saveBudget = async () => {
    const dollars = Number(budgetDraft);
    if (!Number.isFinite(dollars) || dollars < 0) { notify("Enter a valid monthly amount."); return; }
    const monthlyCapCents = Math.round(dollars * 100);
    setBudgetSaving(true);
    try {
      const response = await apiFetch("/api/media", { method: "POST", body: JSON.stringify({ action: "set-budget", monthlyCapCents }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The monthly limit could not be saved.");
      budgetDirty.current = false;
      applyMediaResponse(data);
      notify(`Monthly creative-production limit set to ${money(monthlyCapCents)} across your account.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The monthly limit could not be saved.");
    } finally {
      setBudgetSaving(false);
    }
  };

  const activeJobs = jobs.filter((job) => job.status !== "cancelled");
  const waiting = activeJobs.filter((job) => job.status === "awaiting_budget");
  const completed = activeJobs.filter((job) => job.status === "complete");
  const inProduction = activeJobs.filter((job) => ["approved", "running"].includes(job.status));
  const needsAttention = activeJobs.filter((job) => job.status === "failed");
  const remaining = Math.max(0, summary.monthlyCapCents - summary.approvedThisMonthCents);
  const activeProposals = proposals.filter((proposal) => proposal.status !== "cancelled");
  const waitingProposals = activeProposals.filter((proposal) => proposal.status === "awaiting_approval");
  const producedProposals = activeProposals.filter((proposal) => proposal.status === "complete");
  const completedMedia: SourceMediaAsset[] = completed.map((job) => ({ id: job.id, kind: job.kind, name: job.title, url: job.assetUrl, role: "Generated asset", tags: [job.kind, "generated"], recommendation: "reuse" }));

  return <div className="op-stack">
    <div className="op-heading"><div className="op-eyebrow">Creative production and saved assets</div><h1>Content library</h1><p>The agent evaluates existing work and proposes new assets from this project's Brand. You approve the estimated spend before paid production starts.</p></div>
    <input ref={replacementInput} className="op-hidden-input" type="file" accept=".pdf,.pptx,.docx,.txt,.md,.csv,image/*,video/*" onChange={(event) => void replaceAsset(event.target.files)} />

    {((workspace.sourceMedia || []).length > 0 || (workspace.materials || []).length > 0 || (workspace.sources || []).length > 0) && <section className="op-project-assets-ready"><div className="op-section-title"><div><small>ALREADY SAVED WITH THIS PROJECT</small><h2>Assets available to the agent</h2><p>Browse the full set here. Preview images and video without leaving Market Agent; replace or delete anything that should no longer be used.</p></div><em>{(workspace.sourceMedia || []).length + (workspace.materials || []).length + (workspace.sources || []).length}</em></div>{(workspace.sourceMedia || []).length > 0 && <SourceMediaStrip media={workspace.sourceMedia || []} title="Reusable images and video" subtitle="Extracted from connected project sources and available for campaign work." limit={(workspace.sourceMedia || []).length} managing onDelete={deleteSourceMedia} onReplace={(item) => requestReplacement("source", item)} />}{((workspace.materials || []).length > 0 || (workspace.sources || []).length > 0) && <div className="op-saved-source-list">{(workspace.materials || []).map((material) => <div key={material.id}><MaterialIcon kind={material.kind} /><span><strong>{material.name}</strong><small>Uploaded and already analyzed</small></span><em>Saved</em></div>)}{(workspace.sources || []).map((source) => <a key={source.id} href={source.url} target="_blank" rel="noreferrer"><SourceServiceIcon url={source.url} /><span><strong>{source.label}</strong><small>{source.url}</small></span><em>Open source <ArrowRight size={12} /></em></a>)}</div>}</section>}

    <section className="op-existing-assets"><div className="op-existing-assets__head"><div><small>ADD MORE · OPTIONAL</small><h2>Add another asset</h2><p>Only use this when you have something new. Upload files directly, or add another public Figma, Slides, document, image, or video link.</p></div><button onClick={() => assetInput.current?.click()} disabled={!mediaConfigured || Boolean(assetWorking)}><UploadCloud size={16} />{assetWorking || "Upload new assets"}</button><input ref={assetInput} type="file" multiple accept=".pdf,.pptx,.docx,.txt,.md,.csv,image/*,video/*" onChange={(event) => void uploadAssets(event.target.files)} /></div><div className="op-asset-link"><Link2 size={15} /><input value={assetLink} onChange={(event) => setAssetLink(event.target.value)} placeholder="Optional: paste another public asset link" /><button onClick={() => void addAssetLink()} disabled={!assetLink.trim() || Boolean(assetWorking)}>Add and analyze</button></div>{!mediaConfigured && <div className="op-asset-setup"><KeyRound size={15} /> Connect OpenAI or Gemini first so the agent can evaluate newly added work.</div>}</section>

    {assets.length > 0 && <section className="op-asset-decisions"><div className="op-section-title"><div><small>AGENT DECISIONS</small><h2>What to use, change, or retire</h2><p>Double-click an asset name or description to correct it.</p></div><em>{assets.length}</em></div><div className="op-asset-grid">{assets.map((asset) => <ProjectAssetDecisionCard
      key={asset.id}
      asset={asset}
      busy={assetWorking === asset.id}
      anyAssetBusy={Boolean(assetWorking)}
      generationBusy={Boolean(working)}
      mediaConfigured={mediaConfigured}
      videoConfigured={videoConfigured}
      onUpdate={(changes) => updateProjectAssetMetadata(asset, changes)}
      onPreview={() => void previewProjectAsset(asset)}
      onReplace={() => requestReplacement("asset", asset)}
      onDelete={() => void deleteProjectAsset(asset)}
      onPrepare={() => void prepare(asset.kind === "video" && videoConfigured ? "video" : "image", asset)}
      onDownload={() => void downloadProjectFile(asset.id, "asset", asset.name)}
    />)}</div></section>}

    {waitingProposals.length > 0 && <section className="op-proposal-section"><div className="op-section-title"><div><small>AGENT PROPOSALS · APPROVAL REQUIRED</small><h2>New deliverables worth creating</h2></div><em>{waitingProposals.length}</em></div><div className="op-proposal-list">{waitingProposals.map((proposal) => <article key={proposal.id}><span>{proposal.kind === "deck" ? <LayoutDashboard size={19} /> : <FileText size={19} />}</span><div><small>{proposal.kind === "deck" ? "PRESENTATION DECK" : "PDF DOCUMENT"}</small><strong>{proposal.title}</strong><p>{proposal.description}</p><blockquote>{proposal.rationale}</blockquote></div><aside><em>Up to {money(proposal.estimatedCostCents)} API usage</em><button onClick={() => void approveProposal(proposal)} disabled={assetWorking === proposal.id}>{assetWorking === proposal.id ? "Creating…" : "Approve and create"}</button><button className="secondary" onClick={() => void declineProposal(proposal)} disabled={assetWorking === proposal.id}>Decline</button></aside></article>)}</div></section>}

    {producedProposals.length > 0 && <section className="op-proposal-section"><div className="op-section-title"><div><small>APPROVED DELIVERABLES</small><h2>Created documents and decks</h2></div><em>{producedProposals.length}</em></div><div className="op-produced-list">{producedProposals.map((proposal) => <article key={proposal.id}><span>{proposal.kind === "deck" ? <LayoutDashboard size={18} /> : <FileText size={18} />}</span><div><strong>{proposal.title}</strong><small>{proposal.kind === "deck" ? "Presentation deck · PDF" : "PDF document"}</small></div><button onClick={() => void downloadProjectFile(proposal.id, "proposal", `${proposal.title}.pdf`)} disabled={assetWorking === proposal.id}><ArrowRight size={14} />{assetWorking === proposal.id ? "Downloading…" : "Download"}</button></article>)}</div></section>}

    <section className="op-media-budget">
      <div><span><ShieldCheck size={20} /></span><div><small>YOUR MONTHLY APPROVAL LIMIT</small><strong>{money(summary.monthlyCapCents)} across all projects</strong><p>{money(summary.actualThisMonthCents)} estimated provider usage · {money(summary.approvedThisMonthCents)} approved maximum · {money(remaining)} still available</p></div><label className="op-budget-edit"><span>Monthly maximum</span><div><i>$</i><input type="number" min="0" max="10000" step="1" value={budgetDraft} onChange={(event) => { budgetDirty.current = true; setBudgetDraft(event.target.value); }} /><button onClick={() => void saveBudget()} disabled={budgetSaving}>{budgetSaving ? "Saving…" : "Save limit"}</button></div></label></div>
      <div className="op-budget-meter"><i style={{ width: `${Math.min(100, Math.round((summary.approvedThisMonthCents / Math.max(1, summary.monthlyCapCents)) * 100))}%` }} /></div>
      <small>Image and video requests use your private API connection, so the provider charges your account—not Market Agent’s. Every asset needs separate approval, and Market Agent blocks requests above this limit. Provider invoices can differ from estimates; use a provider-side billing limit too when available. Set this limit to $0 to disable paid production.</small>
    </section>

    <section className="op-media-create">
      <div className="op-media-create__head"><div><span><WandSparkles size={19} /></span><div><strong>Let the agent create the asset</strong><p>No form to complete. Add a correction only if you want one; otherwise the project context drives the creative.</p></div></div>{!mediaConfigured && <em>Connect OpenAI or Gemini</em>}</div>
      <textarea value={direction} onChange={(event) => setDirection(event.target.value)} placeholder="Optional correction, e.g. make it energetic and cinematic. Leave blank for the agent to decide." />
      <div className="op-media-actions"><button onClick={() => void prepare("image")} disabled={!mediaConfigured || Boolean(working)}><ImageIcon size={16} />{working === "prepare-image" ? "Preparing…" : "Prepare campaign image"}</button><button onClick={() => void prepare("video")} disabled={!videoConfigured || Boolean(working)} title={videoConfigured ? "" : "Connect Gemini to create video"}><Video size={16} />{working === "prepare-video" ? "Preparing…" : videoConfigured ? "Prepare short video" : "Connect Gemini for video"}</button></div>
      <small>Preparing a brief is free. Paid generation begins only after the next approval.</small>
    </section>

    {waiting.length > 0 && <section className="op-media-section"><div className="op-section-title"><div><small>YOUR APPROVAL REQUIRED</small><h2>Ready for production</h2></div><em>{waiting.length}</em></div><div className="op-media-job-list">{waiting.map((job) => <MediaJobCard key={job.id} job={job} working={working === job.id} onApprove={() => void approve(job)} onCancel={() => void cancel(job)} />)}</div></section>}

    {inProduction.length > 0 && <section className="op-media-section"><div className="op-section-title"><div><small>CLOUD PRODUCTION</small><h2>Creating now</h2></div><LoaderCircle className="spin" size={18} /></div><div className="op-media-job-list">{inProduction.map((job) => <MediaJobCard key={job.id} job={job} working />)}</div></section>}

    {needsAttention.length > 0 && <section className="op-media-section"><div className="op-section-title"><div><small>NEEDS ATTENTION</small><h2>Production issues</h2></div><em>{needsAttention.length}</em></div><div className="op-media-job-list">{needsAttention.map((job) => <MediaJobCard key={job.id} job={job} working={false} />)}</div></section>}

    <section className="op-media-section"><div className="op-section-title"><div><small>SAVED MEDIA</small><h2>Generated assets</h2></div><em>{completed.length}</em></div>{loading ? <div className="op-media-loading"><LoaderCircle className="spin" size={19} /> Opening media library…</div> : completed.length ? <div className="op-media-gallery">{completed.map((job, index) => <article key={job.id}><button className="op-media-gallery__preview" onClick={() => setPreview({ items: completedMedia, index })}>{job.kind === "video" ? <VideoCover src={job.assetUrl} label={job.title} /> : <img src={job.assetUrl} alt={job.title} />}<span>Preview</span></button><div><span>{job.kind === "video" ? <Video size={15} /> : <ImageIcon size={15} />}</span><div><strong>{job.title}</strong><small>{job.actualCostCents == null ? `Approved estimate up to ${money(job.approvedBudgetCents)}` : `${money(job.actualCostCents)} usage estimate`} · {new Date(job.createdAt).toLocaleDateString()}</small></div><button onClick={() => setPreview({ items: completedMedia, index })} aria-label="Preview media"><ArrowRight size={15} /></button></div></article>)}</div> : <div className="op-empty op-empty--media"><span><ImageIcon size={22} /></span><h2>No generated media yet.</h2><p>The agent can prepare the first image or video brief above without spending anything.</p></div>}</section>

    <section className="op-media-section"><div className="op-section-title"><div><small>WRITING AND CHANNEL PACKS</small><h2>Social content</h2></div><em>{runs.length}</em></div>{runs.length ? <div className="op-run-list">{runs.map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div> : <div className="op-empty op-empty--compact"><span><FileText size={22} /></span><h2>No social content pack yet.</h2><p>Run the agent to create channel copy and a publishing queue.</p><button onClick={onStart}><Sparkles size={15} /> Open agent</button></div>}</section>
    {preview && <MediaPreviewOverlay items={preview.items} index={preview.index} onIndex={(index) => setPreview((current) => current ? { ...current, index } : current)} onClose={closePreview} />}
  </div>;
}

function ProjectAssetDecisionCard({ asset, busy, anyAssetBusy, generationBusy, mediaConfigured, videoConfigured, onUpdate, onPreview, onReplace, onDelete, onPrepare, onDownload }: {
  asset: ProjectAsset;
  busy: boolean;
  anyAssetBusy: boolean;
  generationBusy: boolean;
  mediaConfigured: boolean;
  videoConfigured: boolean;
  onUpdate: (changes: { name: string; summary: string }) => Promise<void>;
  onPreview: () => void;
  onReplace: () => void;
  onDelete: () => void;
  onPrepare: () => void;
  onDownload: () => void;
}) {
  const [editing, setEditing] = useState<"name" | "summary" | null>(null);
  const [name, setName] = useState(asset.name);
  const [summary, setSummary] = useState(asset.summary);
  useEffect(() => { setName(asset.name); setSummary(asset.summary); }, [asset.name, asset.summary]);
  const cancelEdit = () => { setName(asset.name); setSummary(asset.summary); setEditing(null); };
  const saveEdit = async () => {
    const nextName = name.trim();
    const nextSummary = summary.trim();
    if (!nextName || !nextSummary) { cancelEdit(); return; }
    if (nextName === asset.name && nextSummary === asset.summary) { setEditing(null); return; }
    try { await onUpdate({ name: nextName, summary: nextSummary }); setEditing(null); }
    catch { /* The parent reports the failure; keep the editor open for correction. */ }
  };
  const decision = asset.status === "failed" ? "Needs attention" : ({ reuse: "Ready to use", adapt: "Needs adaptation", replace: "Replace", archive: "Archive", review: "Review" } as Record<string, string>)[asset.recommendation] || "Review";
  const explanation = asset.status === "failed" ? "The file could not be analyzed." : ({ reuse: "The agent considers this usable as it is.", adapt: "Useful, but it needs creative or format changes before publishing.", replace: "A different asset would serve the project better.", archive: "Keep it for reference, but do not use it in current work.", review: "A person should decide how this asset is used." } as Record<string, string>)[asset.recommendation] || "Review how this asset should be used.";
  const canPrepare = asset.status === "ready" && ["adapt", "replace"].includes(asset.recommendation) && ["image", "video"].includes(asset.kind);
  return <article className={`decision-${asset.recommendation}`}>
    {["image", "video"].includes(asset.kind) && (asset.downloadable || asset.sourceUrl) && <ProjectAssetCover asset={asset} onOpen={onPreview} />}
    <header><span>{asset.kind === "image" ? <ImageIcon size={20} /> : asset.kind === "video" ? <Video size={20} /> : asset.kind === "figma" ? <LayoutDashboard size={20} /> : <FileText size={20} />}</span><div>{editing === "name" ? <input className="op-asset-inline-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} onBlur={() => void saveEdit()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") cancelEdit(); }} /> : <strong title="Double-click to edit" onDoubleClick={() => setEditing("name")}>{asset.name}</strong>}<small>{asset.detail || asset.kind}</small></div><em>{decision}</em></header>
    <p className="op-asset-decision-explainer">{explanation}</p>
    {asset.status === "failed" ? <p className="error">{asset.error}</p> : <>{editing === "summary" ? <textarea className="op-asset-inline-summary" autoFocus value={summary} onChange={(event) => setSummary(event.target.value)} onBlur={() => void saveEdit()} onKeyDown={(event) => { if (event.key === "Escape") cancelEdit(); if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.blur(); }} /> : <p title="Double-click to edit" onDoubleClick={() => setEditing("summary")}>{asset.summary}</p>}<div className="op-asset-tags">{asset.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><details><summary>Why this decision <ChevronDown size={13} /></summary><p>{asset.rationale}</p>{asset.suggestedChanges.length > 0 && <ul>{asset.suggestedChanges.map((change) => <li key={change}>{change}</li>)}</ul>}</details></>}
    {canPrepare && <button className="op-adapt-button" onClick={onPrepare} disabled={!mediaConfigured || generationBusy || (asset.kind === "video" && !videoConfigured)}><WandSparkles size={13} />{asset.kind === "video" ? "Prepare revised video" : asset.recommendation === "adapt" ? "Prepare adapted version" : "Prepare replacement"}</button>}
    <div className="op-asset-controls">{["image", "video"].includes(asset.kind) && (asset.downloadable || asset.sourceUrl) && <button onClick={onPreview} disabled={busy}><ImageIcon size={13} />{busy ? "Opening…" : "Preview"}</button>}<button onClick={onReplace} disabled={anyAssetBusy}><UploadCloud size={13} /> Replace</button><button className="danger" onClick={onDelete} disabled={busy}><Trash2 size={13} /> Delete</button></div>
    {asset.downloadable && <button className="op-asset-download" onClick={onDownload} disabled={busy}><ArrowRight size={13} />{busy ? "Working…" : "Download original"}</button>}
    {asset.sourceUrl && !["image", "video"].includes(asset.kind) && <a className="op-asset-download" href={asset.sourceUrl} target="_blank" rel="noreferrer"><ArrowRight size={13} /> Open source</a>}
  </article>;
}

function ProjectAssetCover({ asset, onOpen }: { asset: ProjectAsset; onOpen: () => void }) {
  const host = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState(asset.sourceUrl || "");
  useEffect(() => {
    const element = host.current;
    if (!element || visible) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
    }, { rootMargin: "240px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  useEffect(() => {
    if (!visible || url || !asset.downloadable) return;
    let active = true;
    void apiFetch(`/api/project-asset?id=${encodeURIComponent(asset.id)}&type=asset&mode=preview-url`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Preview unavailable");
        if (active) setUrl(String(data.url || ""));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [asset.downloadable, asset.id, url, visible]);
  return <button ref={host} className="op-project-asset-cover" onClick={onOpen} aria-label={`Preview ${asset.name}`}>
    {url ? asset.kind === "video" ? <VideoCover src={url} label={asset.name} /> : <img src={url} alt={asset.name} loading="lazy" /> : <span className="op-project-asset-cover__loading"><LoaderCircle className="spin" size={17} /> Preparing preview…</span>}
    <span className="op-source-media__expand">Preview</span>
  </button>;
}

function MediaJobCard({ job, working, onApprove, onCancel }: { job: MediaJob; working: boolean; onApprove?: () => void; onCancel?: () => void }) {
  return <article className={`op-media-job op-media-job--${job.status}`}><div className="op-media-job__icon">{job.kind === "video" ? <Video size={19} /> : <ImageIcon size={19} />}</div><div className="op-media-job__body"><div><strong>{job.title}</strong><em>{mediaStatusLabel(job.status)}</em></div><p>{job.kind === "video" ? `${job.durationSeconds}-second vertical video with audio` : "Campaign-ready vertical image"} · {job.resolution} · {job.aspectRatio}</p><details><summary>See the agent's creative brief</summary><p>{job.prompt}</p></details>{job.error && <small className="error">{job.error}</small>}</div><div className="op-media-job__cost"><small>ESTIMATED MAX</small><strong>{money(job.estimatedCostCents)}</strong>{job.status === "awaiting_budget" && <><button onClick={onApprove} disabled={working}>{working ? "Starting…" : `Approve ${money(job.estimatedCostCents)} estimate`}</button><button className="secondary" onClick={onCancel} disabled={working}>Cancel</button></>}{["approved", "running"].includes(job.status) && <span><LoaderCircle className="spin" size={14} /> Creating</span>}</div></article>;
}

function mediaStatusLabel(status: MediaJob["status"]) {
  const labels: Record<MediaJob["status"], string> = { awaiting_budget: "Waiting for budget", approved: "Approved", running: "In production", complete: "Complete", failed: "Needs attention", cancelled: "Cancelled" };
  return labels[status];
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(cents / 100);
}

type AnalyticsTab = "overview" | "website" | SocialAnalyticsReport["provider"];

const analyticsTabs: Array<{ id: AnalyticsTab; label: string }> = [
  { id: "overview", label: "Growth overview" },
  { id: "website", label: "Website" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube", label: "YouTube" },
  { id: "x", label: "X" },
  { id: "discord", label: "Discord" },
  { id: "reddit", label: "Reddit" },
];

function AnalyticsDashboard({ workspace, connections, onSave, onConnect }: { workspace: ProductWorkspace; connections: ConnectionStatus; onSave: (workspace: ProductWorkspace) => void; onConnect: () => void }) {
  const [range, setRange] = useState("28daysAgo");
  const [tab, setTab] = useState<AnalyticsTab>("overview");
  const inferredGrowth = useMemo(() => inferProjectGrowthPlan(workspace), [workspace]);
  useEffect(() => {
    if (workspace.growth?.objective && workspace.growth?.primaryConversion) return;
    onSave({ ...workspace, growth: inferredGrowth, updatedAt: new Date().toISOString() });
  }, [inferredGrowth, onSave, workspace]);
  const anyConnection = connections.analytics.canRead || (["linkedin", "instagram", "tiktok", "youtube", "x", "discord", "reddit"] as const).some((provider) => connections[provider].connected);
  return <div className="op-stack">
    <div className="op-analytics-heading"><div className="op-heading"><div className="op-eyebrow">Growth and measurable outcomes</div><h1>Growth</h1><p>See whether visibility is building an audience, sending people to the website, and producing the project’s primary business outcome.</p></div><label><span>REPORTING WINDOW</span><select value={range} onChange={(event) => setRange(event.target.value)}><option value="7daysAgo">Last 7 days</option><option value="28daysAgo">Last 28 days</option><option value="30daysAgo">Last 30 days</option><option value="60daysAgo">Last 60 days</option><option value="90daysAgo">Last 90 days</option></select></label></div>
    <nav className="op-analytics-tabs" aria-label="Growth and analytics views">{analyticsTabs.map((item) => {
      const connected = item.id === "overview" ? anyConnection : item.id === "website" ? connections.analytics.canRead : connections[item.id].connected;
      return <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}><i className={connected ? "connected" : ""} />{item.label}</button>;
    })}</nav>
    {tab === "overview"
      ? <GrowthOverviewPanel workspace={workspace} suggestedGoal={inferredGrowth} range={range} onSave={onSave} onConnect={onConnect} />
      : tab === "website"
        ? <WebsiteAnalyticsPanel projectId={workspace.id} connection={connections.analytics} range={range} onConnect={onConnect} />
        : <SocialAnalyticsPanel projectId={workspace.id} provider={tab} connection={connections[tab]} range={range} onConnect={onConnect} />}
  </div>;
}

function GrowthOverviewPanel({ workspace, suggestedGoal, range, onSave, onConnect }: { workspace: ProductWorkspace; suggestedGoal: ProductWorkspace["growth"]; range: string; onSave: (workspace: ProductWorkspace) => void; onConnect: () => void }) {
  const [report, setReport] = useState<GrowthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProductWorkspace["growth"]>(workspace.growth?.objective ? workspace.growth : suggestedGoal);
  useEffect(() => { setDraft(workspace.growth?.objective ? workspace.growth : suggestedGoal); }, [suggestedGoal, workspace.growth]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    apiFetch(`/api/growth?projectId=${encodeURIComponent(workspace.id)}&range=${encodeURIComponent(range)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Growth results could not be read.");
        if (active) setReport(data as GrowthReport);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Growth results could not be read."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range, workspace.id]);
  useEffect(() => {
    const selected = report?.goal.analyticsEvent || "";
    if (!selected || workspace.growth.analyticsEvent) return;
    const baseGrowth = workspace.growth?.objective ? workspace.growth : suggestedGoal;
    onSave({ ...workspace, growth: { ...baseGrowth, analyticsEvent: selected }, updatedAt: new Date().toISOString() });
  }, [onSave, report?.goal.analyticsEvent, suggestedGoal, workspace]);
  const saveGoal = () => {
    const updated = { ...draft, selectedBy: "user" as const, rationale: "Changed by the user after the assistant’s initial selection." };
    onSave({ ...workspace, growth: updated, updatedAt: new Date().toISOString() });
    setEditing(false);
  };
  const changeObjective = (objective: GrowthObjective) => setDraft((current) => ({ ...current, objective, primaryConversion: recommendedConversion(objective, suggestedGoal.primaryConversion), analyticsEvent: "" }));
  const goal = report?.goal || (workspace.growth?.objective ? workspace.growth : suggestedGoal);
  const funnelMax = Math.max(1, ...(report?.funnel || []).map((item) => Number(item.value || 0)));
  return <>
    <section className="op-growth-goal"><div className="op-growth-goal__icon"><Rocket size={21} /></div><div><small>{goal.selectedBy === "assistant" ? "ASSISTANT-SELECTED PROJECT GOAL" : "PROJECT GOAL"}</small><h2>{growthObjectiveLabel(goal.objective)}</h2><p>{goal.rationale}</p><span>Primary conversion: <strong>{primaryConversionLabel(goal.primaryConversion)}</strong>{goal.analyticsEvent ? ` · measured as ${goal.analyticsEvent}` : " · matching website event not detected yet"}{goal.targetValue > 0 ? ` · target ${formatMetric(goal.targetValue)} per ${goal.targetPeriodDays} days` : ""}</span></div><button onClick={() => setEditing((value) => !value)}>{editing ? "Close" : "Change"}</button></section>
    {editing && <section className="op-growth-goal-editor"><label><span>Growth objective</span><select value={draft.objective} onChange={(event) => changeObjective(event.target.value as GrowthObjective)}><option value="visibility">Qualified visibility</option><option value="leads">Qualified leads</option><option value="sales">Sales</option><option value="audience">Audience growth</option><option value="newsletter">Newsletter growth</option></select></label><label><span>Primary conversion</span><select value={draft.primaryConversion} onChange={(event) => setDraft((current) => ({ ...current, primaryConversion: event.target.value as PrimaryConversion, analyticsEvent: "" }))}><option value="contact_form">Contact or enquiry</option><option value="demo_request">Demo request</option><option value="newsletter_signup">Newsletter registration</option><option value="purchase">Purchase</option><option value="reply">Direct reply</option><option value="custom">Another Analytics event</option></select></label><label><span>Analytics event</span><select value={draft.analyticsEvent} onChange={(event) => setDraft((current) => ({ ...current, analyticsEvent: event.target.value }))}><option value="">Let the assistant match it</option>{report?.keyEvents.map((event) => <option key={event.eventName} value={event.eventName}>{event.eventName} · {formatMetric(event.count)}</option>)}</select></label><label><span>Optional target</span><div><input type="number" min="0" value={draft.targetValue || ""} placeholder="No target" onChange={(event) => setDraft((current) => ({ ...current, targetValue: Math.max(0, Number(event.target.value || 0)) }))} /><select value={draft.targetPeriodDays} onChange={(event) => setDraft((current) => ({ ...current, targetPeriodDays: Number(event.target.value) }))}><option value={30}>per 30 days</option><option value={60}>per 60 days</option><option value={90}>per 90 days</option></select></div></label><button onClick={saveGoal}>Save change</button></section>}
    {error && <div className="op-analytics-error"><CircleAlert size={17} />{error}<button onClick={onConnect}>Manage connections</button></div>}
    {loading && !report ? <div className="op-analytics-loading"><LoaderCircle className="spin" size={22} /> Reading live growth signals…</div> : report && <>
      <section className="op-growth-metrics">{report.metrics.map((metric) => <article key={metric.key}><header><small>{metric.label}</small>{metric.key === "visibility" && metric.change == null ? <em className="op-growth-delta neutral">Current period</em> : <GrowthDelta change={metric.change} percent={metric.changePercent} />}</header><strong>{metric.key === "audience" && metric.change != null ? formatSignedMetric(metric.change) : formatMetric(metric.value)}</strong><span>{metric.key === "audience" && metric.change != null ? "net change" : metric.unit}</span><p>{metric.note}</p><footer>{metric.source}</footer></article>)}</section>
      <section className="op-growth-grid"><article className="op-growth-funnel"><header><small>OUTCOME PATH</small><h2>From visibility to business action</h2></header><div>{report.funnel.map((step, index) => <span key={step.key}><i>{String(index + 1).padStart(2, "0")}</i><div><strong>{step.label}</strong><small>{step.source}</small></div><b>{formatMetric(step.value)}</b><em style={{ width: `${Math.max(3, (Number(step.value || 0) / funnelMax) * 100)}%` }} /></span>)}</div><footer>{report.tracking.note}</footer></article><article className="op-growth-actions"><header><small>AGENT RESPONSE</small><h2>What the evidence changes</h2></header><div>{report.recommendations.map((item, index) => <section className={item.level} key={`${item.title}-${index}`}><span>{item.level === "positive" ? <Check size={15} /> : <CircleAlert size={15} />}</span><div><strong>{item.title}</strong><p>{item.detail}</p><small>{item.action}</small></div></section>)}</div></article></section>
      <section className="op-growth-channels"><header><div><small>CHANNEL CONTRIBUTION</small><h2>Which channels move the objective</h2></div><span>Only provider-returned and attributed values</span></header><div className="op-growth-channels__head"><span>Channel</span><span>Visibility</span><span>Audience +/-</span><span>Website visits</span><span>{primaryConversionLabel(goal.primaryConversion)}</span></div>{report.channels.length ? report.channels.map((channel) => <div key={channel.provider}><strong>{channel.label}</strong><span>{formatMetric(channel.visibility)}</span><span className={deltaClass(channel.audienceChange)}>{formatSignedMetric(channel.audienceChange)}</span><span>{formatMetric(channel.visits)}</span><span>{formatMetric(channel.leads)}</span></div>) : <p>No social or community account is connected for this project.</p>}</section>
      {report.campaigns.length > 0 && <section className="op-growth-campaigns"><header><div><small>CONFIRMED ATTRIBUTION</small><h2>Campaigns producing website activity</h2></div></header><div className="op-growth-campaigns__head"><span>Campaign</span><span>Source</span><span>Visits</span><span>{primaryConversionLabel(goal.primaryConversion)}</span></div>{report.campaigns.map((campaign, index) => <div key={`${campaign.id}-${campaign.source}-${index}`}><strong>{campaign.name}</strong><span>{campaign.source} / {campaign.medium}</span><span>{formatMetric(campaign.sessions)}</span><span>{formatMetric(campaign.leads)}</span></div>)}</section>}
    </>}
  </>;
}

function GrowthDelta({ change, percent }: { change: number | null; percent: number | null }) {
  if (change == null) return <em className="op-growth-delta neutral">Baseline pending</em>;
  return <em className={`op-growth-delta ${deltaClass(change)}`}>{change > 0 ? "+" : ""}{formatMetric(change)}{percent == null ? "" : ` · ${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`}</em>;
}

function inferProjectGrowthPlan(workspace: ProductWorkspace): ProductWorkspace["growth"] {
  if (workspace.growth?.objective && workspace.growth?.primaryConversion) return workspace.growth;
  const context = [workspace.name, workspace.description, workspace.segmentation, workspace.positioning, workspace.audience, workspace.valueProposition, workspace.manifesto, workspace.website].join(" ").toLowerCase();
  if (/\b(shop|store|e-?commerce|retail|product sales|checkout|buy|purchase|merch)\b/.test(context)) return growthPlan("sales", "purchase", "The project sells products, so completed purchases are the clearest primary outcome.");
  if (/\b(newsletter|publication|editorial|subscriber|mailing list|membership)\b/.test(context)) return growthPlan("newsletter", "newsletter_signup", "The project depends on an owned audience, so confirmed registrations are the strongest primary outcome.");
  if (/\b(demo|saas|software|platform|app\b|pilot|book a demo|request a demo)\b/.test(context)) return growthPlan("leads", "demo_request", "The offer requires evaluation before purchase, so qualified demo requests are the strongest primary outcome.");
  if (/\b(agency|studio|consult|service|production|creative director|b2b|business-to-business|venue|operator|client brief)\b/.test(context)) return growthPlan("leads", "contact_form", "The project sells a considered service, so qualified enquiries are more meaningful than raw engagement.");
  if (/\b(community|creator|artist|influencer|audience growth|followers|awareness)\b/.test(context)) return growthPlan("audience", "newsletter_signup", "The project depends on building a repeat audience, with an owned registration as the most durable conversion.");
  return growthPlan("visibility", "contact_form", "The project is currently best served by increasing qualified visibility, with enquiries as the downstream business action.");
}

function growthPlan(objective: GrowthObjective, primaryConversion: PrimaryConversion, rationale: string): ProductWorkspace["growth"] {
  return { objective, primaryConversion, analyticsEvent: "", selectedBy: "assistant", rationale, targetValue: 0, targetPeriodDays: 30 };
}

function recommendedConversion(objective: GrowthObjective, current: PrimaryConversion | ""): PrimaryConversion {
  if (objective === "sales") return "purchase";
  if (objective === "newsletter" || objective === "audience") return "newsletter_signup";
  if (objective === "leads") return current === "demo_request" ? "demo_request" : "contact_form";
  return "contact_form";
}

function growthObjectiveLabel(value: string) {
  return value === "sales" ? "Generate attributable sales" : value === "newsletter" ? "Grow the owned newsletter audience" : value === "audience" ? "Build a relevant repeat audience" : value === "leads" ? "Generate qualified leads" : "Increase qualified brand visibility";
}

function primaryConversionLabel(value: string) {
  return value === "purchase" ? "Purchases" : value === "newsletter_signup" ? "Registrations" : value === "demo_request" ? "Demo requests" : value === "reply" ? "Replies" : value === "custom" ? "Selected event" : "Enquiries";
}

function deltaClass(value: number | null) { return value == null || value === 0 ? "neutral" : value > 0 ? "positive" : "negative"; }

function formatSignedMetric(value: number | null | undefined) {
  if (value == null) return "—";
  return `${value > 0 ? "+" : ""}${formatMetric(value)}`;
}

function WebsiteAnalyticsPanel({ projectId, connection, range, onConnect }: { projectId: string; connection: ConnectionStatus["analytics"]; range: string; onConnect: () => void }) {
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!connection.canRead) { setReport(null); return; }
    let active = true;
    setLoading(true);
    setError("");
    apiFetch(`/api/analytics?projectId=${encodeURIComponent(projectId)}&range=${encodeURIComponent(range)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Google Analytics could not be read.");
        if (active) setReport(data as AnalyticsReport);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Google Analytics could not be read."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [connection.canRead, projectId, range]);
  if (!connection.canRead) return <div className="op-analytics-empty"><span><ChartColumn size={24} /></span><h2>{connection.authorized ? "Choose the website property" : "Connect Google Analytics"}</h2><p>{connection.authorized ? "The Google account is authorized, but this project still needs a property." : "Authorize the Google account that can read this project’s website property."}</p><button onClick={onConnect}>{connection.authorized ? "Choose property" : "Open Integrations"} <ArrowRight size={14} /></button></div>;
  const totals = report?.totals || {};
  const metrics = [
    { key: "activeUsers", label: "Visitors", format: "number" },
    { key: "sessions", label: "Visits", format: "number" },
    { key: "engagedSessions", label: "Engaged visits", format: "number" },
    { key: "engagementRate", label: "Engagement rate", format: "percent" },
    { key: "averageSessionDuration", label: "Average visit", format: "duration" },
    { key: "screenPageViewsPerSession", label: "Pages per visit", format: "decimal" },
    { key: "keyEvents", label: "Key actions", format: "number" },
  ];
  const maxSessions = Math.max(1, ...(report?.timeline || []).map((row) => Number(row.sessions || 0)));
  return <>
    <div className="op-analytics-source"><div><strong>{connection.propertyName}</strong><span>Website property {connection.propertyId}</span></div>{report && <small>Updated {new Date(report.fetchedAt).toLocaleString()}</small>}</div>
    {error && <div className="op-analytics-error"><CircleAlert size={17} />{error}<button onClick={onConnect}>Manage connection</button></div>}
    {loading && !report ? <div className="op-analytics-loading"><LoaderCircle className="spin" size={22} /> Reading the live property…</div> : report && <>
      <section className="op-analytics-metrics op-analytics-metrics--journey">{metrics.map((metric) => { const change = report.changes?.[metric.key]; return <article key={metric.key}><small>{metric.label}</small><strong>{formatWebsiteMetric(totals[metric.key], metric.format)}</strong><GrowthDelta change={change?.absolute ?? null} percent={change?.percent ?? null} /></article>; })}</section>
      <section className="op-analytics-chart"><header><div><small>DAILY TRAFFIC</small><h2>Sessions over time</h2></div><span>{loading ? "Refreshing…" : `Updated ${new Date(report.fetchedAt).toLocaleString()}`}</span></header><div className="op-analytics-chart__bars">{report.timeline.map((row, index) => { const label = analyticsDate(String(row.date || "")); const value = Number(row.sessions || 0); return <button type="button" key={`${row.date}-${index}`} style={{ height: `${Math.max(3, (value / maxSessions) * 100)}%` }} aria-label={`${label}: ${formatMetric(value)} sessions`} data-tooltip={`${label} · ${formatMetric(value)} sessions`} />; })}</div><footer><span>{analyticsDate(String(report.timeline[0]?.date || ""))}</span><span>{analyticsDate(String(report.timeline.at(-1)?.date || ""))}</span></footer></section>
      <section className="op-analytics-table op-analytics-table--source"><header><div><small>HOW PEOPLE ARRIVED</small><h2>Traffic sources and campaigns</h2><p>Shows the source that initiated each visit—not a generic channel total.</p></div></header><div className="op-analytics-table__head"><span>Source / medium</span><span>Channel</span><span>Visits</span><span>Engaged</span><span>Average visit</span><span>Key actions</span></div>{report.acquisition?.length ? report.acquisition.map((row, index) => <div key={`${row.sessionSourceMedium}-${row.sessionManualCampaignName}-${index}`}><strong>{cleanAnalyticsLabel(row.sessionSourceMedium, "Direct / none")}<small>{meaningfulAnalyticsLabel(row.sessionManualCampaignName) ? String(row.sessionManualCampaignName) : "No campaign name"}</small></strong><span>{cleanAnalyticsLabel(row.sessionPrimaryChannelGroup, "Unassigned")}</span><span>{formatMetric(row.sessions)}</span><span>{formatMetric(row.engagedSessions)} · {formatPercent(Number(row.engagementRate || 0))}</span><span>{formatDuration(Number(row.averageSessionDuration || 0))}</span><span>{formatMetric(row.keyEvents)}</span></div>) : <p>No source details were returned for this period.</p>}</section>
      <section className="op-analytics-table op-analytics-table--landing"><header><div><small>WHERE THE VISIT STARTED</small><h2>Landing pages</h2><p>The first page visitors saw, with the quality of the visit that followed.</p></div></header><div className="op-analytics-table__head"><span>Landing page</span><span>Visits</span><span>Engaged</span><span>Engagement</span><span>Average visit</span><span>Key actions</span></div>{report.landingPages?.length ? report.landingPages.map((row, index) => <div key={`${row.landingPagePlusQueryString}-${index}`}><strong>{cleanAnalyticsPath(row.landingPagePlusQueryString)}</strong><span>{formatMetric(row.sessions)}</span><span>{formatMetric(row.engagedSessions)}</span><span>{formatPercent(Number(row.engagementRate || 0))}</span><span>{formatDuration(Number(row.averageSessionDuration || 0))}</span><span>{formatMetric(row.keyEvents)}</span></div>) : <p>No landing-page details were returned for this period.</p>}</section>
      <section className="op-analytics-table op-analytics-table--pages"><header><div><small>WHAT PEOPLE VIEWED</small><h2>Pages and attention</h2><p>Page views, average active attention, deep scrolls, and important actions by page.</p></div></header><div className="op-analytics-table__head"><span>Page</span><span>Views</span><span>Visitors</span><span>Avg. attention</span><span>90% scrolls</span><span>Key actions</span></div>{report.pages?.length ? report.pages.map((row, index) => <div key={`${row.pagePathPlusQueryString}-${index}`}><strong>{cleanAnalyticsPath(row.pagePathPlusQueryString)}<small>{cleanAnalyticsLabel(row.pageTitle, "Untitled page")}</small></strong><span>{formatMetric(row.screenPageViews)}</span><span>{formatMetric(row.activeUsers)}</span><span>{formatDuration(Number(row.userEngagementDuration || 0) / Math.max(1, Number(row.activeUsers || 0)))}</span><span>{formatMetric(row.scrolledUsers)}</span><span>{formatMetric(row.keyEvents)}</span></div>) : <p>No page-level engagement was returned for this period.</p>}</section>
      <section className="op-website-actions"><header><div><small>CONTENT AND DESTINATIONS</small><h2>What visitors opened, watched, and clicked</h2><p>These rows appear only when the website records the corresponding event.</p></div></header><div>
        <WebsiteActionList icon={<FileText size={17} />} title="Downloaded or opened assets" empty="No file-download event was recorded. Enable Enhanced Measurement and link to the asset file directly." rows={(report.downloads || []).map((row) => ({ title: cleanAnalyticsLabel(row.linkText || row.fileName, "Unnamed asset"), detail: cleanAnalyticsLabel(row.linkUrl || row.fileName, "URL unavailable"), count: Number(row.eventCount || 0), people: Number(row.activeUsers || 0) }))} />
        <WebsiteActionList icon={<Video size={17} />} title="Videos watched" empty="No supported embedded-video event was recorded for this period." rows={(report.videos || []).map((row) => ({ title: cleanAnalyticsLabel(row.videoTitle, "Untitled video"), detail: `${humanizeMetric(String(row.eventName || "video activity"))}${meaningfulAnalyticsLabel(row.videoUrl) ? ` · ${row.videoUrl}` : ""}`, count: Number(row.eventCount || 0), people: Number(row.activeUsers || 0) }))} />
        <WebsiteActionList icon={<Link2 size={17} />} title="Where visitors went outside the site" empty="No outbound click was recorded. Enhanced Measurement must be enabled for outbound links." rows={(report.outboundLinks || []).map((row) => ({ title: cleanAnalyticsLabel(row.linkText || row.linkDomain, "External destination"), detail: cleanAnalyticsLabel(row.linkUrl, "URL unavailable"), count: Number(row.eventCount || 0), people: Number(row.activeUsers || 0) }))} />
      </div></section>
      <section className="op-analytics-table op-analytics-table--transitions"><header><div><small>OBSERVED INTERNAL MOVEMENT</small><h2>Pages visitors continued to</h2><p>Built only from recorded same-domain referrer → page-view pairs. It is not presented as a complete session replay.</p></div></header><div className="op-analytics-table__head"><span>Previous page</span><span>Next page</span><span>Views / visitors</span></div>{report.transitions?.length ? report.transitions.map((row, index) => <div key={`${row.pageReferrer}-${row.pageLocation}-${index}`}><strong>{analyticsUrlPath(row.pageReferrer)}</strong><span>{analyticsUrlPath(row.pageLocation)}</span><span>{formatMetric(row.screenPageViews)} / {formatMetric(row.activeUsers)}</span></div>) : <p>No reliable internal page transition was recorded for this period.</p>}</section>
    </>}
  </>;
}

function WebsiteActionList({ icon, title, empty, rows }: { icon: ReactNode; title: string; empty: string; rows: Array<{ title: string; detail: string; count: number; people: number }> }) {
  return <article><header><span>{icon}</span><h3>{title}</h3></header>{rows.length ? <div>{rows.slice(0, 12).map((row, index) => <span key={`${row.title}-${row.detail}-${index}`}><strong>{row.title}</strong><small title={row.detail}>{row.detail}</small><b>{formatMetric(row.count)} <em>events</em>{row.people ? ` · ${formatMetric(row.people)} people` : ""}</b></span>)}</div> : <p>{empty}</p>}</article>;
}

function formatWebsiteMetric(value: string | number | null | undefined, format: string) {
  const numeric = Number(value || 0);
  if (value === null || value === undefined || value === "") return "—";
  if (format === "percent") return formatPercent(numeric);
  if (format === "duration") return formatDuration(numeric);
  if (format === "decimal") return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(numeric);
  return formatMetric(numeric);
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function meaningfulAnalyticsLabel(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  return Boolean(normalized && !["(not set)", "(none)", "(direct)", "(not provided)"].includes(normalized));
}

function cleanAnalyticsLabel(value: unknown, fallback: string) {
  return meaningfulAnalyticsLabel(value) ? String(value) : fallback;
}

function cleanAnalyticsPath(value: unknown) {
  const label = cleanAnalyticsLabel(value, "/");
  return label.length > 110 ? `${label.slice(0, 107)}…` : label;
}

function analyticsUrlPath(value: unknown) {
  try {
    const url = new URL(String(value || ""));
    return `${url.pathname}${url.search}` || "/";
  } catch { return cleanAnalyticsPath(value); }
}

function SocialAnalyticsPanel({ projectId, provider, connection, range, onConnect }: { projectId: string; provider: SocialAnalyticsReport["provider"]; connection: ConnectionStatus[SocialAnalyticsReport["provider"]]; range: string; onConnect: () => void }) {
  const [report, setReport] = useState<SocialAnalyticsReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    apiFetch(`/api/channel-analytics?projectId=${encodeURIComponent(projectId)}&provider=${encodeURIComponent(provider)}&range=${encodeURIComponent(range)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `${provider} analytics could not be read.`);
        if (active) setReport(data as SocialAnalyticsReport);
      })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : "Channel analytics could not be read."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, provider, range, connection.connected]);
  if (loading && !report) return <div className="op-analytics-loading"><LoaderCircle className="spin" size={22} /> Reading {provider} statistics…</div>;
  if (error) return <div className="op-analytics-error"><CircleAlert size={17} />{error}<button onClick={onConnect}>Manage connection</button></div>;
  if (!report) return null;
  const metricCards = [{ key: "published", label: provider === "instagram" && report.availability === "live" ? "Posts in period" : "Published" }, ...report.metrics].slice(0, 7);
  const accountEntries = Object.entries(report.account).filter(([, value]) => value !== "" && value != null);
  const chartMetric = ["views", "reach", "likes", "reactions", "comments", "shares", "saves"].map((key) => report.metrics.find((metric) => metric.key === key)).find(Boolean);
  const chartPosts = chartMetric ? report.posts.filter((post) => post.metrics?.[chartMetric.key] != null).slice(0, 24).reverse() : [];
  const chartMax = Math.max(1, ...chartPosts.map((post) => Number(post.metrics[chartMetric?.key || ""] || 0)));
  return <>
    <section className={`op-channel-status op-channel-status--${report.availability}`}><div><span>{report.availability === "live" ? <Check size={16} /> : <CircleAlert size={16} />}</span><div><strong>{report.accountLabel || report.label}</strong><p>{report.note}</p></div></div><aside><small>{loading ? "Refreshing…" : `Updated ${new Date(report.fetchedAt).toLocaleString()}`}</small>{report.requiredAction && <button onClick={onConnect}>Open Integrations</button>}</aside></section>
    <section className="op-analytics-metrics op-analytics-metrics--social">{metricCards.map((metric) => <article key={metric.key}><small>{metric.label}</small><strong>{formatMetric(report.totals[metric.key])}</strong></article>)}</section>
    {chartMetric && chartPosts.length > 0 && <section className="op-analytics-chart op-analytics-chart--social"><header><div><small>LIVE PROVIDER DATA</small><h2>{chartMetric.label} by publication</h2></div><span>Hover a column for the exact value</span></header><div className="op-analytics-chart__bars">{chartPosts.map((post) => { const value = Number(post.metrics[chartMetric.key]); const date = new Date(post.publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }); return <button type="button" key={post.id} style={{ height: `${Math.max(3, (value / chartMax) * 100)}%` }} aria-label={`${date}: ${formatMetric(value)} ${chartMetric.label.toLowerCase()}`} data-tooltip={`${date} · ${formatMetric(value)} ${chartMetric.label.toLowerCase()}`} />; })}</div><footer><span>{new Date(chartPosts[0].publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span><span>{new Date(chartPosts.at(-1)!.publishedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></footer></section>}
    {accountEntries.length > 0 && <section className="op-channel-account"><header><div><small>ACCOUNT SNAPSHOT</small><h2>{report.label}</h2></div>{report.comparison && <span>{report.comparison.label}</span>}</header><div>{accountEntries.map(([key, value]) => { const change = report.comparison?.metrics?.[key]; return <article key={key}><small>{humanizeMetric(key)}</small><strong>{typeof value === "number" ? formatMetric(value) : String(value)}</strong>{typeof value === "number" && <GrowthDelta change={change?.absolute ?? null} percent={change?.percent ?? null} />}</article>; })}</div></section>}
    <section className="op-channel-posts"><header><div><small>{provider === "instagram" && report.availability === "live" ? "LIVE INSTAGRAM CONTENT" : "PUBLISHED CONTENT"}</small><h2>Content performance</h2></div><span>{report.posts.length} in this period</span></header>{report.posts.length ? <div className="op-channel-posts__scroll"><table><thead><tr><th>Content</th><th>Published</th><th>Source</th>{report.metrics.map((metric) => <th key={metric.key}>{metric.label}</th>)}</tr></thead><tbody>{report.posts.map((post) => <tr key={post.id}><td>{post.url ? <a href={post.url} target="_blank" rel="noreferrer">{post.title}</a> : <strong>{post.title}</strong>}</td><td>{new Date(post.publishedAt).toLocaleDateString()}</td><td><span className={`status status--${post.status}`}>{analyticsStatusLabel(post.status)}</span></td>{report.metrics.map((metric) => <td key={metric.key}>{formatMetric(post.metrics?.[metric.key])}</td>)}</tr>)}</tbody></table></div> : <div className="op-analytics-empty op-analytics-empty--inline"><span><ChartColumn size={22} /></span><h2>No {report.label} publication in this period</h2><p>{report.connected ? `The connected ${report.label} account returned no content for this reporting window.` : `Connect ${report.label} to read provider data.`}</p>{!report.connected && <button onClick={onConnect}>Connect {report.label}</button>}</div>}</section>
  </>;
}

function humanizeMetric(value: string) {
  return value.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function formatMetric(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return "—";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(numeric) : "—";
}

function analyticsStatusLabel(value: string) {
  if (value === "live") return "Instagram account";
  if (value === "complete") return "Market Agent";
  if (value === "submitted") return "Processing";
  return humanizeMetric(value);
}

function analyticsDate(value: string) {
  if (!/^\d{8}$/.test(value)) return "";
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function CampaignWorkspace({ workspace, runs, connections, onSaveWorkspace, onOpen, onStart, onConnect, onGrowth, notify }: { workspace: ProductWorkspace; runs: AgentRun[]; connections: ConnectionStatus; onSaveWorkspace: (workspace: ProductWorkspace) => void; onOpen: (id: string) => void; onStart: () => void; onConnect: () => void; onGrowth: () => void; notify: (message: string) => void }) {
  const projectId = workspace.id;
  const campaignGoal = inferProjectGrowthPlan(workspace);
  const mailchimp = connections.mailchimp;
  const [section, setSection] = useState<CampaignWorkspaceSection>("overview");
  const [deliveryJobs, setDeliveryJobs] = useState<DeliveryJob[]>([]);
  const [dashboard, setDashboard] = useState<NewsletterDashboard | null>(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState("");
  const [direction, setDirection] = useState("");
  const [optinDirection, setOptinDirection] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [scheduleTime, setScheduleTime] = useState(() => nextQuarterLocal());
  const [subscriberOpen, setSubscriberOpen] = useState(false);
  const [subscriber, setSubscriber] = useState({ email: "", firstName: "", lastName: "", consentConfirmed: false });
  const [contactDetails, setContactDetails] = useState<Record<string, { total: number; contacts: Array<{ email: string; firstName: string; lastName: string; company: string; consent: "confirmed" | "unknown" | "denied" }>; loading?: boolean; search?: string }>>({});
  const [subscriberDetails, setSubscriberDetails] = useState<{ total: number; subscribers: NewsletterSubscriber[]; loading?: boolean; search?: string; status?: string } | null>(null);
  const selected = dashboard?.drafts.find((item) => item.id === selectedId) || dashboard?.drafts[0] || null;

  const refreshDeliveryJobs = async () => {
    try {
      const response = await apiFetch(`/api/delivery?projectId=${encodeURIComponent(projectId)}`);
      const data = await response.json();
      if (response.ok) setDeliveryJobs(Array.isArray(data.jobs) ? data.jobs : []);
    } catch { /* Campaign records still remain available when delivery status is temporarily unavailable. */ }
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const response = await apiFetch(`/api/newsletters?projectId=${encodeURIComponent(projectId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Newsletter data could not be read.");
      setDashboard(data as NewsletterDashboard);
      setSelectedId((current) => current || data.drafts?.[0]?.id || "");
    } catch (error) { notify(error instanceof Error ? error.message : "Newsletter data could not be read."); }
    finally { setLoading(false); }
  };

  useEffect(() => {
    setDashboard(null);
    setSelectedId("");
    const requestedSection = window.sessionStorage.getItem(`market-agent:campaign-section:${projectId}`) as CampaignWorkspaceSection | null;
    window.sessionStorage.removeItem(`market-agent:campaign-section:${projectId}`);
    setSection(requestedSection === "newsletter" ? "newsletter" : "overview");
    setContactDetails({});
    setSubscriberDetails(null);
    void refresh();
    void refreshDeliveryJobs();
    const handleUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!detail?.projectId || detail.projectId === projectId) void refresh();
    };
    window.addEventListener("market-agent-newsletter-updated", handleUpdate);
    const handleDeliveryUpdate = () => { void refreshDeliveryJobs(); };
    window.addEventListener("market-agent-delivery-updated", handleDeliveryUpdate);
    const deliveryPoll = window.setInterval(() => void refreshDeliveryJobs(), 60_000);
    return () => {
      window.clearInterval(deliveryPoll);
      window.removeEventListener("market-agent-newsletter-updated", handleUpdate);
      window.removeEventListener("market-agent-delivery-updated", handleDeliveryUpdate);
    };
  }, [projectId, mailchimp.canManage]);

  const createDraft = async () => {
    setWorking("create");
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action: "create-draft", projectId, direction }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The newsletter could not be created.");
      setDashboard((current) => current ? { ...current, drafts: [data.draft as NewsletterDraft, ...current.drafts] } : current);
      setSelectedId(data.draft.id);
      setDirection("");
      notify("Newsletter created as a draft. Nothing has been sent.");
    } catch (error) { notify(error instanceof Error ? error.message : "The newsletter could not be created."); }
    finally { setWorking(""); }
  };

  const createOptin = async () => {
    if (!mailchimp.canManage) {
      notify("Connect Mailchimp and choose this project's audience before publishing an opt-in page.");
      onConnect();
      return;
    }
    if (!window.confirm("Approve and publish a public signup page connected to this project's Mailchimp audience? The staged prospect list will not be emailed or imported.")) return;
    setWorking("create-optin");
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action: "create-optin-campaign", projectId, direction: optinDirection, approvalConfirmed: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The opt-in campaign could not be created.");
      setDashboard((current) => current ? { ...current, conversionCampaigns: [data.campaign as ProspectConversionCampaign, ...(current.conversionCampaigns || [])] } : current);
      setOptinDirection("");
      notify("Public opt-in page published. The prospect list remains uncontacted.");
    } catch (error) { notify(error instanceof Error ? error.message : "The opt-in campaign could not be created."); }
    finally { setWorking(""); }
  };

  const updateOptin = async (campaign: ProspectConversionCampaign, changes: Partial<ProspectConversionCampaign>) => {
    setWorking(`optin-${campaign.id}`);
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action: "update-optin-campaign", projectId, id: campaign.id, ...changes, approvalConfirmed: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The opt-in campaign could not be updated.");
      setDashboard((current) => current ? { ...current, conversionCampaigns: (current.conversionCampaigns || []).map((item) => item.id === campaign.id ? data.campaign as ProspectConversionCampaign : item) } : current);
      notify(data.campaign.status === "paused" ? "Signup page paused." : "Public signup page updated.");
    } catch (error) { notify(error instanceof Error ? error.message : "The opt-in campaign could not be updated."); }
    finally { setWorking(""); }
  };

  const updateDraft = async (draft: NewsletterDraft, changes: Partial<NewsletterDraft["content"]>) => {
    setWorking(`save-${draft.id}`);
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action: "update-draft", projectId, id: draft.id, changes }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The newsletter changes could not be saved.");
      replaceNewsletterDraft(setDashboard, data.draft as NewsletterDraft);
      notify("Newsletter changes saved.");
    } catch (error) { notify(error instanceof Error ? error.message : "The newsletter changes could not be saved."); }
    finally { setWorking(""); }
  };

  const deliver = async (draft: NewsletterDraft, action: "send" | "schedule") => {
    if (!mailchimp.canManage) {
      notify("The campaign is saved in Market Agent. Connect a newsletter delivery service before sending or scheduling it.");
      onConnect();
      return;
    }
    const description = action === "send" ? `send “${draft.content.subject}” now to ${dashboard?.audience.memberCount || 0} audience members` : `schedule “${draft.content.subject}” for ${new Date(scheduleTime).toLocaleString()}`;
    if (!window.confirm(`Approve and ${description}? This is a real Mailchimp delivery action.`)) return;
    setWorking(`${action}-${draft.id}`);
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action, projectId, id: draft.id, scheduleTime: action === "schedule" ? new Date(scheduleTime).toISOString() : undefined }) });
      const data = await response.json();
      if (!response.ok) {
        if (data.draft) replaceNewsletterDraft(setDashboard, data.draft as NewsletterDraft);
        throw new Error(data.error || "Mailchimp could not complete the delivery.");
      }
      replaceNewsletterDraft(setDashboard, data.draft as NewsletterDraft);
      notify(action === "send" ? "Mailchimp accepted the approved newsletter for sending." : "Newsletter scheduled in Mailchimp.");
      window.setTimeout(() => void refresh(), 1200);
    } catch (error) { notify(error instanceof Error ? error.message : "Mailchimp could not complete the delivery."); }
    finally { setWorking(""); }
  };

  const register = async () => {
    setWorking("subscriber");
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action: "register-subscriber", projectId, ...subscriber }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The subscriber could not be registered.");
      notify(data.message || "Subscriber registered.");
      setSubscriber({ email: "", firstName: "", lastName: "", consentConfirmed: false });
      setSubscriberOpen(false);
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "The subscriber could not be registered."); }
    finally { setWorking(""); }
  };

  const importContacts = async (contactImport: ContactImport, mode: "confirmed") => {
    if (!mailchimp.canManage) {
      notify("The contact list is safely staged in Market Agent. Connect a delivery service before importing it to an audience.");
      onConnect();
      return;
    }
    const count = contactImport.consentedCount;
    const description = `Import ${count} contact${count === 1 ? "" : "s"} marked with confirmed permission to ${mailchimp.audienceName}?`;
    if (!window.confirm(description)) return;
    setWorking(`import-${contactImport.id}-${mode}`);
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action: "import-contact-list", projectId, id: contactImport.id, mode, approvalConfirmed: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The contact list could not be imported.");
      notify(data.message || "Contact import completed.");
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : "The contact list could not be imported."); }
    finally { setWorking(""); }
  };

  const loadContactDetails = async (contactImport: ContactImport, search = "", append = false) => {
    if (search === "__close__") {
      setContactDetails((current) => { const next = { ...current }; delete next[contactImport.id]; return next; });
      return;
    }
    const existing = contactDetails[contactImport.id];
    const offset = append && existing?.search === search ? existing.contacts.length : 0;
    setContactDetails((current) => ({ ...current, [contactImport.id]: { total: current[contactImport.id]?.total || 0, contacts: current[contactImport.id]?.contacts || [], search, loading: true } }));
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action: "contact-import-details", projectId, id: contactImport.id, search, offset, limit: 100 }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The complete contact list could not be opened.");
      setContactDetails((current) => ({ ...current, [contactImport.id]: { total: Number(data.total || 0), contacts: append ? [...(current[contactImport.id]?.contacts || []), ...(Array.isArray(data.contacts) ? data.contacts : [])] : Array.isArray(data.contacts) ? data.contacts : [], search, loading: false } }));
    } catch (error) {
      setContactDetails((current) => ({ ...current, [contactImport.id]: { ...(current[contactImport.id] || { total: 0, contacts: [] }), loading: false } }));
      notify(error instanceof Error ? error.message : "The complete contact list could not be opened.");
    }
  };

  const loadSubscribers = async (search = "", status = "", append = false) => {
    const offset = append && subscriberDetails?.search === search && subscriberDetails?.status === status ? subscriberDetails.subscribers.length : 0;
    setSubscriberDetails((current) => ({ total: current?.total || dashboard?.subscriberRegistry.counts.total || 0, subscribers: current?.subscribers || [], search, status, loading: true }));
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action: "subscriber-details", projectId, search, status, offset, limit: 100 }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Subscribers could not be opened.");
      setSubscriberDetails((current) => ({ total: Number(data.total || 0), subscribers: append ? [...(current?.subscribers || []), ...(Array.isArray(data.subscribers) ? data.subscribers : [])] : Array.isArray(data.subscribers) ? data.subscribers : [], search, status, loading: false }));
    } catch (error) {
      setSubscriberDetails((current) => current ? { ...current, loading: false } : null);
      notify(error instanceof Error ? error.message : "Subscribers could not be opened.");
    }
  };

  const saveWelcome = async (settings: NewsletterDashboard["welcome"]) => {
    const action = settings.enabled ? "enable the welcome email for future confirmed subscribers" : "disable the automatic welcome email";
    if (!window.confirm(`Approve and ${action}? Existing subscribers will not receive a new welcome.`)) return;
    setWorking("welcome");
    try {
      const response = await apiFetch("/api/newsletters", { method: "POST", body: JSON.stringify({ action: "update-welcome-settings", projectId, enabled: settings.enabled, subject: settings.subject, body: settings.body, approvalConfirmed: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The welcome automation could not be saved.");
      setDashboard((current) => current ? { ...current, welcome: data.welcome } : current);
      notify(settings.enabled ? "Welcome automation enabled for future confirmations." : "Welcome automation disabled.");
    } catch (error) { notify(error instanceof Error ? error.message : "The welcome automation could not be saved."); }
    finally { setWorking(""); }
  };

  const campaignTabs: Array<{ id: CampaignWorkspaceSection; label: string; count: number }> = [
    { id: "overview", label: "Overview", count: runs.filter((run) => campaignRunIsActive(run, deliveryJobs)).length + (dashboard?.drafts.filter((draft) => draft.status !== "sent").length || 0) },
    { id: "newsletter", label: "Newsletter", count: (dashboard?.drafts.length || 0) + (dashboard?.contactImports.length || 0) },
    ...(["linkedin", "instagram", "tiktok", "youtube", "x", "discord", "reddit"] as const).map((channel) => ({ id: channel, label: deliveryChannelLabel(channel), count: deliveryJobs.filter((job) => job.channel === channel && deliveryJobIsActive(job)).length })),
  ];

  return <div className="op-stack op-campaign-workspace">
    <div className="op-heading"><div className="op-eyebrow">Campaign creation and delivery</div><h1>Campaigns</h1><p>Market Agent creates the work here. Connected delivery services handle transport, compliance, and verified performance data.</p></div>
    <section className="op-campaign-goal"><span><Rocket size={17} /></span><div><small>{campaignGoal.selectedBy === "assistant" ? "ASSISTANT-SELECTED OUTCOME" : "PROJECT OUTCOME"}</small><strong>{growthObjectiveLabel(campaignGoal.objective)}</strong><p>Each campaign should move toward <b>{primaryConversionLabel(campaignGoal.primaryConversion).toLowerCase()}</b>, not activity for its own sake.</p></div><button onClick={onGrowth}>Review in Growth <ArrowRight size={12} /></button></section>
    <nav className="op-campaign-tabs" aria-label="Campaign channels">{campaignTabs.map((tab) => <button key={tab.id} className={section === tab.id ? "active" : ""} onClick={() => setSection(tab.id)}><span>{tab.label}</span>{tab.count > 0 && <em>{tab.count}</em>}</button>)}</nav>
    {section === "overview" && <CampaignOverview runs={runs} jobs={deliveryJobs} newsletters={dashboard?.drafts || []} onOpen={onOpen} onOpenNewsletter={() => setSection("newsletter")} onStart={onStart} />}
    {section === "newsletter" && <>
    {!mailchimp.connected && <section className="op-newsletter-connect"><span><Send size={21} /></span><div><small>OPTIONAL DELIVERY CONNECTION</small><h2>Campaign work stays in Market Agent</h2><p>Create the contacts, newsletter, schedule, and approval here. Connect Mailchimp only when you are ready to import subscribers and deliver; another bulk-email provider can be added later.</p></div><button onClick={onConnect}>Connect Mailchimp <ArrowRight size={14} /></button></section>}
    {mailchimp.connected && !mailchimp.canManage && <section className="op-newsletter-connect"><span><UsersRound size={21} /></span><div><small>DELIVERY CONNECTED</small><h2>Choose this project’s audience</h2><p>{mailchimp.accountLabel} is authorized. Select the audience once; campaign creation and review remain in Market Agent.</p></div><button onClick={onConnect}>Choose audience <ArrowRight size={14} /></button></section>}
      <EmailIdentityCard workspace={workspace} onSave={(emailIdentity) => { onSaveWorkspace({ ...workspace, emailIdentity, updatedAt: new Date().toISOString() }); notify("Email identity saved for this project."); window.setTimeout(() => void refresh(), 900); }} />
      <section className="op-newsletter-studio">
        <header><div><small>NEWSLETTER AGENT</small><h2>Create the complete campaign</h2><p>Give a goal or topic. The agent writes and designs the email from the saved Brand. A delivery service is needed only for the final send.</p></div><span>{mailchimp.canManage ? mailchimp.audienceName : "Market Agent draft"}</span></header>
        <div className="op-newsletter-command"><textarea value={direction} onChange={(event) => setDirection(event.target.value)} placeholder="Example: Send a useful monthly update about our newest work and invite readers to book a call." /><button onClick={() => void createDraft()} disabled={working === "create"}><Sparkles size={15} />{working === "create" ? "Creating…" : "Create newsletter"}</button></div>
      </section>

      {loading && !dashboard ? <div className="op-analytics-loading"><LoaderCircle className="spin" size={22} /> Reading campaign contacts and newsletters…</div> : dashboard && <>
        <section className="op-newsletter-drafts op-newsletter-preview-section"><div className="op-section-title"><div><small>EMAIL PREVIEW</small><h2>Newsletter preview and editor</h2><p>See the selected newsletter exactly as recipients will receive it. Edit the complete email, choose any saved Brand logo, then approve delivery only when it is ready.</p></div></div>{dashboard.drafts.length ? <div className="op-newsletter-draft-layout"><aside>{dashboard.drafts.map((draft) => <button key={draft.id} className={selected?.id === draft.id ? "active" : ""} onClick={() => setSelectedId(draft.id)}><span><strong>{draft.content.subject}</strong><small>{new Date(draft.createdAt).toLocaleString()}</small></span><em className={`status-${draft.status}`}>{newsletterStatus(draft)}</em></button>)}</aside>{selected && <NewsletterReview draft={selected} logoVariants={workspace.brand.logoVariants || []} scheduleTime={scheduleTime} onScheduleTime={setScheduleTime} working={working} onSave={updateDraft} onDeliver={deliver} />}</div> : <div className="op-newsletter-preview-empty"><span><FileText size={24} /></span><div><h3>No newsletter preview yet</h3><p>Describe the campaign above, or let the agent choose the strongest supported topic, then generate the first complete email preview.</p></div><button onClick={() => void createDraft()} disabled={working === "create"}><Sparkles size={14} />{working === "create" ? "Creating preview…" : "Generate preview"}</button></div>}</section>
        <ProspectConversionPanel dashboard={dashboard} direction={optinDirection} onDirection={setOptinDirection} working={working} mailchimpReady={mailchimp.canManage} onCreate={createOptin} onUpdate={updateOptin} onConnect={onConnect} notify={notify} />
        {dashboard.contactImports.length > 0 && <section className="op-contact-imports"><div className="op-section-title"><div><small>CAMPAIGN CONTACTS</small><h2>Contact lists</h2><p>Uploaded contact CSVs live here—not in the Content Library. Open a list to search and review every contact; permission remains explicit.</p></div></div><div>{dashboard.contactImports.map((contactImport) => <ContactImportCard key={contactImport.id} contactImport={contactImport} details={contactDetails[contactImport.id]} working={working} deliveryReady={mailchimp.canManage} onLoad={loadContactDetails} onImport={importContacts} onConnect={onConnect} />)}</div></section>}
        <section className="op-newsletter-metrics">
          <article><small>Audience</small><strong>{dashboard.audience.memberCount.toLocaleString()}</strong><span>subscribers</span></article>
          <article><small>Average opens</small><strong>{formatPercent(dashboard.audience.openRate)}</strong><span>connected audience</span></article>
          <article><small>Average clicks</small><strong>{formatPercent(dashboard.audience.clickRate)}</strong><span>connected audience</span></article>
          <article><small>Unsubscribed</small><strong>{dashboard.audience.unsubscribeCount.toLocaleString()}</strong><span>lifetime</span></article>
          <button onClick={() => mailchimp.canManage ? setSubscriberOpen((open) => !open) : onConnect()}><Plus size={15} />{mailchimp.canManage ? "Register subscriber" : "Connect delivery"}</button>
        </section>

        {subscriberOpen && <section className="op-subscriber-form"><header><div><strong>Register a subscriber</strong><p>New people receive a confirmation email and are not subscribed until they confirm.</p></div><button onClick={() => setSubscriberOpen(false)}><X size={15} /></button></header><div><label><span>Email</span><input type="email" value={subscriber.email} onChange={(event) => setSubscriber((current) => ({ ...current, email: event.target.value }))} /></label><label><span>First name</span><input value={subscriber.firstName} onChange={(event) => setSubscriber((current) => ({ ...current, firstName: event.target.value }))} /></label><label><span>Last name</span><input value={subscriber.lastName} onChange={(event) => setSubscriber((current) => ({ ...current, lastName: event.target.value }))} /></label></div><label className="consent"><input type="checkbox" checked={subscriber.consentConfirmed} onChange={(event) => setSubscriber((current) => ({ ...current, consentConfirmed: event.target.checked }))} /> This person requested the newsletter and may receive a confirmation email.</label><button onClick={() => void register()} disabled={!subscriber.email.trim() || !subscriber.consentConfirmed || working === "subscriber"}>{working === "subscriber" ? "Registering…" : "Send confirmation"}</button></section>}

        <SubscriberRegistry dashboard={dashboard} details={subscriberDetails} working={working} mailbox={connections.gmail} onLoad={loadSubscribers} onSaveWelcome={saveWelcome} onConnect={onConnect} />

        <section className="op-newsletter-results"><div className="op-section-title"><div><small>DELIVERY PERFORMANCE</small><h2>Newsletter performance</h2><p>{mailchimp.canManage ? "Delivered, opens, clicks, bounces, and unsubscribes are read from the connected delivery account." : "Verified delivery statistics will appear after a bulk-email service is connected and the first campaign is sent."}</p></div><button className="secondary" onClick={() => void refresh()} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button></div>{dashboard.campaigns.length ? <div className="op-newsletter-report-list">{dashboard.campaigns.map((campaign) => <article key={campaign.id}><header><div><strong>{campaign.subject || campaign.title}</strong><small>{campaign.sendTime ? new Date(campaign.sendTime).toLocaleString() : campaign.status}</small></div><em>{campaign.status}</em></header><div><span><small>Sent</small><strong>{campaign.emailsSent.toLocaleString()}</strong></span><span><small>Open rate</small><strong>{formatPercent(campaign.openRate)}</strong></span><span><small>Click rate</small><strong>{formatPercent(campaign.clickRate)}</strong></span><span><small>Bounces</small><strong>{campaign.bounces.toLocaleString()}</strong></span><span><small>Unsubscribed</small><strong>{campaign.unsubscribed.toLocaleString()}</strong></span></div>{campaign.archiveUrl && <a href={campaign.archiveUrl} target="_blank" rel="noreferrer">Open newsletter <ArrowRight size={12} /></a>}</article>)}</div> : <div className="op-empty op-empty--compact"><span><ChartColumn size={22} /></span><h2>No sent newsletters yet</h2><p>Verified performance appears here after the first approved campaign is delivered.</p></div>}</section>
      </>}
    </>}
    {section !== "overview" && section !== "newsletter" && <ChannelCampaignWorkspace channel={section} runs={runs} jobs={deliveryJobs} connected={campaignChannelConnected(section, connections)} onOpen={onOpen} onStart={onStart} onConnect={onConnect} />}
  </div>;
}

function EmailIdentityCard({ workspace, onSave }: { workspace: ProductWorkspace; onSave: (identity: ProductWorkspace["emailIdentity"]) => void }) {
  const [identity, setIdentity] = useState<ProductWorkspace["emailIdentity"]>(workspace.emailIdentity || { senderName: "", businessDetails: "", physicalAddress: "", addressPreference: "ask" });
  useEffect(() => setIdentity(workspace.emailIdentity || { senderName: "", businessDetails: "", physicalAddress: "", addressPreference: "ask" }), [workspace.id, workspace.emailIdentity]);
  const missing = [!identity.senderName.trim() ? "sender name" : "", !identity.businessDetails.trim() ? "business/contact details" : "", identity.addressPreference === "ask" ? "address preference" : "", identity.addressPreference === "include" && !identity.physicalAddress.trim() ? "physical address" : ""].filter(Boolean);
  const changed = JSON.stringify(identity) !== JSON.stringify(workspace.emailIdentity || { senderName: "", businessDetails: "", physicalAddress: "", addressPreference: "ask" });
  return <section className={`op-email-identity ${missing.length ? "attention" : "ready"}`}><header><div><small>PROJECT EMAIL IDENTITY</small><h2>Sender and signature</h2><p>The agent uses these details instead of fake placeholders. This identity belongs to {workspace.name || "this project"} only.</p></div><em>{missing.length ? `${missing.length} detail${missing.length === 1 ? "" : "s"} needed` : "Ready"}</em></header><div className="op-email-identity__fields"><label><span>Sender name</span><input value={identity.senderName} onChange={(event) => setIdentity((current) => ({ ...current, senderName: event.target.value }))} placeholder="Example: Riccardo Valsecchi" /></label><label><span>Business/contact details</span><input value={identity.businessDetails} onChange={(event) => setIdentity((current) => ({ ...current, businessDetails: event.target.value }))} placeholder="Example: LUMEN · riccardo@visit-lumen.com" /></label><label><span>Address in editorial signature</span><select value={identity.addressPreference} onChange={(event) => setIdentity((current) => ({ ...current, addressPreference: event.target.value as ProductWorkspace["emailIdentity"]["addressPreference"] }))}><option value="ask">Ask me before use</option><option value="omit">Do not show it</option><option value="include">Show it</option></select></label>{identity.addressPreference === "include" && <label><span>Physical address</span><input value={identity.physicalAddress} onChange={(event) => setIdentity((current) => ({ ...current, physicalAddress: event.target.value }))} placeholder="Business mailing address" /></label>}</div><footer><p>{identity.addressPreference === "omit" ? "The editorial signature will omit the address. Mailchimp still adds the legally required audience address in its compliance footer." : "Bulk-email providers may still require a compliance address in their own footer."}</p><button disabled={!changed} onClick={() => onSave(identity)}><Save size={14} /> Save identity</button></footer></section>;
}

function NewsletterReview({ draft, logoVariants, scheduleTime, onScheduleTime, working, onSave, onDeliver }: { draft: NewsletterDraft; logoVariants: BrandLogoVariant[]; scheduleTime: string; onScheduleTime: (value: string) => void; working: string; onSave: (draft: NewsletterDraft, changes: Partial<NewsletterDraft["content"]>) => Promise<void>; onDeliver: (draft: NewsletterDraft, action: "send" | "schedule") => Promise<void> }) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [subject, setSubject] = useState(draft.content.subject);
  const [previewText, setPreviewText] = useState(draft.content.previewText);
  const [headline, setHeadline] = useState(draft.content.headline);
  const [introduction, setIntroduction] = useState(draft.content.introduction);
  const [sections, setSections] = useState(draft.content.sections);
  const [ctaLabel, setCtaLabel] = useState(draft.content.ctaLabel);
  const [ctaUrl, setCtaUrl] = useState(draft.content.ctaUrl);
  const [closing, setClosing] = useState(draft.content.closing);
  const [heroImageUrl, setHeroImageUrl] = useState(draft.content.heroImageUrl);
  const [heroImageAlt, setHeroImageAlt] = useState(draft.content.heroImageAlt);
  const initialLogoChoice = () => draft.content.logoHidden ? "__none__" : draft.content.logoVariantId || logoVariants.find((variant) => variant.url === draft.content.logoUrl)?.id || "__automatic__";
  const [logoChoice, setLogoChoice] = useState(initialLogoChoice);
  useEffect(() => {
    setSubject(draft.content.subject);
    setPreviewText(draft.content.previewText);
    setHeadline(draft.content.headline);
    setIntroduction(draft.content.introduction);
    setSections(draft.content.sections.map((section) => ({ ...section })));
    setCtaLabel(draft.content.ctaLabel);
    setCtaUrl(draft.content.ctaUrl);
    setClosing(draft.content.closing);
    setHeroImageUrl(draft.content.heroImageUrl);
    setHeroImageAlt(draft.content.heroImageAlt);
    setLogoChoice(initialLogoChoice());
  }, [draft.id, draft.updatedAt]);
  const editable = draft.status === "draft" || draft.status === "failed";
  const selectedLogo = logoVariants.find((variant) => variant.id === logoChoice);
  const changes: Partial<NewsletterDraft["content"]> = {
    subject,
    previewText,
    headline,
    introduction,
    sections,
    ctaLabel,
    ctaUrl,
    closing,
    heroImageUrl,
    heroImageAlt,
    logoHidden: logoChoice === "__none__",
    logoVariantId: selectedLogo?.id || "",
    logoUrl: selectedLogo?.url || "",
  };
  const comparable = (content: Partial<NewsletterDraft["content"]>) => JSON.stringify({ subject: content.subject || "", previewText: content.previewText || "", headline: content.headline || "", introduction: content.introduction || "", sections: content.sections || [], ctaLabel: content.ctaLabel || "", ctaUrl: content.ctaUrl || "", closing: content.closing || "", heroImageUrl: content.heroImageUrl || "", heroImageAlt: content.heroImageAlt || "", logoHidden: Boolean(content.logoHidden), logoVariantId: content.logoVariantId || "", logoUrl: content.logoUrl || "" });
  const changed = comparable(changes) !== comparable(draft.content);
  const blocked = Boolean(draft.content.issues?.length);
  const updateSection = (index: number, field: "heading" | "body", value: string) => setSections((current) => current.map((section, sectionIndex) => sectionIndex === index ? { ...section, [field]: value } : section));
  return <article className="op-newsletter-review">
    <header><div><small>{newsletterStatus(draft)}</small><h3>{draft.content.subject}</h3></div><div className="op-newsletter-review__actions">{draft.error && <span className="error">{draft.error}</span>}{editable && <button onClick={() => setEditorOpen((open) => !open)}>{editorOpen ? <X size={13} /> : <Settings2 size={13} />}{editorOpen ? "Close editor" : "Edit complete email"}</button>}</div></header>
    {blocked && <div className="op-newsletter-issues"><CircleAlert size={16} /><div><strong>Needs information before delivery</strong>{draft.content.issues.map((issue) => <p key={issue}>{issue}</p>)}</div></div>}
    <div className={editorOpen ? "op-newsletter-edit-layout" : ""}>
      {editorOpen && <section className="op-newsletter-manual-editor">
        <header><div><strong>Edit the actual email</strong><small>Every saved change regenerates the recipient preview beside it.</small></div>{changed && <em>Unsaved changes</em>}</header>
        <label><span>Subject</span><input value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
        <label><span>Inbox preview text</span><input value={previewText} onChange={(event) => setPreviewText(event.target.value)} /></label>
        <label><span>Logo</span><select value={logoChoice} onChange={(event) => setLogoChoice(event.target.value)}><option value="__automatic__">Automatic — Email, then Primary</option>{logoVariants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name} · {logoUsageLabel(variant.usage)}</option>)}<option value="__none__">No logo in this email</option></select></label>
        <label><span>Headline</span><input value={headline} onChange={(event) => setHeadline(event.target.value)} /></label>
        <label><span>Introduction</span><textarea value={introduction} onChange={(event) => setIntroduction(event.target.value)} /></label>
        <div className="op-newsletter-section-editor"><div className="op-newsletter-section-editor__head"><strong>Content sections</strong>{sections.length < 4 && <button onClick={() => setSections((current) => [...current, { heading: "", body: "" }])}><Plus size={12} /> Add section</button>}</div>{sections.map((section, index) => <article key={`section-${index}`}><div><span>Section {index + 1}</span><button aria-label={`Remove section ${index + 1}`} onClick={() => setSections((current) => current.filter((_, sectionIndex) => sectionIndex !== index))}><Trash2 size={12} /></button></div><input value={section.heading} onChange={(event) => updateSection(index, "heading", event.target.value)} placeholder="Section heading" /><textarea value={section.body} onChange={(event) => updateSection(index, "body", event.target.value)} placeholder="Section text" /></article>)}</div>
        <div className="op-newsletter-editor-pair"><label><span>Button label</span><input value={ctaLabel} onChange={(event) => setCtaLabel(event.target.value)} /></label><label><span>Button link</span><input value={ctaUrl} onChange={(event) => setCtaUrl(event.target.value)} /></label></div>
        <label><span>Closing</span><textarea value={closing} onChange={(event) => setClosing(event.target.value)} /></label>
        <details><summary>Hero image</summary><label><span>Image URL</span><input value={heroImageUrl} onChange={(event) => setHeroImageUrl(event.target.value)} /></label><label><span>Image description</span><input value={heroImageAlt} onChange={(event) => setHeroImageAlt(event.target.value)} /></label></details>
        <button className="op-newsletter-save-email" disabled={!changed || working === `save-${draft.id}`} onClick={() => void onSave(draft, changes)}>{working === `save-${draft.id}` ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}{working === `save-${draft.id}` ? "Saving…" : "Save & refresh preview"}</button>
      </section>}
      {!editorOpen && <div className="op-newsletter-fields"><label><span>Subject</span><input value={subject} disabled={!editable} onChange={(event) => setSubject(event.target.value)} /></label><label><span>Preview text</span><input value={previewText} disabled={!editable} onChange={(event) => setPreviewText(event.target.value)} /></label><label><span>Primary link</span><input value={ctaUrl} disabled={!editable} onChange={(event) => setCtaUrl(event.target.value)} /></label>{editable && changed && <button onClick={() => void onSave(draft, changes)} disabled={working === `save-${draft.id}`}><Save size={13} />{working === `save-${draft.id}` ? "Saving…" : "Save changes"}</button>}</div>}
      <div className="op-newsletter-preview"><iframe title={`Preview of ${draft.content.subject}`} sandbox="" srcDoc={draft.html} /></div>
    </div>
    {editable && <footer><button onClick={() => void onDeliver(draft, "send")} disabled={Boolean(working) || blocked}>{working === `send-${draft.id}` ? <LoaderCircle className="spin" size={14} /> : <Send size={14} />}{blocked ? "Complete sender details" : "Approve & send now"}</button><div><input type="datetime-local" value={scheduleTime} onChange={(event) => onScheduleTime(event.target.value)} step="900" /><button className="secondary" onClick={() => void onDeliver(draft, "schedule")} disabled={Boolean(working) || blocked}>{working === `schedule-${draft.id}` ? "Scheduling…" : "Approve & schedule"}</button></div></footer>}
  </article>;
}

function logoUsageLabel(usage: BrandLogoVariant["usage"]) {
  return ({ primary: "Primary", email: "Email", light: "Light backgrounds", dark: "Dark backgrounds", icon: "Icon", other: "Other" } as const)[usage];
}

function replaceNewsletterDraft(setDashboard: React.Dispatch<React.SetStateAction<NewsletterDashboard | null>>, draft: NewsletterDraft) {
  setDashboard((current) => current ? { ...current, drafts: current.drafts.map((item) => item.id === draft.id ? draft : item) } : current);
}

function newsletterStatus(draft: NewsletterDraft) {
  if (draft.status === "scheduled" && draft.scheduledFor) return `Scheduled · ${new Date(draft.scheduledFor).toLocaleString()}`;
  return ({ draft: "Draft — not sent", preparing: "Preparing delivery", sent: "Sent", failed: "Needs attention", scheduled: "Scheduled" } as const)[draft.status];
}

function contactImportStatus(contactImport: ContactImport) {
  if (contactImport.status === "imported") return `${contactImport.importedCount} imported`;
  if (contactImport.status === "partial") return `${contactImport.importedCount} imported · ${contactImport.failedCount} failed`;
  if (contactImport.status === "failed") return "Import needs attention";
  if (contactImport.status === "importing") return "Importing";
  return "Staged — no send";
}

function deliveryJobIsActive(job: DeliveryJob) {
  return ["awaiting_approval", "scheduled", "running", "submitted"].includes(job.status);
}

function campaignRunIsActive(run: AgentRun, jobs: DeliveryJob[]) {
  const runJobs = jobs.filter((job) => job.runId === run.id);
  return !runJobs.length || runJobs.some(deliveryJobIsActive);
}

function runMentionsChannel(run: AgentRun, channel: Exclude<CampaignWorkspaceSection, "overview" | "calendar" | "newsletter">) {
  const text = `${run.title} ${run.prompt} ${run.output}`.toLowerCase();
  const patterns: Record<typeof channel, RegExp> = {
    linkedin: /\blinked\s?in\b/,
    instagram: /\binstagram\b|\binsta\b/,
    tiktok: /\btik\s?tok\b/,
    youtube: /\byou\s?tube\b|\bshorts?\b/,
    x: /\b(?:twitter|x\.com)\b|\bon x\b/,
    discord: /\bdiscord\b/,
    reddit: /\breddit\b|\bsubreddit\b/,
  };
  return patterns[channel].test(text);
}

function campaignChannelConnected(channel: Exclude<CampaignWorkspaceSection, "overview" | "calendar" | "newsletter">, connections: ConnectionStatus) {
  return Boolean(connections[channel]?.canPublish);
}

function nextQuarterLocal() {
  const date = new Date(Date.now() + 30 * 60_000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toLocalDateTimeValue(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromLocalDateTimeValue(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function formatPercent(value: number) {
  const normalized = value > 1 ? value : value * 100;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(normalized || 0)}%`;
}

function RunLibrary({ title, description, empty, runs, onOpen, onStart }: { title: string; description: string; empty: string; runs: AgentRun[]; onOpen: (id: string) => void; onStart: () => void }) {
  return <div className="op-stack"><div className="op-heading"><div className="op-eyebrow">Saved workspace records</div><h1>{title}</h1><p>{description}</p></div>{runs.length ? <div className="op-run-list">{runs.map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div> : <div className="op-empty"><span><FileText size={23} /></span><h2>{empty}</h2><p>Run the agent to create the first real record.</p><button onClick={onStart}><Sparkles size={15} /> Open agent</button></div>}</div>;
}

function RunRow({ run, onOpen }: { run: AgentRun; onOpen: (id: string) => void }) {
  return <button className="op-run-row" onClick={() => onOpen(run.id)}><span className={`op-run-icon op-run-icon--${run.action}`}>{run.action === "research" ? <Globe2 size={17} /> : run.action === "audience" ? <UsersRound size={17} /> : run.action === "campaign" ? <Rocket size={17} /> : run.action === "social" ? <MessageSquareText size={17} /> : <Bot size={17} />}</span><div><strong>{run.title}</strong><p>{run.prompt || actionMeta[run.action].description}</p><small>{new Date(run.createdAt).toLocaleString()}</small></div><em className={run.status === "Approved" ? "approved" : ""}>{run.status}</em><ArrowRight size={16} /></button>;
}

type CampaignCreative = {
  day: string;
  format: "carousel" | "reel" | "post" | "story";
  title: string;
  frames: Array<{ label: string; text: string }>;
  caption: string;
  mediaUrl: string;
  mediaKind: "" | "image" | "video";
};

function cleanCreativeText(value: string) {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*]\s+/, "")
    .trim();
}

function extractCampaignCreatives(run: AgentRun): CampaignCreative[] {
  const output = String(run.output || "").replace(/\r/g, "");
  const heading = /^###\s+(Day\s+\d+)\s+[—–-]\s+(Carousel|Reel|Post|Static|Story)\s*(?::\s*(.*))?$/gim;
  const matches = [...output.matchAll(heading)];
  const instagramItems = (run.campaignPlan?.items || []).filter((item) => item.channel === "instagram");
  const creatives = matches.map((match, index) => {
    const start = Number(match.index || 0) + match[0].length;
    const end = Number(matches[index + 1]?.index ?? output.length);
    const block = output.slice(start, end).trim();
    const parts = block.split(/\*\*Caption\*\*/i);
    const visual = parts[0] || "";
    const caption = cleanCreativeText((parts[1] || "").split(/\n###\s+/)[0].trim());
    const formatLabel = String(match[2] || "Post").toLowerCase();
    const format: CampaignCreative["format"] = formatLabel === "static" ? "post" : formatLabel as CampaignCreative["format"];
    const numbered = [...visual.matchAll(/^\s*(\d+)\.\s+(.+)$/gm)].map((item) => ({ label: `Slide ${item[1]}`, text: cleanCreativeText(item[2]) }));
    const timed = [...visual.matchAll(/^\s*-\s+([^:\n]{1,20}):\s+(.+)$/gm)].map((item) => ({ label: cleanCreativeText(item[1]), text: cleanCreativeText(item[2]) }));
    const fallback = [...visual.matchAll(/^\s*-\s+(.+)$/gm)].map((item, frameIndex) => ({ label: `Frame ${frameIndex + 1}`, text: cleanCreativeText(item[1]) }));
    const planItem = instagramItems[index];
    const mediaKind: CampaignCreative["mediaKind"] = planItem?.mediaKind === "video" ? "video" : planItem?.mediaKind === "image" ? "image" : "";
    return {
      day: cleanCreativeText(match[1]),
      format,
      title: cleanCreativeText(match[3] || match[2]),
      frames: numbered.length ? numbered : timed.length ? timed : fallback,
      caption,
      mediaUrl: String(planItem?.mediaUrl || ""),
      mediaKind,
    };
  }).filter((creative) => creative.frames.length > 0);
  const storiesSection = output.match(/^###\s+Stories\s*$([\s\S]*?)(?=^###\s+|^\*\*Inbound|(?![\s\S]))/im)?.[1] || "";
  const storyItems = [...storiesSection.matchAll(/^\s*-\s+\*\*(Day\s+\d+):\*\*\s+(.+)$/gim)];
  storyItems.forEach((item, storyIndex) => {
    const planItem = instagramItems[creatives.length + storyIndex];
    const mediaKind: CampaignCreative["mediaKind"] = planItem?.mediaKind === "video" ? "video" : planItem?.mediaKind === "image" ? "image" : "";
    creatives.push({
      day: cleanCreativeText(item[1]),
      format: "story",
      title: "Instagram Story",
      frames: [{ label: "Story", text: cleanCreativeText(item[2]) }],
      caption: "",
      mediaUrl: String(planItem?.mediaUrl || ""),
      mediaKind,
    });
  });
  return creatives;
}

function safeBrandColor(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : fallback;
}

function CampaignCreativePreview({ run, workspace }: { run: AgentRun; workspace: ProductWorkspace }) {
  const creatives = useMemo(() => extractCampaignCreatives(run), [run]);
  if (!creatives.length) return null;
  const style = {
    "--creative-primary": safeBrandColor(workspace.brand.primaryColor, "#7657d8"),
    "--creative-secondary": safeBrandColor(workspace.brand.secondaryColor, "#f0ecff"),
    "--creative-light": safeBrandColor(workspace.brand.neutralLightColor, "#faf9f6"),
    "--creative-dark": safeBrandColor(workspace.brand.neutralDarkColor, "#1d1d1b"),
  } as CSSProperties;
  return <section className="op-campaign-creative-preview" style={style}>
    <header><div><small>INSTAGRAM CREATIVE</small><h2>See every planned asset</h2><p>These are Instagram-sized visual drafts made from the approved slide and Reel copy. A selected library file appears with the item; otherwise the card is clearly marked as needing final production.</p></div><span>{creatives.length} planned posts</span></header>
    <div className="op-creative-list">{creatives.map((creative, creativeIndex) => <article className={`op-creative-item ${creative.format}`} key={`${creative.day}-${creativeIndex}`}>
      <header><div><span>{creative.day}</span><strong>{creative.title}</strong></div><em>{creative.format === "carousel" ? `${creative.frames.length} slides` : creative.format}</em></header>
      {creative.mediaUrl && <div className={`op-creative-selected-media ${creative.mediaKind || "image"}`}>{creative.mediaKind === "video" ? <video src={creative.mediaUrl} controls preload="metadata" /> : <img src={creative.mediaUrl} alt={`Selected campaign asset for ${creative.title}`} />}<span>Selected Content Library asset</span></div>}
      <div className="op-creative-frames">{creative.frames.map((frame, frameIndex) => <div className="op-creative-frame" key={`${frame.label}-${frameIndex}`}>
        <small>{frame.label}</small><strong>{frame.text}</strong><footer><span>{workspace.name || "Brand"}</span><b>{frameIndex + 1}/{creative.frames.length}</b></footer>
      </div>)}</div>
      <div className={`op-creative-production-state ${creative.mediaUrl ? "ready" : "draft"}`}>{creative.mediaUrl ? <Check size={15} /> : <CircleAlert size={15} />}<span><strong>{creative.mediaUrl ? "Media selected" : "Visual draft — final files not produced"}</strong>{creative.mediaUrl ? "The selected file will be used when the delivery queue is prepared." : "No paid image or video generation has been started. Production still requires an existing library asset or an approved generation budget."}</span></div>
      {creative.caption && <details className="op-creative-caption"><summary>Read caption</summary><p>{creative.caption}</p></details>}
    </article>)}</div>
  </section>;
}

function RunDetail({ run, workspace, connections, onBack, onConnect, onStatus, onOutput, onDelete, notify }: { run: AgentRun; workspace: ProductWorkspace; connections: ConnectionStatus; onBack: () => void; onConnect: () => void; onStatus: (id: string, status: RunStatus) => void; onOutput: (id: string, output: string) => void; onDelete: (id: string) => Promise<void>; notify: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [output, setOutput] = useState(run.output);
  const [deliveryJobs, setDeliveryJobs] = useState<DeliveryJob[]>([]);
  const [deliveryCoverage, setDeliveryCoverage] = useState({ expected: 0, prepared: 0, missing: 0 });
  const [deliveryWorking, setDeliveryWorking] = useState("");
  const [tiktokOptions, setTikTokOptions] = useState<Record<string, TikTokPublishingOptions>>({});
  const [youtubeOptions, setYouTubeOptions] = useState<Record<string, YouTubePublishingOptions>>({});
  const tiktokOptionsRequested = useRef(new Set<string>());
  const youtubeOptionsRequested = useRef(new Set<string>());
  const operationalChannels = [connections.gmail.canSend && "Email", connections.shopify.canManage && "Shopify", connections.linkedin.canPublish && "LinkedIn", connections.instagram.canPublish && "Instagram", connections.tiktok.canPublish && "TikTok", connections.youtube.canPublish && "YouTube", connections.x.canPublish && "X", connections.discord.canPublish && "Discord", connections.reddit.canPublish && "Reddit"].filter(Boolean) as string[];
  useEffect(() => {
    const refreshRunDelivery = () => apiFetch(`/api/delivery?projectId=${encodeURIComponent(run.projectId)}&runId=${encodeURIComponent(run.id)}`)
      .then(async (response) => { const data = await response.json(); if (response.ok) { setDeliveryJobs(Array.isArray(data.jobs) ? data.jobs : []); setDeliveryCoverage(data.coverage || { expected: data.jobs?.length || 0, prepared: data.jobs?.length || 0, missing: 0 }); } })
      .catch(() => undefined);
    void refreshRunDelivery();
    const poll = window.setInterval(() => void refreshRunDelivery(), 45_000);
    return () => window.clearInterval(poll);
  }, [run.id, run.projectId]);
  useEffect(() => {
    const update = (event: Event) => {
      const detail = (event as CustomEvent<{ runId?: string; jobs?: DeliveryJob[] }>).detail;
      if (detail?.runId === run.id && Array.isArray(detail.jobs)) setDeliveryJobs(detail.jobs);
    };
    window.addEventListener("market-agent-delivery-updated", update);
    return () => window.removeEventListener("market-agent-delivery-updated", update);
  }, [run.id]);
  useEffect(() => {
    for (const job of deliveryJobs) {
      if (job.channel !== "tiktok" || job.status !== "awaiting_approval" || tiktokOptionsRequested.current.has(job.id)) continue;
      tiktokOptionsRequested.current.add(job.id);
      apiFetch("/api/delivery", { method: "POST", body: JSON.stringify({ action: "options", projectId: run.projectId, id: job.id }) })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "TikTok publishing settings could not be verified.");
          const options = data as TikTokPublishingOptions;
          setTikTokOptions((current) => ({ ...current, [job.id]: options }));
          setDeliveryJobs((current) => current.map((item) => {
            if (item.id !== job.id) return item;
            return { ...item, payload: { ...item.payload, privacyLevel: "", disableComment: true, disableDuet: true, disableStitch: true, commercialContentToggle: false, brandOrganicToggle: false, brandContentToggle: false, musicConsent: false } };
          }));
        })
        .catch((error) => notify(error instanceof Error ? error.message : "TikTok publishing settings could not be verified."));
    }
  }, [deliveryJobs, notify, run.projectId]);
  useEffect(() => {
    for (const job of deliveryJobs) {
      if (job.channel !== "youtube" || job.status !== "awaiting_approval" || youtubeOptionsRequested.current.has(job.id)) continue;
      youtubeOptionsRequested.current.add(job.id);
      apiFetch("/api/delivery", { method: "POST", body: JSON.stringify({ action: "options", projectId: run.projectId, id: job.id }) })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "YouTube publishing settings could not be verified.");
          const options = data as YouTubePublishingOptions;
          setYouTubeOptions((current) => ({ ...current, [job.id]: options }));
        })
        .catch((error) => notify(error instanceof Error ? error.message : "YouTube publishing settings could not be verified."));
    }
  }, [deliveryJobs, notify, run.projectId]);
  const prepareDelivery = async () => {
    setDeliveryWorking("prepare");
    try {
      const response = await apiFetch("/api/delivery", { method: "POST", body: JSON.stringify({ action: "prepare", projectId: run.projectId, runId: run.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The approval queue could not be prepared.");
      setDeliveryJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setDeliveryCoverage(data.coverage || { expected: data.jobs?.length || 0, prepared: data.jobs?.length || 0, missing: 0 });
      notify(data.jobs?.length ? "Approval queue prepared. Nothing has been sent." : "No executable item was found. Recipients and public media are never invented.");
    } catch (error) { notify(error instanceof Error ? error.message : "The approval queue could not be prepared."); }
    finally { setDeliveryWorking(""); }
  };
  const executeDelivery = async (job: DeliveryJob) => {
    if (job.channel === "tiktok" && !tiktokOptions[job.id]) { notify("TikTok publishing settings are still being verified."); return; }
    if (job.channel === "youtube" && !youtubeOptions[job.id]) { notify("YouTube publishing settings are still being verified."); return; }
    const action = job.channel === "gmail" ? `send this email to ${job.payload.recipient}` : job.channel === "shopify" ? "create this draft product in Shopify" : `publish this post to ${deliveryChannelLabel(job.channel)}${job.channel === "tiktok" ? ` with ${tiktokPrivacyLabel(job.payload.privacyLevel).toLowerCase()} visibility` : job.channel === "youtube" ? ` with ${youtubePrivacyLabel(job.payload.privacyLevel).toLowerCase()} visibility` : ""}`;
    if (!window.confirm(`Approve and ${action}? This will perform the real external action now.`)) return;
    setDeliveryWorking(job.id);
    try {
      const response = await apiFetch("/api/delivery", { method: "POST", body: JSON.stringify({ action: "execute", projectId: run.projectId, id: job.id, approval: ["tiktok", "youtube"].includes(job.channel) ? job.payload : undefined }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The external action failed.");
      setDeliveryJobs((current) => current.map((item) => item.id === data.job.id ? data.job : item));
      notify(data.job.status === "complete" || data.job.status === "submitted" ? job.channel === "tiktok" ? "TikTok accepted the post. Processing can take a few minutes; its status will update here." : `${deliveryChannelLabel(job.channel)} accepted the action.` : data.job.error || "The external action failed.");
    } catch (error) { notify(error instanceof Error ? error.message : "The external action failed."); }
    finally { setDeliveryWorking(""); }
  };
  const approveCampaignSchedule = async () => {
    const pending = deliveryJobs.filter((job) => job.status === "awaiting_approval");
    if (!pending.length) return;
    if (deliveryCoverage.missing > 0) { notify(`Only ${deliveryCoverage.prepared} of ${deliveryCoverage.expected} planned items are ready. Complete the missing copy or assets before approving the full schedule.`); return; }
    const incompleteTikTok = pending.find((job) => job.channel === "tiktok" && (!tiktokOptions[job.id] || !job.payload.privacyLevel || !job.payload.musicConsent || (job.payload.commercialContentToggle && !job.payload.brandOrganicToggle && !job.payload.brandContentToggle)));
    if (incompleteTikTok) { notify("Complete the required TikTok choices in each TikTok preview before approving the schedule."); return; }
    const incompleteYouTube = pending.find((job) => job.channel === "youtube" && !youtubeOptions[job.id]);
    if (incompleteYouTube) { notify("YouTube publishing settings are still being verified."); return; }
    const times = pending.map((job) => new Date(job.payload.scheduledAt)).filter((date) => Number.isFinite(date.getTime())).sort((left, right) => left.getTime() - right.getTime());
    const range = times.length ? `${times[0].toLocaleString()}${times.length > 1 ? ` through ${times[times.length - 1].toLocaleString()}` : ""}` : "the planned dates";
    if (!window.confirm(`Approve ${pending.length} campaign item${pending.length === 1 ? "" : "s"} scheduled from ${range}? Market Agent will publish them automatically at the approved times. Any changed or new item will require a new approval.`)) return;
    setDeliveryWorking("approve-campaign");
    try {
      const response = await apiFetch("/api/delivery", { method: "POST", body: JSON.stringify({
        action: "approve-campaign",
        projectId: run.projectId,
        runId: run.id,
        items: pending.map((job) => ({ id: job.id, scheduledAt: job.payload.scheduledAt, approval: ["tiktok", "youtube"].includes(job.channel) ? job.payload : undefined })),
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The campaign schedule could not be approved.");
      setDeliveryJobs(Array.isArray(data.jobs) ? data.jobs : []);
      setDeliveryCoverage(data.coverage || deliveryCoverage);
      notify("Campaign schedule approved. Future items will publish automatically without another approval.");
    } catch (error) { notify(error instanceof Error ? error.message : "The campaign schedule could not be approved."); }
    finally { setDeliveryWorking(""); }
  };
  const pauseCampaignSchedule = async () => {
    if (!window.confirm("Pause every future item in this campaign? Nothing already published will be changed.")) return;
    setDeliveryWorking("pause-campaign");
    try {
      const response = await apiFetch("/api/delivery", { method: "POST", body: JSON.stringify({ action: "pause-campaign", projectId: run.projectId, runId: run.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The campaign schedule could not be paused.");
      setDeliveryJobs(Array.isArray(data.jobs) ? data.jobs : []);
      notify("Future campaign publishing is paused. Review and approve the schedule again when ready.");
    } catch (error) { notify(error instanceof Error ? error.message : "The campaign schedule could not be paused."); }
    finally { setDeliveryWorking(""); }
  };
  const cancelDelivery = async (job: DeliveryJob) => {
    setDeliveryWorking(job.id);
    try {
      const response = await apiFetch("/api/delivery", { method: "POST", body: JSON.stringify({ action: "cancel", projectId: run.projectId, id: job.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The delivery item could not be cancelled.");
      setDeliveryJobs((current) => current.map((item) => item.id === data.job.id ? data.job : item));
    } catch (error) { notify(error instanceof Error ? error.message : "The delivery item could not be cancelled."); }
    finally { setDeliveryWorking(""); }
  };
  const retryDelivery = async (job: DeliveryJob) => {
    setDeliveryWorking(job.id);
    try {
      const response = await apiFetch("/api/delivery", { method: "POST", body: JSON.stringify({ action: "retry", projectId: run.projectId, id: job.id }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The delivery item could not be reopened.");
      setDeliveryJobs((current) => current.map((item) => item.id === data.job.id ? data.job : item));
      notify("The failed item is ready for review and approval again.");
    } catch (error) { notify(error instanceof Error ? error.message : "The delivery item could not be reopened."); }
    finally { setDeliveryWorking(""); }
  };
  const updateTikTokApproval = (jobId: string, changes: Partial<DeliveryJob["payload"]>) => {
    setDeliveryJobs((current) => current.map((item) => item.id === jobId ? { ...item, payload: { ...item.payload, ...changes } } : item));
  };
  const updateYouTubeApproval = (jobId: string, changes: Partial<DeliveryJob["payload"]>) => {
    setDeliveryJobs((current) => current.map((item) => item.id === jobId ? { ...item, payload: { ...item.payload, ...changes } } : item));
  };
  const updateDeliverySchedule = (jobId: string, scheduledAt: string) => {
    setDeliveryJobs((current) => current.map((item) => item.id === jobId ? { ...item, payload: { ...item.payload, scheduledAt } } : item));
  };
  const saveEdit = () => { onOutput(run.id, output); setEditing(false); notify("Changes saved."); };
  const distributionRun = run.action === "campaign" || run.action === "social" || run.action === "chat";
  const campaignIssues = [
    ...(run.issueFindings?.high || []).map((text) => ({ severity: "high" as const, text })),
    ...(run.issueFindings?.attention || []).map((text) => ({ severity: "attention" as const, text })),
  ];
  const awaitingDeliveryJobs = deliveryJobs.filter((job) => job.status === "awaiting_approval");
  const scheduledDeliveryJobs = deliveryJobs.filter((job) => job.status === "scheduled");
  return <div className="op-stack">
    <button className="op-back" onClick={onBack}><ArrowLeft size={15} /> Back to workspace</button>
    <section className="op-run-detail">
      <header><div><div className="op-eyebrow">{actionMeta[run.action].title} · {new Date(run.createdAt).toLocaleString()}</div><h1>{run.title}</h1><p>{run.prompt || actionMeta[run.action].description}</p></div><div><span className={`op-review-state ${run.status === "Approved" ? "approved" : ""}`}>{run.status === "Approved" && <Check size={13} />}{run.status}</span><button className="op-more" onClick={() => { if (window.confirm("Delete this campaign and cancel every unpublished scheduled item? Already published posts remain on their platforms.")) void onDelete(run.id); }}><Trash2 size={16} /></button></div></header>
      {distributionRun && <CampaignCreativePreview run={run} workspace={workspace} />}
      {distributionRun && (run.assetReferences || []).length > 0 && <section className="op-campaign-assets"><div><small>CAMPAIGN ASSETS</small><strong>Selected by the project agent</strong><p>These files remain in the Content Library and are linked here for this campaign.</p></div><div>{run.assetReferences?.map((asset) => <article key={asset.id}><span>{asset.kind === "image" ? <ImageIcon size={16} /> : asset.kind === "video" ? <Video size={16} /> : <FileText size={16} />}</span><div><strong>{asset.name}</strong><p>{asset.summary}</p><small>{asset.routingRationale}</small></div></article>)}</div></section>}
      {distributionRun && campaignIssues.length > 0 && <section className="op-campaign-issues"><div><small>CAMPAIGN CHECKS</small><strong>{campaignIssues.length} {campaignIssues.length === 1 ? "item" : "items"} to review before publishing</strong><p>These apply only to this campaign and do not appear in the project Issues panel.</p></div><ul>{campaignIssues.map((issue, index) => <li className={issue.severity} key={`${issue.severity}-${index}`}><CircleAlert size={15} /><span>{issue.text}</span></li>)}</ul></section>}
      {distributionRun && <div className={`op-execution-state ${operationalChannels.length ? "connected" : ""}`}><span>{operationalChannels.length ? <Check size={19} /> : <Send size={19} />}</span><div><small>EXECUTION STATUS</small><strong>{operationalChannels.length ? `${operationalChannels.join(", ")} operational` : "Prepared — not launched"}</strong><p>{operationalChannels.length ? "Review the full calendar once. You can publish one item now or approve the complete schedule for automatic delivery." : "No operational delivery channel is connected, so nothing can be sent or published."}</p></div><button onClick={onConnect}>{operationalChannels.length ? "Manage connections" : "Connection setup"} <ArrowRight size={14} /></button></div>}
      {distributionRun && operationalChannels.length > 0 && <section className="op-delivery-queue">
        <div className="op-section-title">
          <div><small>CAMPAIGN DELIVERY</small><h2>Review once, then run automatically</h2><p>Review the complete calendar and approve it once. Market Agent publishes each unchanged item on its approved date without asking again.</p></div>
          {run.status === "Approved" && deliveryJobs.length === 0 && <button onClick={() => void prepareDelivery()} disabled={deliveryWorking === "prepare"}>{deliveryWorking === "prepare" ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{deliveryWorking === "prepare" ? "Preparing…" : "Prepare actions"}</button>}
        </div>
        {run.status !== "Approved" && <div className="op-delivery-empty"><CircleAlert size={16} /> Mark this work approved before creating external actions.</div>}
        {awaitingDeliveryJobs.length > 0 && <div className={`op-campaign-schedule-approval ${deliveryCoverage.missing > 0 ? "incomplete" : ""}`}><div><small>{deliveryCoverage.missing > 0 ? "CAMPAIGN INCOMPLETE" : "ONE APPROVAL FOR THE CAMPAIGN"}</small><strong>{deliveryCoverage.missing > 0 ? `${deliveryCoverage.prepared} of ${deliveryCoverage.expected} planned items ready` : `${awaitingDeliveryJobs.length} item${awaitingDeliveryJobs.length === 1 ? "" : "s"} ready across ${new Set(awaitingDeliveryJobs.map((job) => job.channel)).size} channel${new Set(awaitingDeliveryJobs.map((job) => job.channel)).size === 1 ? "" : "s"}`}</strong><p>{deliveryCoverage.missing > 0 ? `${deliveryCoverage.missing} planned item${deliveryCoverage.missing === 1 ? " still needs" : "s still need"} final copy or an approved asset. The app will not call a partial queue a full campaign.` : "Dates remain editable below. Paid media is never included unless a separate budget is explicitly approved."}</p></div><button onClick={() => void approveCampaignSchedule()} disabled={Boolean(deliveryWorking) || deliveryCoverage.missing > 0}>{deliveryWorking === "approve-campaign" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {deliveryCoverage.missing > 0 ? "Complete campaign first" : "Approve full schedule"}</button></div>}
        {scheduledDeliveryJobs.length > 0 && <div className="op-campaign-schedule-approval scheduled"><div><small>AUTOMATIC PUBLISHING ACTIVE</small><strong>{scheduledDeliveryJobs.length} future item{scheduledDeliveryJobs.length === 1 ? "" : "s"} approved</strong><p>The cloud scheduler will publish these exact items on their dates. Changes and new items require approval again.</p></div><button className="secondary" onClick={() => void pauseCampaignSchedule()} disabled={Boolean(deliveryWorking)}>{deliveryWorking === "pause-campaign" ? <LoaderCircle className="spin" size={14} /> : <CircleAlert size={14} />} Pause future posts</button></div>}
        {deliveryJobs.length > 0 && <div className="op-delivery-list">{deliveryJobs.map((job) => <DeliveryApprovalCard
          key={job.id}
          job={job}
          accountLabel={job.channel === "instagram" ? connections.instagram.destinationName || connections.instagram.accountLabel : ""}
          busy={deliveryWorking}
          tiktokOptions={tiktokOptions[job.id]}
          youtubeOptions={youtubeOptions[job.id]}
          onTikTokChange={(changes) => updateTikTokApproval(job.id, changes)}
          onYouTubeChange={(changes) => updateYouTubeApproval(job.id, changes)}
          onScheduleChange={(scheduledAt) => updateDeliverySchedule(job.id, scheduledAt)}
          onExecute={() => void executeDelivery(job)}
          onCancel={() => void cancelDelivery(job)}
          onRetry={() => void retryDelivery(job)}
        />)}</div>}
      </section>}
      <div className="op-detail-grid">
        <article className="op-output-card">{editing ? <textarea value={output} onChange={(e) => setOutput(e.target.value)} /> : <MarkdownLite value={run.output} hideAction={distributionRun} />}</article>
        <aside>
          <div className="op-review-card"><strong>Review control</strong><p>Approval saves your decision. It does not send or publish anything.</p>{editing ? <><button onClick={saveEdit}><Save size={14} /> Save changes</button><button className="secondary" onClick={() => { setOutput(run.output); setEditing(false); }}>Cancel</button></> : <button className="secondary" onClick={() => setEditing(true)}>Edit output</button>}{run.status === "Draft" ? <button onClick={() => { onStatus(run.id, "Approved"); notify("Approved and saved. Nothing was published."); }}><Check size={14} /> Mark approved</button> : <button className="secondary" onClick={() => onStatus(run.id, "Draft")}>Return to draft</button>}</div>
          {run.sources.length > 0 && <RunSources sources={run.sources} />}
          <div className="op-run-meta"><span>Analysis</span><strong>{String(run.model || "").toLowerCase().includes("panel") ? "Balanced review" : "Standard review"}</strong>{run.intensity && <><span>Campaign style</span><strong>{run.intensity[0].toUpperCase() + run.intensity.slice(1)}</strong></>}<span>Record</span><code>{run.remoteId || "Cloud record"}</code></div>
        </aside>
      </div>
    </section>
  </div>;
}

function DeliveryApprovalCard({ job, accountLabel, busy, tiktokOptions, youtubeOptions, onTikTokChange, onYouTubeChange, onScheduleChange, onExecute, onCancel, onRetry }: {
  job: DeliveryJob;
  accountLabel: string;
  busy: string;
  tiktokOptions?: TikTokPublishingOptions;
  youtubeOptions?: YouTubePublishingOptions;
  onTikTokChange: (changes: Partial<DeliveryJob["payload"]>) => void;
  onYouTubeChange: (changes: Partial<DeliveryJob["payload"]>) => void;
  onScheduleChange: (scheduledAt: string) => void;
  onExecute: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const tiktokIncomplete = job.channel === "tiktok" && (!tiktokOptions || !job.payload.privacyLevel || !job.payload.musicConsent || (job.payload.commercialContentToggle && !job.payload.brandOrganicToggle && !job.payload.brandContentToggle));
  const blocked = Boolean(busy) || tiktokIncomplete || (job.channel === "youtube" && !youtubeOptions);
  if (job.channel === "instagram") return <InstagramApprovalCard job={job} accountLabel={accountLabel} busy={busy} onScheduleChange={onScheduleChange} onExecute={onExecute} onCancel={onCancel} />;
  return <article className={`op-delivery-card status-${job.status}`}>
    <header><strong>{deliveryChannelLabel(job.channel)}</strong><em>{deliveryStatusLabel(job.status)}</em></header>
    <DeliveryScheduleControl job={job} onChange={onScheduleChange} />
    {job.payload.recipient && <small>TO · {job.payload.recipient}</small>}
    {job.channel === "tiktok" && job.status === "awaiting_approval" && <TikTokApprovalControls job={job} options={tiktokOptions} onChange={onTikTokChange} />}
    {job.channel === "youtube" && job.status === "awaiting_approval" && <YouTubeApprovalControls job={job} options={youtubeOptions} onChange={onYouTubeChange} />}
    {job.payload.subject && <h3>{job.payload.subject}</h3>}
    {job.payload.mediaUrl && <DeliveryMediaPreview job={job} />}
    <p>{job.payload.text}</p>
    <details className="op-delivery-rationale"><summary>Why this was selected</summary><blockquote>{job.payload.rationale}</blockquote></details>
    {job.error && <div className="op-delivery-error">{job.error}</div>}
    {job.externalId && <code>Platform receipt: {job.externalId}</code>}
    {job.status === "awaiting_approval" && <DeliveryApprovalActions job={job} busy={busy} disabled={blocked} onExecute={onExecute} onCancel={onCancel} />}
    {["failed", "dead_letter"].includes(job.status) && !job.externalId && <footer><button onClick={onRetry} disabled={Boolean(busy)}>{busy === job.id ? <LoaderCircle className="spin" size={13} /> : <ArrowRight size={13} />} Review and retry</button></footer>}
  </article>;
}

function InstagramApprovalCard({ job, accountLabel, busy, onScheduleChange, onExecute, onCancel }: { job: DeliveryJob; accountLabel: string; busy: string; onScheduleChange: (scheduledAt: string) => void; onExecute: () => void; onCancel: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const handle = String(accountLabel || "Instagram account").replace(/^@/, "");
  const avatar = handle.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "IG";
  return <article className={`op-delivery-card op-instagram-approval status-${job.status}`}>
    <header><strong>Instagram</strong><em>{deliveryStatusLabel(job.status)}</em></header>
    <DeliveryScheduleControl job={job} onChange={onScheduleChange} />
    <div className="op-instagram-preview" aria-label="Instagram post preview">
      <div className="op-instagram-preview__account"><span>{avatar}</span><div><strong>@{handle}</strong><small>Post preview · not published</small></div><MoreHorizontal size={18} /></div>
      <div className={`op-instagram-preview__media ${job.payload.mediaKind === "video" ? "video" : "image"}`}>
        {job.payload.mediaKind === "video"
          ? <video src={job.payload.mediaUrl} controls playsInline preload="auto" onLoadedMetadata={(event) => moveVideoToCoverFrame(event.currentTarget)} onLoadedData={(event) => moveVideoToCoverFrame(event.currentTarget)} />
          : <img src={job.payload.mediaUrl} alt={`Instagram post preview for @${handle}`} />}
        <button type="button" onClick={() => setExpanded(true)}>View full size</button>
        <span>{job.payload.mediaKind === "video" ? "9:16 video preview" : "4:5 feed crop"}</span>
      </div>
      <div className="op-instagram-preview__actions" aria-hidden="true"><span><Heart size={21} /><MessageCircle size={20} /><Send size={20} /></span><Bookmark size={20} /></div>
      <div className="op-instagram-preview__caption"><strong>@{handle}</strong><span>{job.payload.text}</span></div>
      <small className="op-instagram-preview__notice">Preview only. Approval below publishes this exact media and caption.</small>
    </div>
    <details className="op-delivery-rationale"><summary>Why this asset was selected</summary><blockquote>{job.payload.rationale}</blockquote></details>
    {job.error && <div className="op-delivery-error">{job.error}</div>}
    {job.externalId && <code>Platform receipt: {job.externalId}</code>}
    {job.status === "awaiting_approval" && <DeliveryApprovalActions job={job} busy={busy} disabled={Boolean(busy)} onExecute={onExecute} onCancel={onCancel} />}
    {expanded && <div className="op-media-lightbox" role="dialog" aria-modal="true" aria-label="Full-size Instagram media preview" onClick={() => setExpanded(false)}>
      <button type="button" aria-label="Close preview" onClick={() => setExpanded(false)}><X size={20} /></button>
      <div onClick={(event) => event.stopPropagation()}>{job.payload.mediaKind === "video" ? <video src={job.payload.mediaUrl} controls autoPlay playsInline preload="auto" onLoadedMetadata={(event) => moveVideoToCoverFrame(event.currentTarget)} onLoadedData={(event) => moveVideoToCoverFrame(event.currentTarget)} /> : <img src={job.payload.mediaUrl} alt={`Full-size media selected for @${handle}`} />}</div>
    </div>}
  </article>;
}

function DeliveryScheduleControl({ job, onChange }: { job: DeliveryJob; onChange: (scheduledAt: string) => void }) {
  if (job.status === "awaiting_approval") return <label className="op-delivery-schedule"><span>Planned publication</span><input type="datetime-local" value={toLocalDateTimeValue(job.payload.scheduledAt)} min={nextQuarterLocal()} onChange={(event) => onChange(fromLocalDateTimeValue(event.target.value))} /></label>;
  if (job.status === "scheduled") return <div className="op-delivery-scheduled"><Check size={14} /><span>Approved for <strong>{new Date(job.payload.scheduledAt).toLocaleString()}</strong></span></div>;
  return null;
}

function DeliveryMediaPreview({ job }: { job: DeliveryJob }) {
  const [expanded, setExpanded] = useState(false);
  return <>
    <div className={`op-delivery-media ${job.payload.mediaKind === "video" ? "video" : "image"}`}>
      {job.payload.mediaKind === "video" ? <video src={job.payload.mediaUrl} controls playsInline preload="metadata" /> : <img src={job.payload.mediaUrl} alt={`${deliveryChannelLabel(job.channel)} post media preview`} />}
      <button type="button" onClick={() => setExpanded(true)}>View full size</button>
    </div>
    {expanded && <div className="op-media-lightbox" role="dialog" aria-modal="true" aria-label="Full-size media preview" onClick={() => setExpanded(false)}>
      <button type="button" aria-label="Close preview" onClick={() => setExpanded(false)}><X size={20} /></button>
      <div onClick={(event) => event.stopPropagation()}>{job.payload.mediaKind === "video" ? <video src={job.payload.mediaUrl} controls autoPlay playsInline /> : <img src={job.payload.mediaUrl} alt="Full-size post media" />}</div>
    </div>}
  </>;
}

function DeliveryApprovalActions({ job, busy, disabled, onExecute, onCancel }: { job: DeliveryJob; busy: string; disabled: boolean; onExecute: () => void; onCancel: () => void }) {
  return <footer><button onClick={onExecute} disabled={disabled}>{busy === job.id ? <LoaderCircle className="spin" size={13} /> : <Send size={13} />}Approve &amp; {job.channel === "gmail" ? "send" : job.channel === "shopify" ? "create draft" : "publish"}</button><button className="secondary" onClick={onCancel} disabled={Boolean(busy)}>Cancel</button></footer>;
}

function TikTokApprovalControls({ job, options, onChange }: { job: DeliveryJob; options?: TikTokPublishingOptions; onChange: (changes: Partial<DeliveryJob["payload"]>) => void }) {
  if (!options) return <div className="op-tiktok-settings loading"><LoaderCircle className="spin" size={14} /> Verifying the connected account’s publishing choices…</div>;
  const privateVisibility = job.payload.privacyLevel === "SELF_ONLY";
  return <div className="op-tiktok-settings"><div><strong>Publish as {options.accountLabel}</strong><small>Required TikTok review</small></div><label><span>Caption</span><textarea value={job.payload.text} maxLength={job.payload.mediaKind === "image" ? 4000 : 2200} onChange={(event) => onChange({ text: event.target.value })} /></label><label><span>Visibility</span><select value={job.payload.privacyLevel} onChange={(event) => onChange({ privacyLevel: event.target.value, brandContentToggle: event.target.value === "SELF_ONLY" ? false : job.payload.brandContentToggle })}><option value="" disabled>Choose visibility…</option>{options.privacyLevelOptions.map((level) => <option key={level} value={level} disabled={level === "SELF_ONLY" && job.payload.brandContentToggle}>{tiktokPrivacyLabel(level)}</option>)}</select></label><div className="op-tiktok-switches"><label><input type="checkbox" checked={!job.payload.disableComment && !options.commentDisabled} disabled={options.commentDisabled} onChange={(event) => onChange({ disableComment: !event.target.checked })} /> Allow comments</label>{job.payload.mediaKind === "video" && <><label><input type="checkbox" checked={!job.payload.disableDuet && !options.duetDisabled} disabled={options.duetDisabled} onChange={(event) => onChange({ disableDuet: !event.target.checked })} /> Allow Duet</label><label><input type="checkbox" checked={!job.payload.disableStitch && !options.stitchDisabled} disabled={options.stitchDisabled} onChange={(event) => onChange({ disableStitch: !event.target.checked })} /> Allow Stitch</label></>}</div><label className="op-tiktok-commercial"><input type="checkbox" checked={job.payload.commercialContentToggle} onChange={(event) => onChange({ commercialContentToggle: event.target.checked, brandOrganicToggle: false, brandContentToggle: false })} /><span>This post promotes a brand, product, or service</span></label>{job.payload.commercialContentToggle && <div className="op-tiktok-switches commercial"><label><input type="checkbox" checked={job.payload.brandOrganicToggle} onChange={(event) => onChange({ brandOrganicToggle: event.target.checked })} /> My own brand</label><label><input type="checkbox" checked={job.payload.brandContentToggle} disabled={privateVisibility} onChange={(event) => onChange({ brandContentToggle: event.target.checked })} /> Another brand / paid partnership</label></div>}{job.payload.commercialContentToggle && job.payload.brandOrganicToggle && <small>Your post will be labeled “Promotional content.”</small>}{job.payload.commercialContentToggle && job.payload.brandContentToggle && <small>Your post will be labeled “Paid partnership.”</small>}<label className="op-tiktok-consent"><input type="checkbox" checked={job.payload.musicConsent} onChange={(event) => onChange({ musicConsent: event.target.checked })} /><span>By posting, I agree to TikTok’s {job.payload.brandContentToggle && <><a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">Branded Content Policy</a> and </>}<a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.</span></label>{job.payload.aiGenerated && <small>AI-generated media label will be sent to TikTok.</small>}</div>;
}

function YouTubeApprovalControls({ job, options, onChange }: { job: DeliveryJob; options?: YouTubePublishingOptions; onChange: (changes: Partial<DeliveryJob["payload"]>) => void }) {
  if (!options) return <div className="op-tiktok-settings loading"><LoaderCircle className="spin" size={14} /> Verifying the connected YouTube channel…</div>;
  return <div className="op-tiktok-settings"><div><strong>Upload to {options.accountLabel}</strong><small>Review visibility and audience before the real upload.</small></div><label><span>Visibility</span><select value={job.payload.privacyLevel} onChange={(event) => onChange({ privacyLevel: event.target.value })}>{options.privacyLevelOptions.map((level) => <option key={level} value={level}>{youtubePrivacyLabel(level)}</option>)}</select></label><div className="op-tiktok-switches"><label><input type="checkbox" checked={job.payload.madeForKids} onChange={(event) => onChange({ madeForKids: event.target.checked })} /> Made for kids</label></div>{job.payload.aiGenerated && <small>Altered or synthetic media disclosure will be sent to YouTube.</small>}</div>;
}

function tiktokPrivacyLabel(value: string) {
  return ({ PUBLIC_TO_EVERYONE: "Public", MUTUAL_FOLLOW_FRIENDS: "Friends", FOLLOWER_OF_CREATOR: "Followers", SELF_ONLY: "Private — only me" } as Record<string, string>)[value] || value.replaceAll("_", " ").toLowerCase();
}

function youtubePrivacyLabel(value: string) {
  return ({ private: "Private", unlisted: "Unlisted", public: "Public" } as Record<string, string>)[value] || value;
}

function deliveryChannelLabel(channel: DeliveryJob["channel"]) {
  return ({ gmail: "Email", linkedin: "LinkedIn", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", discord: "Discord", reddit: "Reddit", shopify: "Shopify" } as const)[channel];
}

function deliveryStatusLabel(status: DeliveryJob["status"]) {
  return ({ awaiting_approval: "Waiting for approval", scheduled: "Scheduled", running: "Sending", submitted: "Submitted", complete: "Complete", failed: "Failed", dead_letter: "Needs intervention", cancelled: "Cancelled" } as const)[status];
}

function RunSources({ sources }: { sources: AgentRun["sources"] }) {
  const visible = sources.slice(0, 5);
  const remaining = sources.slice(5);
  const link = (source: AgentRun["sources"][number]) => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}><Globe2 size={13} /><span>{sourceDisplayName(source)}</span><ArrowRight size={12} /></a>;
  return <div className="op-run-sources"><div className="op-run-sources__head"><strong>Sources</strong><em>{sources.length}</em></div>{visible.map(link)}{remaining.length > 0 && <details><summary>Show {remaining.length} more</summary><div>{remaining.map(link)}</div></details>}</div>;
}

function sourceDisplayName(source: AgentRun["sources"][number]) {
  if (source.title && !/^https?:\/\//i.test(source.title) && source.title.length < 90) return source.title;
  try {
    const url = new URL(source.url);
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "").split("/").slice(-1)[0];
    return path ? `${url.hostname} · ${decodeURIComponent(path).slice(0, 48)}` : url.hostname;
  } catch {
    return source.title || source.url;
  }
}

function OperationalIntegrations({ workspace, projectId, userEmail, health, apiCredentials, onApiCredentials, billing, accessMode, billingBusy, onSubscribe, onCancelPlan, connections, onConnections, guideTarget, notify }: { workspace: ProductWorkspace; projectId: string; userEmail: string; health: HealthState; apiCredentials: ApiCredentialStatus; onApiCredentials: (status: ApiCredentialStatus) => void; billing: BillingStatus; accessMode: "byok" | "managed" | "trial" | "expired"; billingBusy: boolean; onSubscribe: () => void; onCancelPlan: () => void; connections: ConnectionStatus; onConnections: (status: ConnectionStatus) => void; guideTarget: ConnectionGuideTarget; notify: (message: string) => void }) {
  const [section, setSection] = useState<"services" | "social" | "system">("services");
  const [connecting, setConnecting] = useState("");
  const [savingProvider, setSavingProvider] = useState<ApiProvider | "">("");
  const [keyDrafts, setKeyDrafts] = useState<Record<ApiProvider, string>>({ openai: "", google: "", anthropic: "" });
  const [analyticsProperty, setAnalyticsProperty] = useState("");
  const [editingAnalyticsProperty, setEditingAnalyticsProperty] = useState(false);
  const [mailchimpAudience, setMailchimpAudience] = useState("");
  const [linkedInDestination, setLinkedInDestination] = useState("");
  const [instagramDestination, setInstagramDestination] = useState("");
  const [redditCommunity, setRedditCommunity] = useState("");
  const [shopifyStore, setShopifyStore] = useState(connections.shopify.storeDomain || "");
  const [showAllConnections, setShowAllConnections] = useState(true);
  const [highlightedConnector, setHighlightedConnector] = useState<ConnectionProvider | null>(null);
  useEffect(() => {
    setAnalyticsProperty(connections.analytics.propertyId || connections.analytics.properties[0]?.id || "");
  }, [connections.analytics.propertyId, connections.analytics.properties]);
  useEffect(() => {
    setMailchimpAudience(connections.mailchimp.audienceId || connections.mailchimp.audiences[0]?.id || "");
  }, [connections.mailchimp.audienceId, connections.mailchimp.audiences]);
  useEffect(() => {
    const companyPage = connections.linkedin.destinations?.find((destination) => destination.label.toLowerCase().includes("company"));
    setLinkedInDestination(connections.linkedin.destinationId || companyPage?.id || "");
  }, [connections.linkedin.destinationId, connections.linkedin.destinations]);
  useEffect(() => {
    setInstagramDestination(connections.instagram.destinationId || connections.instagram.destinations?.[0]?.id || "");
  }, [connections.instagram.destinationId, connections.instagram.destinations]);
  useEffect(() => {
    setRedditCommunity(connections.reddit.destinationId || connections.reddit.destinations?.[0]?.id || "");
  }, [connections.reddit.destinationId, connections.reddit.destinations]);
  useEffect(() => {
    if (connections.shopify.storeDomain) setShopifyStore(connections.shopify.storeDomain);
  }, [connections.shopify.storeDomain]);
  useEffect(() => setShowAllConnections(true), [projectId]);
  useEffect(() => {
    if (!guideTarget) return;
    setSection(["linkedin", "instagram", "tiktok", "youtube", "x", "discord", "reddit"].includes(guideTarget.id) ? "social" : "services");
    const recommendedIds = recommendedConnectorIds(workspace);
    if (!recommendedIds.includes(guideTarget.id)) setShowAllConnections(true);
    setHighlightedConnector(guideTarget.id);
    const scrollTimer = window.setTimeout(() => {
      document.querySelector(`[data-connector="${guideTarget.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
    const clearTimer = window.setTimeout(() => setHighlightedConnector(null), 2800);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [guideTarget, workspace]);
  const connectAccount = async (provider: ConnectionProvider) => {
    if (provider === "shopify" && !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shopifyStore.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, ""))) {
      notify("Enter the store’s permanent address, such as your-store.myshopify.com.");
      return;
    }
    setConnecting(provider);
    try {
      const response = await apiFetch("/api/connections", { method: "POST", body: JSON.stringify({ provider, projectId, ...(provider === "shopify" ? { storeDomain: shopifyStore } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Account connection could not start.");
      const popup = window.open(data.authorizationUrl, "market-agent-provider-authorization", "popup=yes,width=680,height=820,resizable=yes,scrollbars=yes");
      if (!popup) {
        window.location.assign(data.authorizationUrl);
        return;
      }
      popup.focus();
      const outcome = await new Promise<{ result: string; reason: string } | null>((resolve) => {
        let finished = false;
        const finish = (value: { result: string; reason: string } | null) => {
          if (finished) return;
          finished = true;
          window.removeEventListener("message", receiveResult);
          window.clearInterval(closeCheck);
          window.clearTimeout(expiry);
          resolve(value);
        };
        const receiveResult = (event: MessageEvent) => {
          if (event.origin !== window.location.origin || event.source !== popup || event.data?.type !== "market-agent-connection-result") return;
          finish({ result: String(event.data.result || ""), reason: String(event.data.reason || "") });
        };
        const closeCheck = window.setInterval(() => { if (popup.closed) finish(null); }, 400);
        const expiry = window.setTimeout(() => finish(null), 10 * 60 * 1000);
        window.addEventListener("message", receiveResult);
      });
      if (!outcome) {
        notify("The provider sign-in window was closed. Your Market Agent login was not changed.");
        return;
      }
      const latest = await apiFetch(`/api/connections?projectId=${encodeURIComponent(projectId)}`);
      const latestData = await latest.json();
      if (latest.ok) onConnections(latestData as ConnectionStatus);
      const labels: Record<string, string> = { gmail: "Mailbox", analytics: "Google Analytics", mailchimp: "Mailchimp", shopify: "Shopify", linkedin: "LinkedIn", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", x: "X", discord: "Discord", reddit: "Reddit" };
      const connectedProvider = outcome.result.replace(/-(success|select)$/, "");
      notify(outcome.result === "analytics-select" ? "Google account authorized. Choose this project’s Analytics property." : outcome.result === "mailchimp-select" ? "Mailchimp account connected. Choose this project’s audience." : outcome.result.endsWith("-success") ? `${labels[connectedProvider] || "Account"} connected to this project. Your Market Agent login is unchanged.` : outcome.reason || "Account connection failed.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Account connection could not start.");
    } finally {
      setConnecting("");
    }
  };
  const chooseAnalyticsProperty = async () => {
    if (!analyticsProperty) { notify("Choose an Analytics property first."); return; }
    setConnecting("google-analytics");
    try {
      const response = await apiFetch("/api/connections", { method: "POST", body: JSON.stringify({ provider: "google-analytics", projectId, propertyId: analyticsProperty }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The Analytics property could not be verified.");
      onConnections(data as ConnectionStatus);
      setEditingAnalyticsProperty(false);
      notify("Analytics property verified. Live reporting is operational.");
    } catch (error) { notify(error instanceof Error ? error.message : "The Analytics property could not be verified."); }
    finally { setConnecting(""); }
  };
  const chooseMailchimpAudience = async () => {
    if (!mailchimpAudience) { notify("Choose a Mailchimp audience first."); return; }
    setConnecting("mailchimp");
    try {
      const response = await apiFetch("/api/connections", { method: "POST", body: JSON.stringify({ provider: "mailchimp", projectId, audienceId: mailchimpAudience }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The Mailchimp audience could not be selected.");
      onConnections(data as ConnectionStatus);
      notify("Mailchimp audience selected. Newsletter work is operational.");
    } catch (error) { notify(error instanceof Error ? error.message : "The Mailchimp audience could not be selected."); }
    finally { setConnecting(""); }
  };
  const chooseLinkedInDestination = async () => {
    if (!linkedInDestination) { notify("Choose a LinkedIn company page or personal profile first."); return; }
    setConnecting("linkedin");
    try {
      const response = await apiFetch("/api/connections", { method: "POST", body: JSON.stringify({ provider: "linkedin", projectId, destinationId: linkedInDestination }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The LinkedIn publishing destination could not be selected.");
      onConnections(data as ConnectionStatus);
      notify("LinkedIn destination selected. Publishing remains approval-only.");
    } catch (error) { notify(error instanceof Error ? error.message : "The LinkedIn destination could not be selected."); }
    finally { setConnecting(""); }
  };
  const chooseInstagramDestination = async () => {
    if (!instagramDestination) { notify("Choose an Instagram professional account first."); return; }
    setConnecting("instagram");
    try {
      const response = await apiFetch("/api/connections", { method: "POST", body: JSON.stringify({ provider: "instagram", projectId, destinationId: instagramDestination }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The Instagram account could not be selected.");
      onConnections(data as ConnectionStatus);
      notify("Instagram account selected. Publishing remains approval-only.");
    } catch (error) { notify(error instanceof Error ? error.message : "The Instagram account could not be selected."); }
    finally { setConnecting(""); }
  };
  const chooseRedditCommunity = async () => {
    if (!redditCommunity) { notify("Choose a Reddit community first."); return; }
    setConnecting("reddit");
    try {
      const response = await apiFetch("/api/connections", { method: "POST", body: JSON.stringify({ provider: "reddit", projectId, destinationId: redditCommunity }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The Reddit community could not be selected.");
      onConnections(data as ConnectionStatus);
      notify("Reddit community selected. Posts remain approval-only.");
    } catch (error) { notify(error instanceof Error ? error.message : "The Reddit community could not be selected."); }
    finally { setConnecting(""); }
  };
  const disconnectAccount = async (provider: ConnectionProvider, label: string) => {
    if (!window.confirm(`Disconnect ${label} from this project?`)) return;
    setConnecting(provider);
    try {
      const response = await apiFetch(`/api/connections?projectId=${encodeURIComponent(projectId)}&provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `${label} could not be disconnected.`);
      onConnections(data as ConnectionStatus);
      notify(`${label} disconnected from this project.`);
    } catch (error) { notify(error instanceof Error ? error.message : `${label} could not be disconnected.`); }
    finally { setConnecting(""); }
  };
  const saveApiCredential = async (provider: ApiProvider) => {
    const apiKey = keyDrafts[provider].trim();
    if (!apiKey) { notify("Paste the API key first."); return; }
    setSavingProvider(provider);
    try {
      const response = await apiFetch("/api/api-credentials", { method: "POST", body: JSON.stringify({ provider, apiKey }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The private API connection could not be saved.");
      onApiCredentials(data as ApiCredentialStatus);
      setKeyDrafts((current) => ({ ...current, [provider]: "" }));
      notify("Private API connection saved.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The private API connection could not be saved.");
    } finally {
      setSavingProvider("");
    }
  };
  const disconnectApiCredential = async (provider: ApiProvider) => {
    if (!window.confirm("Disconnect this private API key? Automated work that needs it will pause.")) return;
    setSavingProvider(provider);
    try {
      const response = await apiFetch(`/api/api-credentials?provider=${encodeURIComponent(provider)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The private API connection could not be removed.");
      onApiCredentials(data as ApiCredentialStatus);
      notify("Private API connection removed. Assistant routines that need it will pause if no other access remains.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "The private API connection could not be removed.");
    } finally {
      setSavingProvider("");
    }
  };
  const restoreOwnerCredentials = async () => {
    setSavingProvider("openai");
    try {
      const response = await apiFetch("/api/owner-credentials", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Stored API connections could not be restored.");
      onApiCredentials(data as ApiCredentialStatus);
      notify("Your three previously stored APIs are connected to this account.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "Stored API connections could not be restored.");
    } finally {
      setSavingProvider("");
    }
  };
  const apiOptions: Array<{ provider: ApiProvider; name: string; account: string; detail: string; tier: string; helpUrl: string }> = [
    { provider: "openai", name: "OpenAI API", account: "Core option", detail: "Reasoning, research, project memory, synthesis, and image creation", tier: "OpenAI account", helpUrl: "https://platform.openai.com/api-keys" },
    { provider: "google", name: "Gemini API", account: "Core option", detail: "Reasoning, a second strategic perspective, image creation, and video creation", tier: "Google Cloud project", helpUrl: "https://console.cloud.google.com/apis/credentials" },
    { provider: "anthropic", name: "Claude API", account: "Optional reviewer", detail: "An additional independent review of messaging, risks, and strategy", tier: "Anthropic account", helpUrl: "https://console.anthropic.com/settings/keys" },
  ];
  const connectors: Array<{ id?: ConnectionProvider; name: string; detail: string; credential: string; ready: boolean; configured: boolean; core: boolean; authorized?: boolean; connected?: boolean; needsSelection?: boolean; blockedReason?: string }> = [
    { name: "Neon", detail: "Private sign-in and cross-device Postgres persistence", credential: "Database + managed auth", ready: health.databaseConfigured && health.authConfigured, configured: health.databaseConfigured && health.authConfigured, core: true },
    { id: "google-analytics", name: "Google Analytics", detail: connections.analytics.canRead ? `Live property: ${connections.analytics.propertyName}` : connections.analytics.authorized ? `Authorized account: ${connections.analytics.accountEmail}` : "Live traffic, acquisition, events, and key-event reporting", credential: "Read-only Analytics authorization", ready: connections.analytics.canRead, configured: connections.analytics.configured, authorized: connections.analytics.authorized, connected: connections.analytics.connected, core: false },
    { id: "google-gmail", name: "Gmail", detail: connections.gmail.connected ? `Authorized sender: ${connections.gmail.accountEmail}` : "Approved outreach from your dedicated mailbox", credential: "Send-only mailbox authorization", ready: connections.gmail.canSend, configured: connections.gmail.configured, connected: connections.gmail.connected, core: false },
    { id: "mailchimp", name: "Mailchimp", detail: connections.mailchimp.canManage ? `Audience: ${connections.mailchimp.audienceName}` : connections.mailchimp.connected ? `Authorized account: ${connections.mailchimp.accountLabel}` : "Newsletter creation, consented subscribers, sending, and performance", credential: "Mailchimp audience and campaign authorization", ready: connections.mailchimp.canManage, configured: connections.mailchimp.configured, connected: connections.mailchimp.connected, needsSelection: connections.mailchimp.connected && !connections.mailchimp.canManage, core: false },
    { id: "shopify", name: "Shopify", detail: connections.shopify.connected ? `Authorized store: ${connections.shopify.storeName}` : "Enter the permanent .myshopify.com address to connect approval-only product drafts and media", credential: "Products, content, files, and publication authorization", ready: connections.shopify.canManage, configured: connections.shopify.configured, connected: connections.shopify.connected, core: false },
    { id: "linkedin", name: "LinkedIn", detail: connections.linkedin.destinationName ? `Publishing destination: ${connections.linkedin.destinationName} · authorized by ${connections.linkedin.accountLabel}` : connections.linkedin.connected ? `Authorized by ${connections.linkedin.accountLabel} · choose a project publishing destination` : "Connect an authorized page administrator, then select the project’s company page; personal publishing stays optional", credential: "LinkedIn authorization + project publishing destination", ready: connections.linkedin.canPublish, configured: connections.linkedin.configured, connected: connections.linkedin.connected, needsSelection: connections.linkedin.connected && !connections.linkedin.canPublish, core: false },
    { id: "instagram", name: "Instagram", detail: connections.instagram.destinationName ? `Publishing account: ${connections.instagram.destinationName}` : connections.instagram.connected ? `Authorized portfolio: ${connections.instagram.accountLabel} · choose a project account` : "Professional-account posts and Reels", credential: "Instagram Unified Login authorization", ready: connections.instagram.canPublish, configured: connections.instagram.configured, connected: connections.instagram.connected, needsSelection: connections.instagram.connected && !connections.instagram.canPublish, core: false },
    { id: "tiktok", name: "TikTok", detail: connections.tiktok.connected ? `Authorized account: ${connections.tiktok.accountLabel}` : "Videos and photo posts; public publishing follows platform review", credential: "TikTok direct-post authorization", ready: connections.tiktok.canPublish, configured: connections.tiktok.configured, connected: connections.tiktok.connected, core: false },
    { id: "youtube", name: "YouTube", detail: connections.youtube.connected ? `Authorized channel: ${connections.youtube.accountLabel}` : "Long-form videos and Shorts uploaded only after item approval", credential: "YouTube channel upload and read-only analytics authorization", ready: connections.youtube.canPublish, configured: connections.youtube.configured, connected: connections.youtube.connected, core: false },
    { id: "x", name: "X", detail: connections.x.connected ? `Authorized account: ${connections.x.accountLabel}` : "Paid-plan publishing for approved text and image posts; X charges Market Agent per API request", credential: "Paid managed plan + X publishing authorization", ready: connections.x.canPublish, configured: connections.x.configured, connected: connections.x.connected, core: false },
    { id: "discord", name: "Discord", detail: connections.discord.connected ? `Authorized destination: ${connections.discord.accountLabel}` : "Approval-only announcements to one channel selected during connection", credential: "Discord channel webhook authorization", ready: connections.discord.canPublish, configured: connections.discord.configured, connected: connections.discord.connected, core: false },
    { id: "reddit", name: "Reddit", detail: connections.reddit.approvalRequired ? "Commercial Data API approval has been requested. Account connection stays disabled until Reddit grants written approval." : connections.reddit.canPublish ? `Community: ${connections.reddit.destinationName}` : connections.reddit.connected ? `Authorized account: ${connections.reddit.accountLabel}` : "Rule-aware community posts from the approval queue", credential: connections.reddit.approvalRequired ? "Reddit commercial Data API approval pending" : "Reddit account and community authorization", ready: connections.reddit.canPublish, configured: connections.reddit.configured, connected: connections.reddit.connected, needsSelection: connections.reddit.connected && !connections.reddit.canPublish, blockedReason: connections.reddit.approvalRequired ? "Approval pending" : undefined, core: false },
  ];
  const connectorAllowed = (id?: ConnectionProvider) => {
    if (!id) return true;
    if (id === "x") return accessMode === "managed";
    return accessMode === "byok" || accessMode === "managed" || (accessMode === "trial" && id === "linkedin");
  };
  const recommendedIds = recommendedConnectorIds(workspace);
  const visibleConnectors = (showAllConnections ? connectors : connectors.filter((connector) => connector.ready || (connector.id && recommendedIds.includes(connector.id)))).filter((connector) => !connector.core);
  const socialConnectorIds = ["linkedin", "instagram", "tiktok", "youtube", "x", "discord", "reddit"];
  const sectionConnectors = connectors.filter((connector) => connector.id && (section === "social" ? socialConnectorIds.includes(connector.id) : !socialConnectorIds.includes(connector.id)));
  const relevantNames = sectionConnectors.filter((connector) => connector.id && recommendedIds.includes(connector.id)).map((connector) => connector.name);
  const connectorSections = [
    { id: "measurement", title: "Measurement", description: "Traffic, acquisition, events, and performance data", ids: ["google-analytics"] },
    { id: "email", title: "Email & newsletters", description: "Mailbox delivery and consented audience campaigns", ids: ["google-gmail", "mailchimp"] },
    { id: "commerce", title: "Commerce", description: "Store content and approval-only product publishing", ids: ["shopify"] },
    { id: "social", title: "Social & communities", description: "Social publishing, video channels, and community destinations", ids: ["linkedin", "instagram", "tiktok", "youtube", "x", "discord", "reddit"] },
  ].filter((group) => section === "social" ? group.id === "social" : group.id !== "social").map((group) => ({ ...group, items: visibleConnectors.filter((connector) => connector.id && group.ids.includes(connector.id)) })).filter((group) => group.items.length > 0);
  return <div className="op-stack">
    <div className="op-heading"><div className="op-eyebrow">Private services and distribution</div><h1>Connections</h1><p>System services and private APIs are separated from the accounts that publish, send, sell, and measure.</p></div>
    <div className="op-integration-tabs" role="tablist" aria-label="Integration sections"><button role="tab" aria-selected={section === "services"} className={section === "services" ? "active" : ""} onClick={() => setSection("services")}><ChartColumn size={15} /><span><strong>Business services</strong><small>Analytics, email, newsletters, and commerce</small></span></button><button role="tab" aria-selected={section === "social"} className={section === "social" ? "active" : ""} onClick={() => setSection("social")}><Send size={15} /><span><strong>Social &amp; communities</strong><small>Social publishing, video, Discord, and Reddit</small></span></button><button role="tab" aria-selected={section === "system"} className={section === "system" ? "active" : ""} onClick={() => setSection("system")}><KeyRound size={15} /><span><strong>System &amp; APIs</strong><small>Cloud workspace, private APIs, and plan access</small></span></button></div>
    {section === "system" ? <>
    <section className={`op-runtime ${health.agentConfigured ? "ready" : ""}`}><span>{health.agentConfigured ? <Check size={21} /> : <KeyRound size={21} />}</span><div><strong>{accessMode === "managed" ? "Managed text plan is active" : accessMode === "trial" ? `10-day demo · ${billing.trial.daysRemaining} days remaining` : apiCredentials.collaborationReady ? "Three-way strategy review is ready" : health.agentConfigured ? `${apiCredentials.connectedCount} private ${apiCredentials.connectedCount === 1 ? "API is" : "APIs are"} connected` : "Choose an access option to begin"}</strong><p>{accessMode === "managed" ? "Research, strategy, campaigns, writing, and balanced review are active. Image and video creation require your own APIs." : accessMode === "trial" ? "Document analysis, campaign reasoning, and LinkedIn are available within demo limits. Image and video creation are excluded." : apiCredentials.collaborationReady ? "Three independent analyses can be combined into one balanced recommendation." : health.agentConfigured ? "Real work is enabled. Add the remaining private APIs for stronger cross-checking." : "Connect your APIs for full capabilities or activate the $29.99 monthly managed text plan."}</p></div></section>
    <section className={`op-managed-plan ${billing.active ? "active" : ""}`}><div className="op-managed-plan__icon"><CircleDollarSign size={21} /></div><div><small>MANAGED TEXT ACCESS</small><h2>{billing.active ? "Your $29.99 monthly plan is active" : "Use Market Agent’s managed APIs"}</h2><p>Text research, strategy, campaigns, writing, three-way review, and approval-only X publishing. Image and video creation are not included.</p><ul><li><Check size={13} />Pay monthly through PayPal</li><li><Check size={13} />X publishing included within fair-usage limits</li><li><Check size={13} />Usage limits protect service costs</li><li><X size={13} />No image or video generation</li></ul></div>{billing.active ? <button className="danger" onClick={onCancelPlan} disabled={billingBusy}>{billingBusy ? "Updating…" : "Cancel plan"}</button> : <button onClick={onSubscribe} disabled={billingBusy || !billing.configured}>{billingBusy ? "Opening PayPal…" : billing.configured ? "Subscribe · $29.99/month" : "PayPal setup pending"}</button>}</section>
    {!health.agentConfigured && <section className="op-starter-guide"><span><Sparkles size={19} /></span><div><small>STARTER ASSISTANT</small><strong>I’ll help you choose and connect the right access.</strong><p>The setup assistant remains available. Real project work requires an active demo, your own APIs, or the managed text plan.</p></div></section>}
    {userEmail.toLowerCase() === "unleash@evilcreatives.com" && !apiCredentials.collaborationReady && <section className="op-owner-restore"><KeyRound size={19} /><div><strong>Your deployment already has three private keys</strong><p>Transfer them directly from Vercel into this account’s encrypted vault. They will never be displayed or sent to the browser.</p></div><button onClick={() => void restoreOwnerCredentials()} disabled={Boolean(savingProvider)}>{savingProvider ? "Connecting…" : "Connect my stored keys"}</button></section>}
    <section className="op-api-vault"><div className="op-api-vault__head"><div><small>ACCOUNT-WIDE API VAULT</small><h2>Your private analysis connections</h2><p>One core API is required. Two improve coverage. All three unlock the strongest collaborative review. Your keys are isolated to your signed-in account.</p></div><span><ShieldCheck size={17} /> Encrypted</span></div><div className="op-api-vault__grid">{apiOptions.map((option) => { const saved = apiCredentials.credentials[option.provider]; const busy = savingProvider === option.provider; return <article key={option.provider} className={saved.connected ? "connected" : ""}><div className="op-api-card__title"><span><KeyRound size={16} /></span><div><strong>{option.name}</strong><small>{option.account}</small></div><em>{saved.connected ? "Saved" : option.provider === "anthropic" ? "Optional" : "Core"}</em></div><p>{option.detail}</p><a className="op-api-help" href={option.helpUrl} target="_blank" rel="noreferrer">Create or find key in {option.tier} <ArrowRight size={11} /></a>{saved.connected ? <div className="op-api-saved"><code>Key ending ••••{saved.hint}</code><div><button className="danger" onClick={() => void disconnectApiCredential(option.provider)} disabled={busy}>{busy ? "Removing…" : "Disconnect"}</button></div></div> : null}<label><span>{saved.connected ? "Paste a new key to replace it" : "Paste API key"}</span><div><input type="password" value={keyDrafts[option.provider]} onChange={(event) => setKeyDrafts((current) => ({ ...current, [option.provider]: event.target.value }))} placeholder="Your private API key" autoComplete="off" spellCheck={false} /><button onClick={() => void saveApiCredential(option.provider)} disabled={busy || !keyDrafts[option.provider].trim()}>{busy ? "Saving…" : saved.connected ? "Replace" : "Connect"}</button></div></label></article>; })}</div><div className="op-api-how"><div><strong>OpenAI</strong><p>Open the API keys page, create a secret key, copy it once, and paste it above.</p></div><div><strong>Gemini</strong><p>In Google Cloud, enable the Gemini API, open APIs &amp; Services → Credentials, create an API key, restrict it to that API, and paste it above.</p></div><div><strong>Claude</strong><p>Open the Anthropic Console key settings, create a key, copy it, and paste it above.</p></div></div><small className="op-api-vault__note">Keys are used only on the server for this account’s requests and scheduled work. The browser never stores them, and the interface shows only the final four characters after saving.</small></section>
    <section className="op-system-connection"><ServiceLogo provider="neon" name="Neon" /><div><small>SYSTEM CONNECTION</small><strong>Neon cloud workspace</strong><p>Private sign-in and cross-device database persistence. This is application infrastructure, not a publishing channel.</p></div><em className={health.databaseConfigured && health.authConfigured ? "ready" : ""}>{health.databaseConfigured && health.authConfigured ? "Operational" : "Setup required"}</em></section>
    </> : <>
    <section className="op-connection-view"><div><small>{showAllConnections ? "ALL AVAILABLE PROJECT SERVICES" : "RELEVANT TO THIS PROJECT"}</small><h2>{showAllConnections ? "Choose any project service" : relevantNames.length ? `Start with ${humanList(relevantNames)}` : "No extra services recommended yet"}</h2><p>{showAllConnections ? "Services are grouped by purpose below. Nothing is connected, sent, or published without your approval." : relevantNames.length ? "This shorter list is based only on the saved brand and project materials. The assistant can guide you one connection at a time." : "There is not enough grounded project evidence to recommend a service. You can still browse and connect one manually."}</p></div><button onClick={() => setShowAllConnections((current) => !current)}>{showAllConnections ? "Show relevant only" : `Browse all services (${connectors.length - 1})`}</button></section>
    <section className="op-account-separation"><UsersRound size={19} /><div><strong>One Market Agent login can manage different brand accounts</strong><p>You are signed into Market Agent as <b>{userEmail}</b>. The external account authorized below belongs only to <b>{workspace.name || "this project"}</b> and may use another email. A provider may ask you to sign in once to verify access; it does not create or change your Market Agent login.</p></div></section>
    <div className="op-connector-grid">{connectorSections.flatMap((connectorSection) => [<div className="op-connector-group-title" key={`${connectorSection.id}-title`}><div><strong>{connectorSection.title}</strong><small>{connectorSection.description}</small></div><em>{connectorSection.items.length}</em></div>, ...connectorSection.items.map((connector) => {
      const allowed = connectorAllowed(connector.id);
      const status = !allowed ? "Upgrade required" : connector.blockedReason || (connector.ready ? "Operational" : connector.authorized ? "Choose property" : connector.id === "linkedin" && connector.needsSelection ? "Choose destination" : connector.id === "instagram" && connector.needsSelection ? "Choose account" : connector.id === "reddit" && connector.needsSelection ? "Choose community" : connector.needsSelection ? "Choose audience" : connector.connected ? "Permission missing" : connector.configured ? "Ready to connect" : "Developer setup required");
      return <article key={connector.name} data-connector={connector.id || "core"} className={`${!allowed ? "locked" : ""}${highlightedConnector === connector.id ? " guided" : ""}`}>
        <div><ServiceLogo provider={connector.id} name={connector.name} /><div><strong>{connector.name}</strong><small>{connector.core ? "Cloud core" : connector.id === "google-analytics" ? "Measurement" : connector.id === "mailchimp" ? "Newsletter delivery" : connector.id === "shopify" ? "Commerce publishing" : "Delivery channel"}</small></div><em className={connector.ready ? "ready" : ""}>{status}</em></div>
        <p>{!allowed ? (connector.id === "x" ? "X charges per API request, so this connector is available only with the paid managed plan." : accessMode === "trial" ? "Only LinkedIn is included in the 10-day demo." : "Connect your APIs or activate the managed plan to use this connector.") : connector.detail}</p>
        <code>{connector.credential}</code>
        {allowed && connector.id === "google-analytics" && connector.authorized && (!connector.ready || editingAnalyticsProperty) && connections.analytics.properties.length > 0 && <div className="op-property-picker"><label><span>Property for this project</span><select aria-label="Google Analytics property" value={analyticsProperty} onChange={(event) => setAnalyticsProperty(event.target.value)}>{connections.analytics.properties.map((property) => <option key={property.id} value={property.id}>{property.account ? `${property.account} · ` : ""}{property.name} · {property.id}</option>)}</select></label><div className="op-property-picker__actions"><button onClick={() => void chooseAnalyticsProperty()} disabled={!analyticsProperty || analyticsProperty === connections.analytics.propertyId || Boolean(connecting)}>{connecting === "google-analytics" ? "Verifying property…" : "Use selected property"}</button>{connector.ready && <button className="secondary" onClick={() => { setAnalyticsProperty(connections.analytics.propertyId); setEditingAnalyticsProperty(false); }} disabled={Boolean(connecting)}>Cancel</button>}</div></div>}
        {allowed && connector.id === "google-analytics" && connector.authorized && !connector.ready && connections.analytics.properties.length === 0 && <div className="op-analytics-reconnect"><small>No Analytics properties were available to this Google account.</small><button className="op-connect-button" onClick={() => void connectAccount("google-analytics")} disabled={Boolean(connecting)}>{connecting === "google-analytics" ? "Opening Google…" : "Reconnect with another Google account"}</button></div>}
        {allowed && connector.id === "mailchimp" && connector.needsSelection && connections.mailchimp.audiences.length > 0 && <div className="op-property-picker"><label><span>Audience for this project</span><select aria-label="Mailchimp audience" value={mailchimpAudience} onChange={(event) => setMailchimpAudience(event.target.value)}>{connections.mailchimp.audiences.map((audience) => <option key={audience.id} value={audience.id}>{audience.name} · {audience.memberCount.toLocaleString()} subscribers</option>)}</select></label><button onClick={() => void chooseMailchimpAudience()} disabled={!mailchimpAudience || Boolean(connecting)}>{connecting === "mailchimp" ? "Selecting audience…" : "Use selected audience"}</button></div>}
        {allowed && connector.id === "linkedin" && connector.needsSelection && (connections.linkedin.destinations?.length || 0) > 0 && <div className="op-property-picker"><label><span>Publishing destination for this project</span><select aria-label="LinkedIn publishing destination" value={linkedInDestination} onChange={(event) => setLinkedInDestination(event.target.value)}><option value="">Choose a destination</option>{connections.linkedin.destinations?.map((destination) => <option key={destination.id} value={destination.id}>{destination.name} · {destination.label}</option>)}</select></label><button onClick={() => void chooseLinkedInDestination()} disabled={!linkedInDestination || Boolean(connecting)}>{connecting === "linkedin" ? "Selecting destination…" : "Use selected destination"}</button><small>{connections.linkedin.destinations?.some((destination) => destination.label.toLowerCase().includes("company")) ? "Company pages are recommended. A personal profile is used only when explicitly selected." : "Market Agent cannot access your company pages until LinkedIn approves its Community Management permission. This does not mean that your company page is missing. Personal-profile publishing remains optional and is never selected automatically."}</small></div>}
        {allowed && connector.id === "instagram" && connector.needsSelection && (connections.instagram.destinations?.length || 0) > 0 && <div className="op-property-picker"><label><span>Instagram account for this project</span><select aria-label="Instagram professional account" value={instagramDestination} onChange={(event) => setInstagramDestination(event.target.value)}><option value="">Choose an account</option>{connections.instagram.destinations?.map((destination) => <option key={destination.id} value={destination.id}>{destination.name} · {destination.label}</option>)}</select></label><button onClick={() => void chooseInstagramDestination()} disabled={!instagramDestination || Boolean(connecting)}>{connecting === "instagram" ? "Selecting account…" : "Use selected account"}</button><small>Only the professional account selected here is used for this project.</small></div>}
        {allowed && connector.id === "reddit" && connector.needsSelection && (connections.reddit.destinations?.length || 0) > 0 && <div className="op-property-picker"><label><span>Community for this project</span><select aria-label="Reddit community" value={redditCommunity} onChange={(event) => setRedditCommunity(event.target.value)}>{connections.reddit.destinations?.map((community) => <option key={community.id} value={community.id}>{community.name} · {community.label}</option>)}</select></label><button onClick={() => void chooseRedditCommunity()} disabled={!redditCommunity || Boolean(connecting)}>{connecting === "reddit" ? "Checking community…" : "Use selected community"}</button></div>}
        {allowed && connector.id === "reddit" && connector.needsSelection && !(connections.reddit.destinations?.length || 0) && <small>No eligible communities were returned by this account. Reconnect after Reddit approves the app’s community access.</small>}
        {allowed && connector.id === "shopify" && !connector.ready && <div className="op-shopify-connect"><input aria-label="Permanent Shopify store address" value={shopifyStore} onChange={(event) => setShopifyStore(event.target.value)} placeholder="store-name.myshopify.com" inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} /><button onClick={() => void connectAccount("shopify")} disabled={!connector.configured || !shopifyStore.trim() || Boolean(connecting)}>{!connector.configured ? "Setup required" : connecting === "shopify" ? "Opening…" : "Connect"}</button></div>}
        {allowed && connector.id && connector.id !== "shopify" && !connector.ready && !connector.needsSelection && !(connector.id === "google-analytics" && connector.authorized) && <button className="op-connect-button" onClick={() => void connectAccount(connector.id!)} disabled={!connector.configured || Boolean(connecting)}>{connector.blockedReason || (connector.configured ? (connecting === connector.id ? `Opening ${connector.name}…` : connector.connected ? `Reconnect ${connector.name}` : `Connect ${connector.name}`) : "Developer setup required")}</button>}
        {allowed && connector.id === "google-analytics" && connector.ready && !editingAnalyticsProperty && <div className="op-connector-actions"><button onClick={() => setEditingAnalyticsProperty(true)} disabled={Boolean(connecting)}>Change property</button><button onClick={() => void connectAccount("google-analytics")} disabled={Boolean(connecting)}>{connecting === "google-analytics" ? "Opening Google…" : "Reconnect Google account"}</button><button className="danger" onClick={() => void disconnectAccount("google-analytics", "Google Analytics")} disabled={Boolean(connecting)}>Disconnect</button></div>}
        {connector.id && connector.id !== "google-analytics" && connector.id !== "shopify" && connector.ready && <div className="op-connector-actions op-connector-actions--pair"><button onClick={() => void connectAccount(connector.id!)} disabled={Boolean(connecting)}>{connecting === connector.id ? `Opening ${connector.name}…` : "Change connected account"}</button><button className="danger" onClick={() => void disconnectAccount(connector.id!, connector.name)} disabled={Boolean(connecting)}>{connecting === connector.id ? "Working…" : "Disconnect"}</button></div>}
        {connector.id === "shopify" && connector.ready && <button className="op-disconnect-button" onClick={() => void disconnectAccount("shopify", connector.name)} disabled={Boolean(connecting)}>{connecting === "shopify" ? "Disconnecting…" : "Disconnect"}</button>}
        {connector.id === "reddit" && connector.connected && !connector.ready && <button className="op-disconnect-button" onClick={() => void disconnectAccount(connector.id!, connector.name)} disabled={Boolean(connecting)}>{connecting === connector.id ? "Disconnecting…" : "Disconnect"}</button>}
        {connector.id === "linkedin" && connector.connected && !connector.ready && <button className="op-disconnect-button" onClick={() => void disconnectAccount(connector.id!, connector.name)} disabled={Boolean(connecting)}>{connecting === connector.id ? "Disconnecting…" : "Disconnect"}</button>}
        {connector.id === "instagram" && connector.connected && !connector.ready && <button className="op-disconnect-button" onClick={() => void disconnectAccount(connector.id!, connector.name)} disabled={Boolean(connecting)}>{connecting === connector.id ? "Disconnecting…" : "Disconnect"}</button>}
      </article>;
    })])}</div>
    <section className="op-truth-card"><ShieldCheck size={20} /><div><strong>You remain in control of every external action</strong><p>Connections authorize access; they do not authorize unlimited activity. The agent acts only after item approval, one dated campaign approval, or a revocable standing permission for a supported organic channel. You are responsible for account authority, recipients, claims, rights, consent, platform compliance, and provider charges. See the <a href="/terms" target="_blank" rel="noreferrer">Terms of Service</a>.</p></div></section>
    </>}
  </div>;
}

const connectionLabels: Record<ConnectionProvider, string> = {
  "google-analytics": "Google Analytics",
  "google-gmail": "Gmail",
  mailchimp: "Mailchimp",
  shopify: "Shopify",
  linkedin: "LinkedIn",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
  discord: "Discord",
  reddit: "Reddit",
};

function humanList(values: string[]) {
  if (values.length <= 1) return values[0] || "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function connectionReadyForGuide(id: ConnectionProvider, connections: ConnectionStatus) {
  if (id === "google-analytics") return connections.analytics.canRead;
  if (id === "google-gmail") return connections.gmail.canSend;
  if (id === "mailchimp") return connections.mailchimp.canManage;
  if (id === "shopify") return connections.shopify.canManage;
  return connections[id].canPublish;
}

function connectionConfiguredForGuide(id: ConnectionProvider, connections: ConnectionStatus) {
  if (id === "google-analytics") return connections.analytics.configured;
  if (id === "google-gmail") return connections.gmail.configured;
  return connections[id].configured;
}

function connectionAllowedForGuide(id: ConnectionProvider, accessMode: "byok" | "managed" | "trial" | "expired") {
  if (id === "x") return accessMode === "managed";
  return accessMode === "byok" || accessMode === "managed" || (accessMode === "trial" && id === "linkedin");
}

function buildConnectionGuide(workspace: ProductWorkspace, connections: ConnectionStatus, accessMode: "byok" | "managed" | "trial" | "expired"): ConnectionGuide {
  const recommendedIds = recommendedConnectorIds(workspace);
  const recommendedNames = recommendedIds.map((id) => connectionLabels[id]);
  const readyNames = recommendedIds.filter((id) => connectionReadyForGuide(id, connections)).map((id) => connectionLabels[id]);
  const targetId = recommendedIds.find((id) => connectionAllowedForGuide(id, accessMode) && connectionConfiguredForGuide(id, connections) && !connectionReadyForGuide(id, connections) && !(id === "reddit" && connections.reddit.approvalRequired)) || null;
  const projectName = workspace.name || "this project";

  if (!recommendedIds.length) {
    return {
      message: `This is where you connect the accounts the agent may use. I do not yet have enough reliable evidence about ${projectName} to recommend a channel, so I will not guess. You can browse every available connection here now or return later.`,
      targetId: null,
      targetName: "",
      recommendedNames,
    };
  }

  const status = readyNames.length ? ` Already connected: ${humanList(readyNames)}.` : "";
  const nextStep = targetId
    ? ` I can guide you through ${connectionLabels[targetId]} now, or you can close this chat and connect it yourself later on this page.`
    : " There is no additional connection I can start for you right now; you can still browse the full list or return later.";
  return {
    message: `This is where you connect external accounts. Based only on the saved brand and project material for ${projectName}, I suggest starting with ${humanList(recommendedNames)}.${status}${nextStep}`,
    targetId,
    targetName: targetId ? connectionLabels[targetId] : "",
    recommendedNames,
  };
}

function recommendedConnectorIds(workspace: ProductWorkspace): ConnectionProvider[] {
  const context = [workspace.description, workspace.segmentation, workspace.positioning, workspace.audience, workspace.valueProposition, workspace.notes].join(" ").toLowerCase();
  const ids: ConnectionProvider[] = [];
  if (workspace.website) ids.push("google-analytics");
  if (/\b(b2b|business|businesses|professional|professionals|agency|agencies|enterprise|founder|founders|executive|executives|sales|recruit|recruiting)\b/.test(context)) ids.push("linkedin", "google-gmail");
  if (/\b(newsletter|subscriber|subscribers|community|updates|publication|editorial|membership|members|email marketing)\b/.test(context)) ids.push("mailchimp");
  // Shopify is a high-friction operational connection. Recommend it only when the
  // project explicitly sells through a store, not merely because its materials
  // mention products, retail clients, or product-related creative work.
  if (/\b(shopify|ecommerce|e-commerce|online store|online shop|web store|storefront|shopping cart|checkout|product catalog|inventory|sku|direct[- ]to[- ]consumer|dtc|merch(?:andise)? store)\b/.test(context)) ids.push("shopify");
  if (/\b(consumer|consumers|visual|fashion|beauty|food|restaurant|travel|hospitality|artist|artists|creative|event|events|lifestyle|retail)\b/.test(context)) ids.push("instagram");
  if (/\b(video|young|youth|gen z|creator|creators|entertainment|music|trend|trends)\b/.test(context)) ids.push("tiktok", "youtube");
  if (/\b(news|media|journalist|journalists|policy|politics|technology|developer|developers|real time|real-time)\b/.test(context)) ids.push("x");
  if (/\b(discord|community server|member chat|gaming community|fan community)\b/.test(context)) ids.push("discord");
  if (/\b(reddit|subreddit|forum|forums|peer discussion|enthusiast community)\b/.test(context)) ids.push("reddit");
  // Give the user a short starting set instead of turning every plausible signal
  // into a setup checklist. The complete connector catalog remains available.
  return Array.from(new Set(ids)).slice(0, 4);
}

function connectorRecommendationReason(id: string, workspace: ProductWorkspace) {
  const project = workspace.name || "this project";
  if (id === "google-analytics") return `${project} has a website, so verified traffic and conversion data can guide the agent.`;
  if (id === "mailchimp") return `The project scope includes an audience or recurring updates, so a consent-based newsletter is relevant.`;
  if (id === "google-gmail") return `The project appears to need direct, approved outreach from a real mailbox.`;
  if (id === "shopify") return `The project sells products online, so approved product drafts and store assets can be created directly in Shopify.`;
  if (id === "linkedin") return `The audience appears professional or business-focused, making LinkedIn the strongest first social channel.`;
  if (id === "instagram") return `The project is visually or consumer-led, so Instagram is likely to carry the strongest brand content.`;
  if (id === "tiktok") return `Short video or trend-led content appears relevant to the project’s audience.`;
  if (id === "youtube") return `The project can benefit from searchable video, demonstrations, or Shorts that remain useful beyond a single social feed.`;
  if (id === "discord") return `The project appears to have an active member community, so a selected Discord channel can receive approved updates.`;
  if (id === "reddit") return `The audience appears to gather in topic-led communities, so rule-aware Reddit participation may be useful.`;
  return `Fast public updates appear relevant to the project’s scope.`;
}

function Field({ label, value, onChange, placeholder, multiline = false, wide = false }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; multiline?: boolean; wide?: boolean }) {
  return <label className={wide ? "wide" : ""}><span>{label}</span>{multiline ? <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} /> : <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />}</label>;
}

type ReportSection = { heading: string; lines: string[] };

function MarkdownLite({ value, hideAction = false }: { value: string; hideAction?: boolean }) {
  const report = useMemo(() => parseReport(value), [value]);
  if (!report.sections.length) return <div className="op-markdown"><MarkdownBlocks lines={report.preamble} /></div>;
  const status = report.sections.find((section) => section.heading.toLowerCase() === "status");
  const nextAction = report.sections.find((section) => /next action/i.test(section.heading));
  const mainSections = report.sections.filter((section) => section !== status && section !== nextAction);
  const showTitle = Boolean(report.title && !/prepared|not launched/i.test(report.title));
  return <div className="op-markdown op-result-report">
    <section className="op-result-summary"><small>RESULT SUMMARY</small>{showTitle && <h1>{report.title}</h1>}{status && <MarkdownBlocks lines={status.lines} />}</section>
    {nextAction && !hideAction && <section className="op-result-next"><span><ArrowRight size={16} /></span><div><small>NEXT ACTION</small><MarkdownBlocks lines={nextAction.lines} /></div></section>}
    <div className="op-result-sections">{mainSections.map((section, index) => <details key={`${section.heading}-${index}`} open={/completed now|launch-ready queue/i.test(section.heading)}><summary><span>{String(index + 1).padStart(2, "0")}</span><strong>{section.heading}</strong><ChevronDown size={16} /></summary><div><MarkdownBlocks lines={section.lines} /></div></details>)}</div>
  </div>;
}

function parseReport(value: string) {
  const lines = value.split("\n");
  const preamble: string[] = [];
  const sections: ReportSection[] = [];
  let title = "";
  let current: ReportSection | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ") && !title) { title = trimmed.slice(2); continue; }
    if (trimmed.startsWith("## ")) {
      current = { heading: trimmed.slice(3), lines: [] };
      sections.push(current);
      continue;
    }
    (current?.lines || preamble).push(line);
  }
  return { title, preamble, sections };
}

function MarkdownBlocks({ lines }: { lines: string[] }) {
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed) { index += 1; continue; }
    if (trimmed.startsWith("### ")) { blocks.push(<h3 key={index}>{inlineMarkdown(trimmed.slice(4), `h-${index}`)}</h3>); index += 1; continue; }
    if (isTableRow(trimmed) && isTableSeparator(lines[index + 1] || "")) {
      const headers = parseTableRow(trimmed);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index].trim())) { rows.push(parseTableRow(lines[index].trim())); index += 1; }
      blocks.push(<div className="op-result-table-wrap" key={`table-${index}`}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inlineMarkdown(cell, `th-${index}-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inlineMarkdown(row[cellIndex] || "", `td-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) { items.push(lines[index].trim().replace(/^[-*]\s+/, "")); index += 1; }
      blocks.push(<ul key={`ul-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `li-${index}-${itemIndex}`)}</li>)}</ul>);
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) { items.push(lines[index].trim().replace(/^\d+\.\s+/, "")); index += 1; }
      blocks.push(<ol key={`ol-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, `oli-${index}-${itemIndex}`)}</li>)}</ol>);
      continue;
    }
    if (trimmed.startsWith(">")) {
      const quotes: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) { quotes.push(lines[index].trim().replace(/^>\s?/, "")); index += 1; }
      blocks.push(<blockquote key={`quote-${index}`}>{quotes.map((quote, quoteIndex) => <p key={quoteIndex}>{inlineMarkdown(quote, `q-${index}-${quoteIndex}`)}</p>)}</blockquote>);
      continue;
    }
    blocks.push(<p key={index}>{inlineMarkdown(trimmed, `p-${index}`)}</p>);
    index += 1;
  }
  return <>{blocks}</>;
}

function inlineMarkdown(text: string, keyPrefix: string) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\)|https?:\/\/[^\s<]+)/g;
  const parts = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith("**")) parts.push(<strong key={`${keyPrefix}-${match.index}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("`")) parts.push(<code key={`${keyPrefix}-${match.index}`}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("[")) {
      const linkMatch = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/);
      parts.push(linkMatch ? <a key={`${keyPrefix}-${match.index}`} href={linkMatch[2]} target="_blank" rel="noreferrer">{linkMatch[1]}</a> : token);
    } else parts.push(<a key={`${keyPrefix}-${match.index}`} href={token} target="_blank" rel="noreferrer">{token}</a>);
    cursor = match.index + token.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

function isTableRow(value: string) { return value.startsWith("|") && value.endsWith("|") && value.split("|").length >= 4; }
function isTableSeparator(value: string) { const cells = parseTableRow(value.trim()); return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell)); }
function parseTableRow(value: string) { return value.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()); }

function EmptyWorkspace({ onStart }: { onStart: () => void }) { return <div className="op-empty op-empty--compact"><span><BrainCircuit size={22} /></span><h2>No work for this project yet.</h2><p>Build the Brand from real sources, then run the agent. Research, campaigns, and content appear only after they are created.</p><button onClick={onStart}>Set up Brand <ArrowRight size={14} /></button></div>; }

function projectInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "NP";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function resizeLongFormTextarea(target: EventTarget | null) {
  if (!(target instanceof HTMLTextAreaElement)) return;
  if (target.closest(".op-command, .op-secretary-panel, .op-project-chat, .op-chat-composer, .op-newsletter-command")) return;
  target.style.height = "0px";
  target.style.height = `${Math.max(target.scrollHeight + 2, 72)}px`;
}

function workspaceCompleteness(workspace: ProductWorkspace) {
  const fields = [workspace.name, workspace.website, workspace.description, workspace.segmentation, workspace.positioning, workspace.manifesto, workspace.voice, workspace.guardrails, workspace.brand.lookAndFeel, workspace.brand.typography, workspace.brand.photographyStyle];
  const core = fields.filter((field) => field.trim().length > 8).length;
  return Math.min(100, Math.round((core / fields.length) * 85 + (workspace.sources.length ? 15 : 0)));
}
