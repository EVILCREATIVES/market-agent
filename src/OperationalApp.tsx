import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  Cloud,
  CircleAlert,
  FileCheck2,
  FileText,
  Globe2,
  ImageIcon,
  KeyRound,
  LayoutDashboard,
  Library,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquareText,
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
import { createDefaultSchedule, createEmptyProject, loadState, saveState } from "./operational/storage";
import { prepareLogo, prepareMaterial, type PreparedMaterial } from "./operational/materials";
import { upload } from "@vercel/blob/client";
import { apiFetch, getAccessToken } from "./auth";
import type { AgentAction, AgentRun, AgentSchedule, ApiCredentialStatus, ApiProvider, AppState, AssetProposal, ConnectionStatus, HealthState, MediaBudgetSummary, MediaJob, ProductSource, ProductWorkspace, ProjectAsset, ProjectChatMessage, RunStatus, SourceMediaAsset } from "./operational/types";

type Page = "agent" | "brain" | "research" | "campaigns" | "content" | "integrations";
type CampaignIntensity = "careful" | "assertive" | "aggressive";

const nav = [
  { id: "agent" as const, label: "Agent", icon: LayoutDashboard },
  { id: "brain" as const, label: "Product brain", icon: BrainCircuit },
  { id: "research" as const, label: "Research", icon: Search },
  { id: "campaigns" as const, label: "Campaigns", icon: Rocket },
  { id: "content" as const, label: "Content library", icon: Library },
  { id: "integrations" as const, label: "Integrations", icon: Settings2 },
];

const actionMeta: Record<AgentAction, { title: string; description: string }> = {
  research: { title: "Market research", description: "Current audience pain, alternatives, language, and opportunities" },
  campaign: { title: "Campaign execution pack", description: "Targets, final outreach, channel assets, tracking, and an executable schedule" },
  social: { title: "Social content pack", description: "Seven days of channel-specific posts and creative direction" },
  audience: { title: "Audience analysis", description: "Segments, triggers, objections, and ethical prospect signals" },
  chat: { title: "Custom agent run", description: "A specific marketing task for the active project" },
};

const emptyConnections = (): ConnectionStatus => ({
  gmail: { configured: false, connected: false, accountEmail: "", scopes: [], connectedAt: null, canSend: false },
  linkedin: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
  instagram: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
  tiktok: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
  x: { configured: false, connected: false, accountId: "", accountLabel: "", scopes: [], connectedAt: null, canPublish: false },
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

export default function OperationalApp({ userId, userEmail, onSignOut }: { userId: string; userEmail: string; onSignOut: () => Promise<void> }) {
  const [state, setState] = useState<AppState>(() => loadState(userId));
  const [page, setPage] = useState<Page>("agent");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>({ checked: false, apiOnline: false, agentConfigured: false, databaseConfigured: false, authConfigured: false, analyticsConfigured: false, mediaConfigured: false, model: "", runtime: "" });
  const [cloudReady, setCloudReady] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const [cloudSaving, setCloudSaving] = useState(false);
  const [connections, setConnections] = useState<ConnectionStatus>(() => emptyConnections());
  const [apiCredentials, setApiCredentials] = useState<ApiCredentialStatus>(() => emptyApiCredentials());
  const [projectChatOpen, setProjectChatOpen] = useState(false);

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
          await apiFetch("/api/state", { method: "POST", body: JSON.stringify({ state: next }) });
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
      apiFetch("/api/state", { method: "POST", body: JSON.stringify({ state }) })
        .then(async (response) => {
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Cloud save failed.");
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
    apiFetch(`/api/connections?projectId=${encodeURIComponent(state.activeProjectId)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Connections could not be checked.");
        setConnections(data as ConnectionStatus);
      })
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
      .catch(() => setApiCredentials(emptyApiCredentials()));
  }, [cloudReady]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("connection");
    if (!result) return;
    setPage("integrations");
    const labels: Record<string, string> = { gmail: "Mailbox", linkedin: "LinkedIn", instagram: "Instagram", tiktok: "TikTok", x: "X" };
    const provider = result.replace(/-success$/, "");
    setToast(result.endsWith("-success") ? `${labels[provider] || "Account"} connected securely.` : params.get("reason") || "Account connection failed.");
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  };

  const activeProject = state.projects.find((project) => project.id === state.activeProjectId) || state.projects[0];
  const projectRuns = state.runs.filter((run) => run.projectId === activeProject.id);
  const activeSchedule = state.schedules[activeProject.id] || createDefaultSchedule();
  const runtimeReady = apiCredentials.ready;

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
  const updateRunStatus = (id: string, status: RunStatus) => setState((current) => ({ ...current, runs: current.runs.map((run) => run.id === id ? { ...run, status } : run) }));
  const updateRunOutput = (id: string, output: string) => setState((current) => ({ ...current, runs: current.runs.map((run) => run.id === id ? { ...run, output } : run) }));
  const deleteRun = (id: string) => {
    setState((current) => ({ ...current, runs: current.runs.filter((run) => run.id !== id) }));
    if (selectedRunId === id) setSelectedRunId(null);
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
  const completeness = workspaceCompleteness(activeProject);

  if (cloudError && !cloudReady) {
    return <div className="full-message"><span><CircleAlert size={24} /></span><h1>Cloud workspace unavailable</h1><p>{cloudError}</p><button onClick={() => window.location.reload()}>Try again</button><button className="secondary" onClick={() => void onSignOut()}>Sign out</button></div>;
  }
  if (!cloudReady) {
    return <div className="full-message"><span><LoaderCircle className="spin" size={24} /></span><h1>Loading Market Agent</h1><p>Opening your secure cloud workspace…</p></div>;
  }

  return (
    <div className="op-shell">
      <aside className={`op-sidebar ${mobileOpen ? "op-sidebar--open" : ""}`}>
        <div className="op-brand"><span><Sparkles size={18} /></span><strong>Market Agent</strong><button onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
        <div className="op-project-switcher">
          <button className="op-workspace" onClick={() => setProjectMenuOpen((open) => !open)} aria-expanded={projectMenuOpen}>
            <span>{projectInitials(activeProject.name)}</span><div><small>Active project</small><strong>{activeProject.name || "Unnamed project"}</strong></div><ChevronDown size={15} />
          </button>
          {projectMenuOpen && <div className="op-project-menu"><div className="op-project-menu__head"><span>Projects</span><small>{state.projects.length}</small></div>{state.projects.map((project) => <button key={project.id} className={project.id === activeProject.id ? "active" : ""} onClick={() => switchProject(project.id)}><span>{projectInitials(project.name)}</span><div><strong>{project.name || "Unnamed project"}</strong><small>{project.id === activeProject.id ? "Active" : "Switch project"}</small></div>{project.id === activeProject.id && <Check size={14} />}</button>)}<button className="op-project-add" onClick={createProject}><Plus size={14} /> Create new project</button></div>}
        </div>
        <nav>{nav.map((item) => { const Icon = item.icon; const count = item.id === "research" ? projectRuns.filter((r) => ["research", "audience"].includes(r.action)).length : item.id === "campaigns" ? projectRuns.filter((r) => r.action === "campaign").length : item.id === "content" ? projectRuns.filter((r) => r.action === "social").length : 0; return <button key={item.id} className={page === item.id ? "active" : ""} onClick={() => navigate(item.id)}><Icon size={17} /><span>{item.label}</span>{count > 0 && <em>{count}</em>}</button>; })}</nav>
        <div className="op-sidebar__bottom"><div className={`op-api-dot ${runtimeReady ? "ready" : ""}`} /><div><strong>{runtimeReady ? "Agent ready" : "Connect your APIs"}</strong><small>{runtimeReady ? "Private analysis service" : "Open Connections"}</small></div></div>
      </aside>

      <main className="op-main">
        <header className="op-topbar"><button className="op-mobile-menu" onClick={() => setMobileOpen(true)}><Menu size={20} /></button><div className="op-product-state"><span className={completeness >= 60 ? "good" : ""}>{completeness}%</span><div><strong>Product brain</strong><small>{completeness >= 60 ? "Ready for grounded work" : "Needs product context"}</small></div></div><div className="op-topbar__right"><span className={`op-status ${runtimeReady ? "op-status--ready" : ""}`}><i />{runtimeReady ? "Live agent" : "Connect your APIs"}</span><span className="op-cloud-state"><Cloud size={14} />{cloudSaving ? "Saving…" : cloudError ? "Save issue" : "Saved"}</span><button className="op-user-button" title={userEmail} onClick={() => void onSignOut()}><LogOut size={15} /> Sign out</button></div></header>

        <div className="op-page">
          {selectedRunId ? <RunDetail run={state.runs.find((run) => run.id === selectedRunId)!} connections={connections} onBack={() => setSelectedRunId(null)} onConnect={() => navigate("integrations")} onStatus={updateRunStatus} onOutput={updateRunOutput} onDelete={deleteRun} notify={notify} /> : <>
            {page === "agent" && <AgentHome workspace={activeProject} runs={projectRuns} health={{ ...health, agentConfigured: runtimeReady }} connections={connections} onRun={addRun} onOpen={setSelectedRunId} onNavigate={navigate} notify={notify} />}
            {page === "brain" && <ProductBrain key={activeProject.id} workspace={activeProject} onSave={updateWorkspace} notify={notify} />}
            {page === "research" && <RunLibrary title="Research" description={`Live market and audience work generated from ${activeProject.name || "this project"}'s product brain.`} empty="No research has been run for this project yet." runs={projectRuns.filter((run) => ["research", "audience"].includes(run.action))} onOpen={setSelectedRunId} onStart={() => navigate("agent")} />}
            {page === "campaigns" && <RunLibrary title="Campaigns" description="Campaign plans become real project records here—never fictional performance." empty="No campaigns have been generated for this project yet." runs={projectRuns.filter((run) => run.action === "campaign")} onOpen={setSelectedRunId} onStart={() => navigate("agent")} />}
            {page === "content" && <ContentLibrary userId={userId} workspace={activeProject} runs={projectRuns.filter((run) => run.action === "social")} mediaConfigured={apiCredentials.mediaReady} videoConfigured={apiCredentials.videoReady} onOpen={setSelectedRunId} onStart={() => navigate("agent")} notify={notify} />}
            {page === "integrations" && <OperationalIntegrations projectId={activeProject.id} userEmail={userEmail} health={{ ...health, agentConfigured: runtimeReady, mediaConfigured: apiCredentials.mediaReady }} apiCredentials={apiCredentials} onApiCredentials={setApiCredentials} connections={connections} schedule={activeSchedule} onSchedule={updateSchedule} notify={notify} />}
          </>}
        </div>
      </main>
      {mobileOpen && <button className="op-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <ProjectChat workspace={activeProject} open={projectChatOpen} onOpen={() => setProjectChatOpen(true)} onClose={() => setProjectChatOpen(false)} onSave={updateWorkspace} notify={notify} />
      {toast && <div className="op-toast"><Sparkles size={15} />{toast}<button onClick={() => setToast(null)}><X size={14} /></button></div>}
    </div>
  );
}

function ProjectChat({ workspace, open, onOpen, onClose, onSave, notify }: { workspace: ProductWorkspace; open: boolean; onOpen: () => void; onClose: () => void; onSave: (workspace: ProductWorkspace) => void; notify: (message: string) => void }) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messages = workspace.chatMessages || [];

  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [open, messages.length, sending]);

  useEffect(() => setDraft(""), [workspace.id]);

  const send = async () => {
    const content = draft.trim();
    if (!content || sending) return;
    const userMessage: ProjectChatMessage = { id: crypto.randomUUID(), role: "user", content, createdAt: new Date().toISOString() };
    const nextHistory = [...messages, userMessage].slice(-80);
    onSave({ ...workspace, chatMessages: nextHistory, updatedAt: new Date().toISOString() });
    setDraft("");
    setSending(true);
    try {
      const response = await apiFetch("/api/chat", { method: "POST", body: JSON.stringify({ workspace: { ...workspace, chatMessages: nextHistory }, history: nextHistory, message: content, useWeb: false }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The project assistant could not reply.");
      const assistantMessage: ProjectChatMessage = { id: crypto.randomUUID(), role: "assistant", content: String(data.reply || "I saved that."), createdAt: data.createdAt || new Date().toISOString() };
      onSave({ ...workspace, chatMessages: [...nextHistory, assistantMessage].slice(-80), updatedAt: new Date().toISOString() });
    } catch (error) {
      notify(error instanceof Error ? error.message : "The project assistant could not reply.");
    } finally {
      setSending(false);
    }
  };

  return <>
    {!open && <button className="op-project-chat-launcher" onClick={onOpen} aria-label="Open project chat"><MessageSquareText size={20} /><span><strong>Ask the agent</strong><small>It remembers this project</small></span></button>}
    {open && <aside className="op-project-chat" aria-label="Project chat">
      <header><span><Sparkles size={17} /></span><div><strong>Project agent</strong><small>{workspace.name || "Current project"} · memory on</small></div><button onClick={onClose} aria-label="Close project chat"><X size={17} /></button></header>
      <div className="op-project-chat__messages" ref={scrollRef}>
        {messages.length === 0 && <div className="assistant"><span><Sparkles size={13} /></span><p>I’m here throughout the workspace. Ask me anything, correct the strategy, or give me an instruction—I’ll answer and remember it for this project.</p></div>}
        {messages.map((message) => <div className={message.role} key={message.id}><span>{message.role === "assistant" ? <Sparkles size={13} /> : "You"}</span><p>{message.content}</p></div>)}
        {sending && <div className="assistant thinking"><span><LoaderCircle className="spin" size={13} /></span><p>Reading the project and your message…</p></div>}
      </div>
      <div className="op-project-chat__composer"><textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="Ask, correct, or instruct the agent…" /><button onClick={() => void send()} disabled={!draft.trim() || sending} aria-label="Send message"><Send size={16} /></button></div>
    </aside>}
  </>;
}

function AgentHome({ workspace, runs, health, connections, onRun, onOpen, onNavigate, notify }: { workspace: ProductWorkspace; runs: AgentRun[]; health: HealthState; connections: ConnectionStatus; onRun: (run: AgentRun) => void; onOpen: (id: string) => void; onNavigate: (page: Page) => void; notify: (message: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState<AgentAction | null>(null);
  const [useWeb, setUseWeb] = useState(true);
  const [balancedPanel, setBalancedPanel] = useState(true);
  const [pendingCampaign, setPendingCampaign] = useState<{ action: AgentAction; direction: string } | null>(null);
  const complete = workspaceCompleteness(workspace);
  const connectedChannels = [
    connections.gmail.connected && "Email",
    connections.linkedin.connected && "LinkedIn",
    connections.instagram.connected && "Instagram",
    connections.tiktok.connected && "TikTok",
    connections.x.connected && "X",
  ].filter(Boolean) as string[];

  const executeRun = async (action: AgentAction, direction: string, intensity: CampaignIntensity) => {
    setRunning(action);
    try {
      const response = await apiFetch("/api/agent", { method: "POST", body: JSON.stringify({ action, prompt: direction, workspace, projectId: workspace.id, useWeb, mode: balancedPanel ? "panel" : "single", intensity }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Agent run failed.");
      onRun(data.run as AgentRun);
      setPrompt("");
      notify("Real agent run completed and saved.");
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
    <section><div className="op-section-head"><div><span>Run a complete workflow</span><h2>Real work, saved to the workspace</h2></div></div><div className="op-action-grid">{(["research", "audience", "campaign", "social"] as AgentAction[]).map((action) => { const icons = { research: Globe2, audience: UsersRound, campaign: Rocket, social: MessageSquareText, chat: Bot }; const Icon = icons[action]; return <button key={action} onClick={() => requestRun(action)} disabled={Boolean(running)}><span><Icon size={19} /></span><div><strong>{actionMeta[action].title}</strong><p>{actionMeta[action].description}</p></div>{running === action ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}</button>; })}</div></section>
    <section><div className="op-section-head"><div><span>Workspace record</span><h2>Recent work</h2></div><small>{runs.length} saved {runs.length === 1 ? "run" : "runs"}</small></div>{runs.length ? <div className="op-run-list">{runs.slice(0, 6).map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div> : <EmptyWorkspace onStart={() => onNavigate("brain")} />}</section>
  </div>{pendingCampaign && <><button className="op-intensity-scrim" aria-label="Close campaign style question" onClick={() => setPendingCampaign(null)} /><aside className="op-intensity-panel"><header><span><Rocket size={18} /></span><div><small>One campaign decision</small><strong>How aggressive should this campaign be?</strong></div><button aria-label="Close" onClick={() => setPendingCampaign(null)}><X size={17} /></button></header><div className="op-intensity-body"><p>The agent will do the research, targeting, copy, sequence, and tracking. Choose the pace and pressure.</p><button className="aggressive" onClick={() => chooseIntensity("aggressive")}><span><strong>Aggressive</strong><em>Recommended for this goal</em></span><small>Large first wave, parallel channels, direct commercial language, strong calls to action, fast follow-up.</small><ArrowRight size={16} /></button><button onClick={() => chooseIntensity("assertive")}><span><strong>Assertive</strong></span><small>Meaningful volume, decisive messaging, and fast execution with regular review points.</small><ArrowRight size={16} /></button><button onClick={() => chooseIntensity("careful")}><span><strong>Careful</strong></span><small>Smaller waves, softer calls to action, and more validation before scaling.</small><ArrowRight size={16} /></button><div className="op-intensity-note"><ShieldCheck size={15} /><span>Aggressive changes speed and tactics—not truthfulness, consent, or opt-out rules.</span></div></div></aside></>}</>;
}

function isCampaignRequest(action: AgentAction, direction: string) {
  return action === "campaign" || /\b(campaign|outreach|buyer|buyers|prospect|prospects|lead|leads|pipeline|acquisition|sales|launch|demo shares?|reach\s+\d|growth)\b/i.test(direction);
}

function ProductBrain({ workspace, onSave, notify }: { workspace: ProductWorkspace; onSave: (workspace: ProductWorkspace) => void; notify: (message: string) => void }) {
  const [form, setForm] = useState<ProductWorkspace>(workspace);
  const [materials, setMaterials] = useState<PreparedMaterial[]>([]);
  const [links, setLinks] = useState<string[]>(() => workspace.sources.map((source) => source.url));
  const [linkInput, setLinkInput] = useState("");
  const [processing, setProcessing] = useState(false);
  const [building, setBuilding] = useState(false);
  const [intakeError, setIntakeError] = useState("");
  const [reviewOpen, setReviewOpen] = useState(() => workspaceCompleteness(workspace) > 20);
  const [reviewSummary, setReviewSummary] = useState(workspace.reviewSummary || "");
  const [unknowns, setUnknowns] = useState<string[]>(() => filterSourceBackedBrandQuestions(workspace.openQuestions || [], workspace));
  const [answers, setAnswers] = useState<Record<string, string>>(workspace.questionAnswers || {});
  const [additionalContext, setAdditionalContext] = useState(workspace.additionalContextDraft || "");
  const [refining, setRefining] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(() => filterSourceBackedBrandQuestions(workspace.openQuestions || [], workspace).length > 0);
  const [questionIndex, setQuestionIndex] = useState(() => {
    const questions = filterSourceBackedBrandQuestions(workspace.openQuestions || [], workspace);
    const savedAnswers = workspace.questionAnswers || {};
    return firstUnhandledQuestionIndex(questions, savedAnswers);
  });
  const [chatDraft, setChatDraft] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const change = (field: keyof ProductWorkspace, value: string) => setForm((current) => ({ ...current, [field]: value }));
  const changeBrand = (field: keyof ProductWorkspace["brand"], value: string) => setForm((current) => ({ ...current, brand: { ...current.brand, [field]: value } }));

  const uploadLogo = async (file?: File) => {
    if (!file) return;
    try {
      const logoDataUrl = await prepareLogo(file);
      setForm((current) => ({ ...current, brand: { ...current.brand, logoDataUrl, logoName: file.name } }));
      setIntakeError("");
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "The logo could not be read.");
    }
  };

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
      if (!response.ok) throw new Error(data.error || "The product brain could not be built.");
      const retainedAnswers = { ...(form.questionAnswers || {}), ...answers };
      const nextQuestions = filterHandledQuestions(Array.isArray(data.unknowns) ? data.unknowns : [], retainedAnswers);
      const sources: ProductSource[] = pendingLinks.map((url) => ({ id: crypto.randomUUID(), label: connectedSourceLabel(url), url }));
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
      })).filter((item: SourceMediaAsset) => /^https?:\/\//i.test(item.url));
      const sourceMedia = [...extractedMedia, ...(workspace.sourceMedia || [])]
        .filter((item, index, all) => all.findIndex((candidate) => candidate.url === item.url) === index)
        .slice(0, 40);
      const updated: ProductWorkspace = {
        ...form,
        ...data.brain,
        brand: { ...form.brand, ...(data.brain?.brand || {}) },
        sources,
        materials: materialRecords,
        sourceMedia,
        reviewSummary: data.reviewSummary || "The product brain is ready for review.",
        openQuestions: nextQuestions,
        questionAnswers: retainedAnswers,
        additionalContextDraft: "",
        sourceWarnings: Array.isArray(data.sourceWarnings) ? data.sourceWarnings : [],
        updatedAt: addedAt,
      };
      setForm(updated);
      onSave(updated);
      setReviewSummary(data.reviewSummary || "The product brain is ready for review.");
      setUnknowns(nextQuestions);
      setAnswers(retainedAnswers);
      setQuestionIndex(firstUnhandledQuestionIndex(nextQuestions, retainedAnswers));
      setChatDraft("");
      setAssistantOpen(nextQuestions.length > 0);
      setReviewOpen(true);
      setMaterials([]);
      notify("Product brain built and saved. Review only what needs correction.");
    } catch (error) {
      setIntakeError(error instanceof Error ? error.message : "The product brain could not be built.");
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
      const updated: ProductWorkspace = {
        ...form,
        ...data.brain,
        brand: { ...form.brand, ...(data.brain?.brand || {}) },
        reviewSummary: data.reviewSummary || "Your answers have been applied.",
        openQuestions: nextQuestions,
        questionAnswers: retainedAnswers,
        additionalContextDraft: "",
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
      notify("Your answers were applied and the product brain was updated.");
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
    const protectedFields = Array.from(new Set([...(form.protectedFields || []), ...changedBrainFields(workspace, form)]));
    const updated = { ...form, protectedFields, sources: links.map((url) => ({ id: crypto.randomUUID(), label: connectedSourceLabel(url), url })), updatedAt: new Date().toISOString() };
    onSave(updated);
    setForm(updated);
    notify("Corrections saved to the cloud.");
  };

  const savedMaterials = workspace.materials || [];
  const hasBrain = workspaceCompleteness(form) > 20;
  const canApplyAnswers = Boolean(additionalContext.trim()) || unknowns.some((question) => isQuestionHandled(answers, question));

  return <div className="op-stack op-brain-onboarding">
    <div className="op-heading"><div className="op-eyebrow">Project onboarding</div><h1>Give Market Agent the material.<br />It will build the product brain.</h1><p>Upload what already exists or connect the source links. You review and correct the result—you do not have to rewrite your project into a form.</p></div>

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
          <div className="op-connector-pills"><span>Google Slides</span><span>Figma</span><span>Website</span></div>
          <div className="op-link-entry"><input value={linkInput} onChange={(event) => setLinkInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addLink(); } }} placeholder="Paste a Google Slides, Figma, or website link" /><button onClick={addLink}><Plus size={15} /> Add</button></div>
          <p>External-view Google Slides and Figma decks are read directly. If link access is off, Market Agent will tell you exactly what to enable.</p>
        </div>
      </div>

      {(materials.length > 0 || links.length > 0 || savedMaterials.length > 0) && <div className="op-material-list">
        {savedMaterials.map((material) => <div key={material.id} className="saved"><FileCheck2 size={16} /><span><strong>{material.name}</strong><small>Already included</small></span><Check size={14} /></div>)}
        {materials.map((material, index) => <div key={`${material.name}-${index}`}><MaterialIcon kind={material.kind} /><span><strong>{material.name}</strong><small>{material.detail}</small></span><button onClick={() => setMaterials((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={14} /></button></div>)}
        {links.map((url) => <div key={url}><Globe2 size={16} /><span><strong>{connectedSourceLabel(url)}</strong><small>{url}</small></span><button onClick={() => setLinks((current) => current.filter((item) => item !== url))}><X size={14} /></button></div>)}
      </div>}

      {(form.sourceMedia || []).length > 0 && <SourceMediaStrip media={form.sourceMedia || []} />}

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
      <div className="op-build-row"><div><strong>{hasBrain ? "Update the product brain" : "Build the product brain for me"}</strong><span>The agent extracts the facts, audience, positioning, voice, and guardrails.</span></div><button disabled={building || processing || (!materials.length && !links.length && !linkInput.trim())} onClick={() => void build()}>{building ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{building ? "Building…" : hasBrain ? "Update from sources" : "Build it for me"}</button></div>
    </section>

    {form.sourceWarnings.length > 0 && <section className="op-source-warning"><CircleAlert size={18} /><div><strong>Some connected sources need access</strong>{form.sourceWarnings.map((warning) => <p key={warning}>{warning}</p>)}</div></section>}

    {(reviewSummary || unknowns.length > 0) && <section className="op-brain-result"><Check size={20} /><div><strong>{reviewSummary || "Product brain ready"}</strong>{unknowns.length > 0 && <span>{unknowns.length} {unknowns.length === 1 ? "detail needs" : "details need"} your confirmation.</span>}</div>{unknowns.length > 0 && <button onClick={() => setAssistantOpen(true)}><MessageSquareText size={15} /> Continue with project assistant</button>}</section>}

    <section className={`op-review-editor ${reviewOpen ? "open" : ""}`}>
      <button className="op-review-toggle" onClick={() => setReviewOpen((open) => !open)}><span><strong>Review and correct the product brain</strong><small>Only change what the agent misunderstood or could not find.</small></span><ChevronDown size={18} /></button>
      {reviewOpen && <div className="op-form-card">
        <section className="op-brand-editor">
          <div className="op-card-head"><div><strong>Brand identity</strong><small>Inferred from your material and fully editable</small></div><ImageIcon size={19} /></div>
          <div className="op-brand-grid">
            <div className="op-logo-editor">
              <input ref={logoInput} hidden type="file" accept="image/*" onChange={(event) => void uploadLogo(event.target.files?.[0])} />
              <button onClick={() => logoInput.current?.click()}>{form.brand.logoDataUrl ? <img src={form.brand.logoDataUrl} alt="Project logo" /> : <><UploadCloud size={24} /><strong>Upload logo</strong><span>PNG, JPG, or WebP</span></>}</button>
              {form.brand.logoDataUrl && <div><span>{form.brand.logoName || "Project logo"}</span><button onClick={() => setForm((current) => ({ ...current, brand: { ...current.brand, logoDataUrl: "", logoName: "" } }))}>Remove</button></div>}
            </div>
            <div className="op-color-editor">
              <strong>Brand hues</strong>
              <small>Chromatic identity colors—not backgrounds or text.</small>
              <BrandColorField label="Primary" value={form.brand.primaryColor} onChange={(value) => changeBrand("primaryColor", value)} />
              <BrandColorField label="Secondary" value={form.brand.secondaryColor} onChange={(value) => changeBrand("secondaryColor", value)} />
              <BrandColorField label="Accent" value={form.brand.accentColor} onChange={(value) => changeBrand("accentColor", value)} />
              <strong className="neutral-title">Neutrals</strong>
              <small>Background and typography values.</small>
              <BrandColorField label="Light" value={form.brand.neutralLightColor} fallback="#ffffff" onChange={(value) => changeBrand("neutralLightColor", value)} />
              <BrandColorField label="Dark" value={form.brand.neutralDarkColor} fallback="#222222" onChange={(value) => changeBrand("neutralDarkColor", value)} />
            </div>
            <div className="op-brand-fields"><Field label="Typography" value={form.brand.typography} onChange={(value) => changeBrand("typography", value)} placeholder="Typefaces and hierarchy" multiline /><Field label="Imagery style" value={form.brand.imageryStyle} onChange={(value) => changeBrand("imageryStyle", value)} placeholder="Photography, illustration, composition" multiline /><Field wide label="Visual identity notes" value={form.brand.notes} onChange={(value) => changeBrand("notes", value)} placeholder="Logo rules, spacing, motifs, usage guidance" multiline /></div>
          </div>
        </section>
        <div className="op-form-grid"><Field label="Project or product name" value={form.name} onChange={(value) => change("name", value)} placeholder="Project name" /><Field label="Website" value={form.website} onChange={(value) => change("website", value)} placeholder="https://…" /><Field wide label="What does the project do?" value={form.description} onChange={(value) => change("description", value)} placeholder="The agent will draft this from your material" multiline /><Field wide label="Primary audience" value={form.audience} onChange={(value) => change("audience", value)} placeholder="The agent will identify the audience" multiline /><Field wide label="Value proposition" value={form.valueProposition} onChange={(value) => change("valueProposition", value)} placeholder="The agent will synthesize the positioning" multiline /><Field label="Brand voice" value={form.voice} onChange={(value) => change("voice", value)} placeholder="Inferred from your material" multiline /><Field label="Claims and guardrails" value={form.guardrails} onChange={(value) => change("guardrails", value)} placeholder="Approved proof and prohibited claims" multiline /><Field wide label="Uncertainties and additional notes" value={form.notes} onChange={(value) => change("notes", value)} placeholder="Items to verify or add" multiline /></div>
        <div className="op-form-actions"><span>Last saved {new Date(workspace.updatedAt).toLocaleString()} · Saved corrections are protected from source updates.</span><button onClick={save}><Save size={15} /> Save corrections</button></div>
      </div>}
    </section>

    {assistantOpen && unknowns.length > 0 && <aside className="op-secretary-panel">
      <header><div><span><Sparkles size={16} /></span><div><strong>Project assistant</strong><small>{Math.min(questionIndex + 1, unknowns.length)} of {unknowns.length} confirmations</small></div></div><button aria-label="Close project assistant" onClick={() => setAssistantOpen(false)}><X size={17} /></button></header>
      <div className="op-secretary-chat">
        {reviewSummary && <div className="assistant"><span><Sparkles size={13} /></span><p>{reviewSummary}</p></div>}
        {unknowns.slice(0, questionIndex).map((question) => <div className="op-chat-exchange" key={question}><div className="assistant"><span><Sparkles size={13} /></span><p>{question}</p></div>{answers[question] && answers[question] !== SKIPPED_ANSWER ? <div className="user"><p>{answers[question]}</p></div> : <div className="skipped">Not known—won’t ask again</div>}</div>)}
        {questionIndex < unknowns.length ? <div className="assistant current"><span><Sparkles size={13} /></span><p>{unknowns[questionIndex]}</p></div> : <div className="assistant current"><span><Check size={13} /></span><p>That is enough for me to update the product brain. Add anything else you want me to know, or apply the answers now.</p></div>}
      </div>
      {questionIndex < unknowns.length ? <div className="op-chat-composer"><textarea autoFocus value={chatDraft} onChange={(event) => setChatDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChatAnswer(); } }} placeholder="Answer naturally…" /><div><button className="secondary" onClick={skipChatQuestion}>I don’t know</button><button disabled={!chatDraft.trim()} onClick={sendChatAnswer}>Send <Send size={14} /></button></div></div> : <div className="op-chat-composer final"><textarea value={additionalContext} onChange={(event) => updateAdditionalContext(event.target.value)} placeholder="Anything else? Optional." /><button disabled={refining || !canApplyAnswers} onClick={() => void applyAnswers()}>{refining ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{refining ? "Updating…" : "Apply answers"}</button></div>}
    </aside>}
  </div>;
}

function MaterialIcon({ kind }: { kind: PreparedMaterial["kind"] }) {
  if (kind === "image") return <ImageIcon size={16} />;
  if (kind === "video") return <Video size={16} />;
  return <FileText size={16} />;
}

function SourceMediaStrip({ media }: { media: SourceMediaAsset[] }) {
  return <div className="op-source-media"><header><div><strong>Useful media extracted</strong><span>Saved with this project for future content and campaign work.</span></div><em>{media.length}</em></header><div>{media.slice(0, 12).map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer">{item.kind === "image" ? <img src={item.url} alt="" /> : <span className="video"><Video size={18} /></span>}<div><strong>{item.name}</strong><small>{item.role} · {item.recommendation}</small><span>{item.tags.slice(0, 3).join(" · ")}</span></div><ArrowRight size={13} /></a>)}</div></div>;
}

function connectedSourceLabel(value: string) {
  try {
    const hostname = new URL(value).hostname.replace(/^www\./, "");
    if (hostname.includes("docs.google.com")) return "Google Slides";
    if (hostname.includes("figma.com")) return "Figma";
    return hostname;
  } catch {
    return "Source link";
  }
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
  return Object.entries(answers).some(([askedQuestion, answer]) => Boolean(answer) && questionsMatch(askedQuestion, question));
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
  "name", "website", "description", "audience", "valueProposition", "voice", "guardrails", "notes",
  "brand.primaryColor", "brand.secondaryColor", "brand.accentColor", "brand.neutralLightColor", "brand.neutralDarkColor", "brand.typography", "brand.imageryStyle", "brand.notes",
] as const;

function changedBrainFields(before: ProductWorkspace, after: ProductWorkspace) {
  return PROTECTABLE_BRAIN_FIELDS.filter((path) => brainFieldValue(before, path) !== brainFieldValue(after, path));
}

function brainFieldValue(workspace: ProductWorkspace, path: typeof PROTECTABLE_BRAIN_FIELDS[number]) {
  if (path.startsWith("brand.")) return String(workspace.brand?.[path.slice(6) as keyof ProductWorkspace["brand"]] || "").trim();
  return String(workspace[path as keyof ProductWorkspace] || "").trim();
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

function ContentLibrary({ userId, workspace, runs, mediaConfigured, videoConfigured, onOpen, onStart, notify }: { userId: string; workspace: ProductWorkspace; runs: AgentRun[]; mediaConfigured: boolean; videoConfigured: boolean; onOpen: (id: string) => void; onStart: () => void; notify: (message: string) => void }) {
  const [jobs, setJobs] = useState<MediaJob[]>([]);
  const [summary, setSummary] = useState<MediaBudgetSummary>({ monthlyCapCents: 2500, approvedThisMonthCents: 0, actualThisMonthCents: 0 });
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState("");
  const [direction, setDirection] = useState("");
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [proposals, setProposals] = useState<AssetProposal[]>([]);
  const [assetLink, setAssetLink] = useState("");
  const [assetWorking, setAssetWorking] = useState("");
  const assetInput = useRef<HTMLInputElement>(null);

  const applyMediaResponse = (data: { job?: MediaJob; jobs?: MediaJob[]; summary?: MediaBudgetSummary }) => {
    if (data.jobs) setJobs(data.jobs);
    if (data.job) setJobs((current) => [data.job!, ...current.filter((job) => job.id !== data.job!.id)]);
    if (data.summary) setSummary(data.summary);
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

  const uploadAssets = async (files: FileList | null) => {
    const selected = Array.from(files || []);
    if (!selected.length) return;
    if (!mediaConfigured) { notify("Connect OpenAI or Gemini before adding assets for analysis."); return; }
    setAssetWorking(`Reading 1 of ${selected.length}`);
    try {
      const token = await getAccessToken();
      for (const [index, file] of selected.entries()) {
        setAssetWorking(`Analyzing ${index + 1} of ${selected.length}`);
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
      }
      notify(`${selected.length} ${selected.length === 1 ? "asset was" : "assets were"} uploaded, tagged, and evaluated.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "The assets could not be uploaded.");
    } finally {
      setAssetWorking("");
      if (assetInput.current) assetInput.current.value = "";
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

  const activeJobs = jobs.filter((job) => job.status !== "cancelled");
  const waiting = activeJobs.filter((job) => job.status === "awaiting_budget");
  const completed = activeJobs.filter((job) => job.status === "complete");
  const inProduction = activeJobs.filter((job) => ["approved", "running"].includes(job.status));
  const needsAttention = activeJobs.filter((job) => job.status === "failed");
  const remaining = Math.max(0, summary.monthlyCapCents - summary.approvedThisMonthCents);
  const activeProposals = proposals.filter((proposal) => proposal.status !== "cancelled");
  const waitingProposals = activeProposals.filter((proposal) => proposal.status === "awaiting_approval");
  const producedProposals = activeProposals.filter((proposal) => proposal.status === "complete");

  return <div className="op-stack">
    <div className="op-heading"><div className="op-eyebrow">Creative production and saved assets</div><h1>Content library</h1><p>The agent evaluates existing work and proposes new assets from this project's product brain. You approve the estimated spend before paid production starts.</p></div>

    <section className="op-existing-assets"><div className="op-existing-assets__head"><div><small>EXISTING ASSET INTELLIGENCE</small><h2>Drop in everything you already have</h2><p>Upload several files at once or add a public Figma or document link. The agent reads, tags, and decides whether to reuse, adapt, replace, or archive each item.</p></div><button onClick={() => assetInput.current?.click()} disabled={!mediaConfigured || Boolean(assetWorking)}><UploadCloud size={16} />{assetWorking || "Upload assets"}</button><input ref={assetInput} type="file" multiple accept=".pdf,.pptx,.docx,.txt,.md,.csv,image/*,video/*" onChange={(event) => void uploadAssets(event.target.files)} /></div><div className="op-asset-link"><Link2 size={15} /><input value={assetLink} onChange={(event) => setAssetLink(event.target.value)} placeholder="Paste a public Figma, Slides, PDF, or asset link" /><button onClick={() => void addAssetLink()} disabled={!assetLink.trim() || Boolean(assetWorking)}>Add and analyze</button></div>{!mediaConfigured && <div className="op-asset-setup"><KeyRound size={15} /> Connect OpenAI or Gemini first so the agent can evaluate uploaded work.</div>}</section>

    {(workspace.sourceMedia || []).length > 0 && <SourceMediaStrip media={workspace.sourceMedia || []} />}

    {assets.length > 0 && <section className="op-asset-decisions"><div className="op-section-title"><div><small>AGENT DECISIONS</small><h2>What to use, change, or retire</h2></div><em>{assets.length}</em></div><div className="op-asset-grid">{assets.map((asset) => <article key={asset.id} className={`decision-${asset.recommendation}`}><header><span>{asset.kind === "image" ? <ImageIcon size={16} /> : asset.kind === "video" ? <Video size={16} /> : asset.kind === "figma" ? <LayoutDashboard size={16} /> : <FileText size={16} />}</span><div><strong>{asset.name}</strong><small>{asset.detail || asset.kind}</small></div><em>{asset.status === "failed" ? "Needs attention" : asset.recommendation}</em></header>{asset.status === "failed" ? <p className="error">{asset.error}</p> : <><p>{asset.summary}</p><div className="op-asset-tags">{asset.tags.map((tag) => <span key={tag}>{tag}</span>)}</div><details><summary>Why this decision <ChevronDown size={13} /></summary><p>{asset.rationale}</p>{asset.suggestedChanges.length > 0 && <ul>{asset.suggestedChanges.map((change) => <li key={change}>{change}</li>)}</ul>}</details></>}{asset.status === "ready" && ["adapt", "replace"].includes(asset.recommendation) && ["image", "video"].includes(asset.kind) && <button className="op-adapt-button" onClick={() => void prepare(asset.kind === "video" && videoConfigured ? "video" : "image", asset)} disabled={!mediaConfigured || Boolean(working)}><WandSparkles size={13} /> Prepare {asset.recommendation === "adapt" ? "adapted version" : "replacement"}</button>}{asset.downloadable && <button className="op-asset-download" onClick={() => void downloadProjectFile(asset.id, "asset", asset.name)} disabled={assetWorking === asset.id}><ArrowRight size={13} />{assetWorking === asset.id ? "Downloading…" : "Download original"}</button>}{asset.sourceUrl && <a className="op-asset-download" href={asset.sourceUrl} target="_blank" rel="noreferrer"><ArrowRight size={13} /> Open source</a>}</article>)}</div></section>}

    {waitingProposals.length > 0 && <section className="op-proposal-section"><div className="op-section-title"><div><small>AGENT PROPOSALS · APPROVAL REQUIRED</small><h2>New deliverables worth creating</h2></div><em>{waitingProposals.length}</em></div><div className="op-proposal-list">{waitingProposals.map((proposal) => <article key={proposal.id}><span>{proposal.kind === "deck" ? <LayoutDashboard size={19} /> : <FileText size={19} />}</span><div><small>{proposal.kind === "deck" ? "PRESENTATION DECK" : "PDF DOCUMENT"}</small><strong>{proposal.title}</strong><p>{proposal.description}</p><blockquote>{proposal.rationale}</blockquote></div><aside><em>Up to {money(proposal.estimatedCostCents)} API usage</em><button onClick={() => void approveProposal(proposal)} disabled={assetWorking === proposal.id}>{assetWorking === proposal.id ? "Creating…" : "Approve and create"}</button><button className="secondary" onClick={() => void declineProposal(proposal)} disabled={assetWorking === proposal.id}>Decline</button></aside></article>)}</div></section>}

    {producedProposals.length > 0 && <section className="op-proposal-section"><div className="op-section-title"><div><small>APPROVED DELIVERABLES</small><h2>Created documents and decks</h2></div><em>{producedProposals.length}</em></div><div className="op-produced-list">{producedProposals.map((proposal) => <article key={proposal.id}><span>{proposal.kind === "deck" ? <LayoutDashboard size={18} /> : <FileText size={18} />}</span><div><strong>{proposal.title}</strong><small>{proposal.kind === "deck" ? "Presentation deck · PDF" : "PDF document"}</small></div><button onClick={() => void downloadProjectFile(proposal.id, "proposal", `${proposal.title}.pdf`)} disabled={assetWorking === proposal.id}><ArrowRight size={14} />{assetWorking === proposal.id ? "Downloading…" : "Download"}</button></article>)}</div></section>}

    <section className="op-media-budget">
      <div><span><ShieldCheck size={20} /></span><div><small>HARD MONTHLY CEILING</small><strong>{money(summary.monthlyCapCents)} per project</strong><p>{money(summary.actualThisMonthCents)} spent · {money(summary.approvedThisMonthCents)} approved maximum · {money(remaining)} still available</p></div></div>
      <div className="op-budget-meter"><i style={{ width: `${Math.min(100, Math.round((summary.approvedThisMonthCents / Math.max(1, summary.monthlyCapCents)) * 100))}%` }} /></div>
      <small>Every asset needs a separate approval. The app will not start requests whose approved estimates exceed this ceiling; your connected provider calculates the final charge.</small>
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

    <section className="op-media-section"><div className="op-section-title"><div><small>SAVED MEDIA</small><h2>Generated assets</h2></div><em>{completed.length}</em></div>{loading ? <div className="op-media-loading"><LoaderCircle className="spin" size={19} /> Opening media library…</div> : completed.length ? <div className="op-media-gallery">{completed.map((job) => <article key={job.id}>{job.kind === "video" ? <video src={job.assetUrl} controls playsInline preload="metadata" /> : <img src={job.assetUrl} alt={job.title} />}<div><span>{job.kind === "video" ? <Video size={15} /> : <ImageIcon size={15} />}</span><div><strong>{job.title}</strong><small>{job.actualCostCents == null ? `Approved up to ${money(job.approvedBudgetCents)}` : `${money(job.actualCostCents)} actual cost`} · {new Date(job.createdAt).toLocaleDateString()}</small></div><a href={job.assetUrl} target="_blank" rel="noreferrer" aria-label="Open media"><ArrowRight size={15} /></a></div></article>)}</div> : <div className="op-empty op-empty--media"><span><ImageIcon size={22} /></span><h2>No generated media yet.</h2><p>The agent can prepare the first image or video brief above without spending anything.</p></div>}</section>

    <section className="op-media-section"><div className="op-section-title"><div><small>WRITING AND CHANNEL PACKS</small><h2>Social content</h2></div><em>{runs.length}</em></div>{runs.length ? <div className="op-run-list">{runs.map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div> : <div className="op-empty op-empty--compact"><span><FileText size={22} /></span><h2>No social content pack yet.</h2><p>Run the agent to create channel copy and a publishing queue.</p><button onClick={onStart}><Sparkles size={15} /> Open agent</button></div>}</section>
  </div>;
}

function MediaJobCard({ job, working, onApprove, onCancel }: { job: MediaJob; working: boolean; onApprove?: () => void; onCancel?: () => void }) {
  return <article className={`op-media-job op-media-job--${job.status}`}><div className="op-media-job__icon">{job.kind === "video" ? <Video size={19} /> : <ImageIcon size={19} />}</div><div className="op-media-job__body"><div><strong>{job.title}</strong><em>{mediaStatusLabel(job.status)}</em></div><p>{job.kind === "video" ? `${job.durationSeconds}-second vertical video with audio` : "Campaign-ready vertical image"} · {job.resolution} · {job.aspectRatio}</p><details><summary>See the agent's creative brief</summary><p>{job.prompt}</p></details>{job.error && <small className="error">{job.error}</small>}</div><div className="op-media-job__cost"><small>MAXIMUM</small><strong>{money(job.estimatedCostCents)}</strong>{job.status === "awaiting_budget" && <><button onClick={onApprove} disabled={working}>{working ? "Starting…" : `Approve ${money(job.estimatedCostCents)} max`}</button><button className="secondary" onClick={onCancel} disabled={working}>Cancel</button></>}{["approved", "running"].includes(job.status) && <span><LoaderCircle className="spin" size={14} /> Creating</span>}</div></article>;
}

function mediaStatusLabel(status: MediaJob["status"]) {
  const labels: Record<MediaJob["status"], string> = { awaiting_budget: "Waiting for budget", approved: "Approved", running: "In production", complete: "Complete", failed: "Needs attention", cancelled: "Cancelled" };
  return labels[status];
}

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 }).format(cents / 100);
}

function RunLibrary({ title, description, empty, runs, onOpen, onStart }: { title: string; description: string; empty: string; runs: AgentRun[]; onOpen: (id: string) => void; onStart: () => void }) {
  return <div className="op-stack"><div className="op-heading"><div className="op-eyebrow">Saved workspace records</div><h1>{title}</h1><p>{description}</p></div>{runs.length ? <div className="op-run-list">{runs.map((run) => <RunRow key={run.id} run={run} onOpen={onOpen} />)}</div> : <div className="op-empty"><span><FileText size={23} /></span><h2>{empty}</h2><p>Run the agent to create the first real record.</p><button onClick={onStart}><Sparkles size={15} /> Open agent</button></div>}</div>;
}

function RunRow({ run, onOpen }: { run: AgentRun; onOpen: (id: string) => void }) {
  return <button className="op-run-row" onClick={() => onOpen(run.id)}><span className={`op-run-icon op-run-icon--${run.action}`}>{run.action === "research" ? <Globe2 size={17} /> : run.action === "audience" ? <UsersRound size={17} /> : run.action === "campaign" ? <Rocket size={17} /> : run.action === "social" ? <MessageSquareText size={17} /> : <Bot size={17} />}</span><div><strong>{run.title}</strong><p>{run.prompt || actionMeta[run.action].description}</p><small>{new Date(run.createdAt).toLocaleString()}</small></div><em className={run.status === "Approved" ? "approved" : ""}>{run.status}</em><ArrowRight size={16} /></button>;
}

function RunDetail({ run, connections, onBack, onConnect, onStatus, onOutput, onDelete, notify }: { run: AgentRun; connections: ConnectionStatus; onBack: () => void; onConnect: () => void; onStatus: (id: string, status: RunStatus) => void; onOutput: (id: string, output: string) => void; onDelete: (id: string) => void; notify: (message: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [output, setOutput] = useState(run.output);
  const saveEdit = () => { onOutput(run.id, output); setEditing(false); notify("Changes saved."); };
  const distributionRun = run.action === "campaign" || run.action === "social" || run.action === "chat";
  return <div className="op-stack">
    <button className="op-back" onClick={onBack}><ArrowLeft size={15} /> Back to workspace</button>
    <section className="op-run-detail">
      <header><div><div className="op-eyebrow">{actionMeta[run.action].title} · {new Date(run.createdAt).toLocaleString()}</div><h1>{run.title}</h1><p>{run.prompt || actionMeta[run.action].description}</p></div><div><span className={`op-review-state ${run.status === "Approved" ? "approved" : ""}`}>{run.status === "Approved" && <Check size={13} />}{run.status}</span><button className="op-more" onClick={() => { if (window.confirm("Delete this saved agent run?")) onDelete(run.id); }}><Trash2 size={16} /></button></div></header>
      {distributionRun && <div className={`op-execution-state ${connections.gmail.connected ? "connected" : ""}`}><span>{connections.gmail.connected ? <Check size={19} /> : <Send size={19} />}</span><div><small>EXECUTION STATUS</small><strong>{connections.gmail.connected ? "Mailbox connected — campaign not launched" : "Prepared — not launched"}</strong><p>{connections.gmail.connected ? `Email can be sent from ${connections.gmail.accountEmail} after this campaign has an approved recipient queue. Nothing has been sent yet.` : "Research and campaign material are saved. No email, messaging, or social account is connected, so nothing was sent or published."}</p></div><button onClick={onConnect}>{connections.gmail.connected ? "Manage connections" : "Connection setup"} <ArrowRight size={14} /></button></div>}
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

function OperationalIntegrations({ projectId, userEmail, health, apiCredentials, onApiCredentials, connections, schedule, onSchedule, notify }: { projectId: string; userEmail: string; health: HealthState; apiCredentials: ApiCredentialStatus; onApiCredentials: (status: ApiCredentialStatus) => void; connections: ConnectionStatus; schedule: AgentSchedule; onSchedule: (schedule: AgentSchedule) => void; notify: (message: string) => void }) {
  const [connecting, setConnecting] = useState("");
  const [savingProvider, setSavingProvider] = useState<ApiProvider | "">("");
  const [keyDrafts, setKeyDrafts] = useState<Record<ApiProvider, string>>({ openai: "", google: "", anthropic: "" });
  const connectAccount = async (provider: "google-gmail" | "linkedin" | "instagram" | "tiktok" | "x") => {
    setConnecting(provider);
    try {
      const response = await apiFetch("/api/connections", { method: "POST", body: JSON.stringify({ provider, projectId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Account connection could not start.");
      window.location.assign(data.authorizationUrl);
    } catch (error) {
      notify(error instanceof Error ? error.message : "Account connection could not start.");
      setConnecting("");
    }
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
      if (schedule.enabled) onSchedule({ ...schedule, enabled: false });
      notify("Private API connection removed. Automatic work is paused.");
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
  const connectors = [
    { name: "Neon", detail: "Private sign-in and cross-device Postgres persistence", credential: "Database + managed auth", ready: health.databaseConfigured && health.authConfigured, core: true },
    { name: "Google Analytics", detail: "GA4 traffic, attribution, events, and conversion reporting", credential: "GA4 property + Google OAuth", ready: health.analyticsConfigured, core: false },
    { id: "google-gmail" as const, name: "Email", detail: connections.gmail.connected ? `Authorized sender: ${connections.gmail.accountEmail}` : "Approved outreach from your dedicated mailbox", credential: "Secure mailbox authorization", ready: connections.gmail.connected, configured: connections.gmail.configured, core: false },
    { id: "linkedin" as const, name: "LinkedIn", detail: connections.linkedin.connected ? `Authorized account: ${connections.linkedin.accountLabel}` : "Personal publishing first; company-page access follows platform approval", credential: "LinkedIn publishing authorization", ready: connections.linkedin.connected, configured: connections.linkedin.configured, core: false },
    { id: "instagram" as const, name: "Instagram", detail: connections.instagram.connected ? `Authorized account: ${connections.instagram.accountLabel}` : "Professional-account posts, Reels, and insights", credential: "Instagram professional authorization", ready: connections.instagram.connected, configured: connections.instagram.configured, core: false },
    { id: "tiktok" as const, name: "TikTok", detail: connections.tiktok.connected ? `Authorized account: ${connections.tiktok.accountLabel}` : "Videos and photo posts; public publishing follows platform review", credential: "TikTok content-publishing authorization", ready: connections.tiktok.connected, configured: connections.tiktok.configured, core: false },
    { id: "x" as const, name: "X", detail: connections.x.connected ? `Authorized account: ${connections.x.accountLabel}` : "Posts, media, and performance signals", credential: "X account authorization", ready: connections.x.connected, configured: connections.x.configured, core: false },
  ];
  const readyToAuthorize = connectors.filter((connector) => connector.id && connector.configured && !connector.ready);
  return <div className="op-stack">
    <div className="op-heading"><div className="op-eyebrow">Private services and distribution</div><h1>Connections</h1><p>Connect your own private APIs once for every project in your account. Delivery channels remain connected separately for each project.</p></div>
    <section className={`op-runtime ${health.agentConfigured ? "ready" : ""}`}><span>{health.agentConfigured ? <Check size={21} /> : <KeyRound size={21} />}</span><div><strong>{apiCredentials.collaborationReady ? "Three-agent strategy review is ready" : health.agentConfigured ? `${apiCredentials.connectedCount} private ${apiCredentials.connectedCount === 1 ? "API is" : "APIs are"} connected` : "Connect OpenAI or Gemini to begin"}</strong><p>{apiCredentials.collaborationReady ? "All three independent agents will work together on strategy and produce a balanced final recommendation." : health.agentConfigured ? "Real work is enabled. Add the remaining APIs for stronger cross-checking and better-balanced strategy." : "One core API unlocks reasoning and image creation. Connect all three for the best strategic performance."}</p></div></section>
    {!health.agentConfigured && <section className="op-starter-guide"><span><Sparkles size={19} /></span><div><small>STARTER ASSISTANT</small><strong>I’ll help you connect the right services.</strong><p>Start with either OpenAI or Gemini. That is enough to unlock real reasoning and image creation. Claude adds an independent reviewer. When all three are connected, three agents work together on each balanced strategy.</p></div></section>}
    {userEmail.toLowerCase() === "unleash@evilcreatives.com" && !apiCredentials.collaborationReady && <section className="op-owner-restore"><KeyRound size={19} /><div><strong>Your deployment already has three private keys</strong><p>Transfer them directly from Vercel into this account’s encrypted vault. They will never be displayed or sent to the browser.</p></div><button onClick={() => void restoreOwnerCredentials()} disabled={Boolean(savingProvider)}>{savingProvider ? "Connecting…" : "Connect my stored keys"}</button></section>}
    <section className="op-api-vault"><div className="op-api-vault__head"><div><small>ACCOUNT-WIDE API VAULT</small><h2>Your private analysis connections</h2><p>One core API is required. Two improve coverage. All three unlock the strongest collaborative review. Your keys are isolated to your signed-in account.</p></div><span><ShieldCheck size={17} /> Encrypted</span></div><div className="op-api-vault__grid">{apiOptions.map((option) => { const saved = apiCredentials.credentials[option.provider]; const busy = savingProvider === option.provider; return <article key={option.provider} className={saved.connected ? "connected" : ""}><div className="op-api-card__title"><span><KeyRound size={16} /></span><div><strong>{option.name}</strong><small>{option.account}</small></div><em>{saved.connected ? "Saved" : option.provider === "anthropic" ? "Optional" : "Core"}</em></div><p>{option.detail}</p><a className="op-api-help" href={option.helpUrl} target="_blank" rel="noreferrer">Create or find key in {option.tier} <ArrowRight size={11} /></a>{saved.connected ? <div className="op-api-saved"><code>Key ending ••••{saved.hint}</code><div><button className="danger" onClick={() => void disconnectApiCredential(option.provider)} disabled={busy}>{busy ? "Removing…" : "Disconnect"}</button></div></div> : null}<label><span>{saved.connected ? "Paste a new key to replace it" : "Paste API key"}</span><div><input type="password" value={keyDrafts[option.provider]} onChange={(event) => setKeyDrafts((current) => ({ ...current, [option.provider]: event.target.value }))} placeholder="Your private API key" autoComplete="off" spellCheck={false} /><button onClick={() => void saveApiCredential(option.provider)} disabled={busy || !keyDrafts[option.provider].trim()}>{busy ? "Saving…" : saved.connected ? "Replace" : "Connect"}</button></div></label></article>; })}</div><div className="op-api-how"><div><strong>OpenAI</strong><p>Open the API keys page, create a secret key, copy it once, and paste it above.</p></div><div><strong>Gemini</strong><p>In Google Cloud, enable the Gemini API, open APIs &amp; Services → Credentials, create an API key, restrict it to that API, and paste it above.</p></div><div><strong>Claude</strong><p>Open the Anthropic Console key settings, create a key, copy it, and paste it above.</p></div></div><small className="op-api-vault__note">Keys are used only on the server for this account’s requests and scheduled work. The browser never stores them, and the interface shows only the final four characters after saving.</small></section>
    {readyToAuthorize.length > 0 && <section className="op-connection-blocker"><CircleAlert size={21} /><div><strong>{readyToAuthorize.length} {readyToAuthorize.length === 1 ? "account is" : "accounts are"} ready for your approval</strong><p>Choose Connect on a channel below, sign in, and approve access.</p></div></section>}
    <section className="op-schedule-card"><div><span><Bot size={18} /></span><div><strong>Daily autonomous market pulse</strong><p>Runs each morning Eastern time in the cloud, creates a new draft, and never publishes it.</p></div><label className="op-switch"><input type="checkbox" checked={schedule.enabled} disabled={!apiCredentials.ready} onChange={(event) => onSchedule({ ...schedule, enabled: event.target.checked })} /><i /></label></div><div className="op-schedule-fields"><label><span>Workflow</span><select value={schedule.action} onChange={(event) => onSchedule({ ...schedule, action: event.target.value as AgentSchedule["action"] })}><option value="research">Market research</option><option value="audience">Audience analysis</option><option value="campaign">30-day campaign</option><option value="social">Social content pack</option></select></label><label className="wide"><span>Direction</span><textarea value={schedule.prompt} onChange={(event) => onSchedule({ ...schedule, prompt: event.target.value })} /></label></div><small>{!apiCredentials.ready ? "Connect OpenAI or Gemini to enable automatic work." : schedule.lastRunAt ? `Last automatic run: ${new Date(schedule.lastRunAt).toLocaleString()}` : "No automatic run has happened yet."}</small></section>
    <div className="op-connector-grid">{connectors.map((connector) => <article key={connector.name}><div><span>{connector.name.slice(0, 2)}</span><div><strong>{connector.name}</strong><small>{connector.core ? "Cloud core" : "Delivery channel"}</small></div><em className={connector.ready ? "ready" : ""}>{connector.ready ? "Connected" : connector.configured ? "Ready to approve" : "Agent setup"}</em></div><p>{connector.detail}</p><code>{connector.credential}</code>{connector.id && !connector.ready && <button className="op-connect-button" onClick={() => void connectAccount(connector.id)} disabled={!connector.configured || Boolean(connecting)}>{connector.configured ? (connecting === connector.id ? `Opening ${connector.name}…` : `Connect ${connector.name}`) : "Setup in progress"}</button>}</article>)}</div>
    <section className="op-truth-card"><ShieldCheck size={20} /><div><strong>Nothing publishes without a real account</strong><p>The agent can prepare targets, copy, schedules, and assets now. Sending and publishing become available only after the relevant account confirms authorization and the platform grants the required permission.</p></div></section>
  </div>;
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

function EmptyWorkspace({ onStart }: { onStart: () => void }) { return <div className="op-empty op-empty--compact"><span><BrainCircuit size={22} /></span><h2>No work for this project yet.</h2><p>Add the project's real context, then run the agent. Research, campaigns, and content appear only after they are created.</p><button onClick={onStart}>Set up project brain <ArrowRight size={14} /></button></div>; }

function projectInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "NP";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function workspaceCompleteness(workspace: ProductWorkspace) {
  const fields = [workspace.name, workspace.website, workspace.description, workspace.audience, workspace.valueProposition, workspace.voice, workspace.guardrails, workspace.notes];
  const core = fields.filter((field) => field.trim().length > 8).length;
  return Math.min(100, Math.round((core / fields.length) * 85 + (workspace.sources.length ? 15 : 0)));
}
