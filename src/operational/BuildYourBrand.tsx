import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { ArrowDown, ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronRight, CircleAlert, Compass, Eye, LoaderCircle, Maximize2, Pencil, Plus, ScrollText, Sparkles, Trash2, X } from "lucide-react";
import { apiFetch } from "../auth";
import sectionList from "./brand-builder-sections.json";
import type { BrandBuilderData, BrandDirection, BrandDiscovery, BrandFace, BrandLesson, BrandMethod, BrandPreview, BrandSourceRecord, BrandSystem, BrandTheme } from "./brand-builder-types";
import type { ProductWorkspace } from "./types";
import "./build-your-brand.css";

const views = ["Studio", "Brand Bible", "Visual guidelines", "Vocabulary cube", "Memory", "Method"] as const;
type View = typeof views[number];
const chapters = ["Strategy", "Identity", "Practice"] as const;
const faceOrder: BrandFace[] = ["first-contradiction", "second", "second-contradiction", "first", "both", "neither"];
const rotations: Record<BrandFace, string> = {
  "first-contradiction": "rotateX(-14deg) rotateY(-18deg)",
  second: "rotateX(-10deg) rotateY(-72deg)",
  "second-contradiction": "rotateX(-14deg) rotateY(-162deg)",
  first: "rotateX(-10deg) rotateY(72deg)",
  both: "rotateX(-68deg) rotateY(-18deg)",
  neither: "rotateX(68deg) rotateY(-18deg)",
};

function labelFace(face: BrandFace, axis: BrandDiscovery["axis"]) {
  return {
    first: axis.first, second: axis.second, both: `${axis.first} + ${axis.second}`,
    neither: "Neither", "first-contradiction": `${axis.first} under strain`, "second-contradiction": `${axis.second} under strain`,
  }[face];
}

function themeStyle(theme: BrandTheme) {
  return { "--byb-paper": theme.paper, "--byb-ink": theme.ink, "--byb-accent": theme.accent } as CSSProperties;
}

function Artwork({ theme, preview, name, image, compose = false }: { theme: BrandTheme; preview: BrandPreview; name: string; image?: string; compose?: boolean }) {
  return <div className={`byb-artwork byb-layout-${theme.layout} byb-type-${theme.typeStyle} ${compose ? "byb-artwork--compact" : ""}`} style={themeStyle(theme)}>
    <div className="byb-artwork-mark"><span>{name}</span><ArrowUpRight aria-hidden="true" size={14} /></div>
    <div className="byb-artwork-copy"><strong>{preview.headline}</strong><p>{preview.copy}</p>{preview.action && <span className="byb-preview-cta">{preview.action}<ArrowUpRight size={12} aria-hidden="true" /></span>}</div>
    <div className="byb-artwork-image" aria-hidden="true">{image && <img src={image} alt="" loading="lazy" />}</div>
  </div>;
}

interface Props {
  workspace: ProductWorkspace;
  onWorkspaceUpdate: (patch: Partial<ProductWorkspace>, revision: number) => void;
  onOpenBrand: () => void;
  onConnect: () => void;
  notify: (text: string) => void;
}

export default function BuildYourBrand({ workspace, onWorkspaceUpdate, onOpenBrand, onConnect, notify }: Props) {
  const [data, setData] = useState<BrandBuilderData | null>(null);
  const [view, setView] = useState<View>(() => {
    const value = new URLSearchParams(window.location.search).get("brand-view");
    return views.find((item) => item.toLowerCase().replaceAll(" ", "-") === value && item !== "Method") || "Studio";
  });
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [connectionNeeded, setConnectionNeeded] = useState(false);
  const [reopenBrief, setReopenBrief] = useState(false);
  const [pinnedArtId, setPinnedArtId] = useState("");
  const [chapter, setChapter] = useState<typeof chapters[number]>("Strategy");
  const [selectedDraft, setSelectedDraft] = useState(false);

  async function read(signal?: AbortSignal) {
    const url = `/api/brand-builder?projectId=${encodeURIComponent(workspace.id)}`;
    let response = await apiFetch(url, { signal });
    if (response.status === 404 && !signal?.aborted) {
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      response = await apiFetch(url, { signal });
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Your brand workspace could not open.");
    if (!signal?.aborted) { setData(result); setBrief(result.draft.brief); setPinnedArtId(result.draft.artDirectionId || ""); setError(""); }
  }

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal).catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [workspace.id]);

  async function command(action: string, details: Record<string, unknown> = {}, revision = data?.revision, status = "Saving…") {
    setBusy(status);
    setError("");
    setConnectionNeeded(false);
    try {
      const response = await apiFetch("/api/brand-builder", { method: "POST", body: JSON.stringify({ projectId: workspace.id, revision, action, ...details }) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 402) setConnectionNeeded(true);
        throw new Error(result.error || "This change could not be saved.");
      }
      setData((current) => current ? { ...current, ...result } : result);
      if (result.workspacePatch && result.workspaceRevision) onWorkspaceUpdate(result.workspacePatch, result.workspaceRevision);
      return result as BrandBuilderData;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This change could not be saved.");
      return null;
    } finally { setBusy(""); }
  }

  const discovery = data?.draft.discovery;
  const direction = discovery?.directions.find((item) => item.id === data?.draft.directionId);
  const system = data?.draft.system;
  const approved = data?.approved;
  const showDraft = selectedDraft || !approved;
  const readingSystem = showDraft ? system : approved.system;
  const readingAxis = showDraft ? discovery?.axis : approved.axis;
  const readingSources = showDraft ? discovery?.sources : approved.sources;
  const image = workspace.sourceMedia.find((item) => item.kind === "image" && item.recommendation === "reuse" && !/logo|icon|favicon/i.test(`${item.name} ${item.role}`) && /^https?:\/\//i.test(item.url))?.url;
  const projectHasContext = Boolean(workspace.website || workspace.description || workspace.sources.length || workspace.materials.length);

  function selectView(next: View) {
    setView(next);
    const params = new URLSearchParams(window.location.search);
    params.set("brand-view", next.toLowerCase().replaceAll(" ", "-"));
    window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
  }

  async function discover() {
    const result = await command("discover", { brief }, data?.revision, "Finding creative directions…");
    if (result) { setReopenBrief(false); setPinnedArtId(""); }
  }

  async function choose(item: BrandDirection) {
    const selected = await command("select", { directionId: item.id, artDirectionId: pinnedArtId === item.id ? "" : pinnedArtId });
    if (selected) { setChapter("Strategy"); await command("draft-system", {}, selected.revision, "Writing the brand system…"); }
  }

  async function review() {
    const result = await command("review", { group: chapter });
    if (result) setChapter(chapters.find((item) => !result.draft.reviewed.includes(item)) || chapter);
  }

  async function approve() {
    const result = await command("approve");
    if (result) { setSelectedDraft(false); selectView("Brand Bible"); notify(`Brand Bible approved · Version ${result.approved?.version}`); }
  }

  return <div className="byb">
    <header className="byb-header"><div><h1>Build Your Brand</h1><p>{workspace.name}</p></div>
      {approved && <span className="byb-status"><Check size={14} /> Approved version {approved.version}</span>}
    </header>
    <nav className="byb-tabs" aria-label="Build Your Brand">
      {views.filter((item) => item !== "Method" || data?.canEditMethods).map((item) =>
        <button key={item} type="button" aria-current={item === view ? "page" : undefined} onClick={() => selectView(item)}>{item}</button>)}
    </nav>
    {error && <div className="byb-alert" role="alert"><CircleAlert size={17} /><span>{error}</span>
      {connectionNeeded ? <button className="byb-outline" onClick={onConnect}>Open Integrations</button> :
        <button className="byb-outline" disabled={Boolean(busy)} onClick={() => void read().catch((cause) => setError(cause.message))}>Reload saved work</button>}</div>}
    {busy && <p className="byb-progress" role="status"><LoaderCircle className="spin" size={17} />{busy}</p>}
    {!data && !error && <p className="byb-progress" role="status"><LoaderCircle className="spin" size={17} /> Opening your studio…</p>}
    {data && <div aria-busy={Boolean(busy)}>
      {view === "Studio" && <>
        {(!discovery || reopenBrief) && <section className="byb-intro">
          <div className="byb-intro-content"><h2>What are you building?</h2>
            <p>Start with an idea, a link, or the material already in your project. See two creative directions applied to the same homepage.</p>
            <form onSubmit={(event) => { event.preventDefault(); void discover(); }}>
              <label className="byb-field"><span>Describe the business and who it’s for</span>
                <textarea value={brief} rows={3} maxLength={3600} onChange={(event) => setBrief(event.target.value)} placeholder="We’re building… for people who…" /></label>
              <div className="byb-actions"><button className="byb-primary" disabled={Boolean(busy) || (!brief.trim() && !projectHasContext)}><Sparkles size={16} /> Find creative directions</button>
                <button type="button" className="byb-outline" onClick={onOpenBrand}>Manage project materials <ArrowUpRight size={14} /></button></div>
            </form>
          </div>
          <div className="byb-intro-visual" aria-hidden="true"><div className="byb-intro-shape" /><ArrowDownRight size={36} strokeWidth={1} /></div>
        </section>}
        {discovery && !reopenBrief && <>
          <div className="byb-steps" aria-label="Brand building stages"><span className="done"><Check size={14} /> Discover</span><ChevronRight size={15} /><span className={direction ? "done" : "current"}>{direction && <Check size={14} />} Choose a direction</span><ChevronRight size={15} /><span className={system ? "current" : ""}>Shape the brand</span></div>
          <section className="byb-decision">
            <div><small>{discovery.axis.domain}</small><h2>{discovery.axis.first} <i>↔</i> {discovery.axis.second}</h2><p>{discovery.audience}</p></div>
            <details><summary>See the brief and evidence</summary><p>{discovery.reality}</p>{discovery.unknown && <p><b>Open question.</b> {discovery.unknown}</p>}<Sources records={discovery.sources} /></details>
          </section>
          {!system ? <>
            <div className="byb-comparison">
              {discovery.directions.map((item) => <article className={`byb-direction ${direction?.id === item.id ? "selected" : ""}`} key={item.id}>
                <Artwork theme={item.theme} preview={item.preview} name={discovery.brandName || workspace.name} />
                <div className="byb-direction-body"><div className="byb-direction-top"><h3>{item.title}</h3><span>{labelFace(item.focus, discovery.axis)}</span></div>
                  <p>{item.thesis}</p><dl><dt>What it delivers</dt><dd>{item.payoff}</dd><dt>Tradeoff</dt><dd>{item.tradeoff}</dd><dt>Proof</dt><dd>{item.proof}</dd><dt>Image direction</dt><dd>{item.preview.imagery}</dd></dl>
                  <div className="byb-actions byb-direction-actions">
                    <button className="byb-primary" disabled={Boolean(busy)} onClick={() => void choose(item)}>
                      {direction?.id === item.id ? "Draft this system" : "Develop this direction"} <ArrowRight size={16} />
                    </button>
                    <button className="byb-outline" aria-pressed={pinnedArtId === item.id} disabled={Boolean(busy)} onClick={() => setPinnedArtId(pinnedArtId === item.id ? "" : item.id)}>
                      {pinnedArtId === item.id && <Check size={14} />}{pinnedArtId === item.id ? "Art direction pinned" : "Pin art direction"}
                    </button>
                  </div>
                </div>
              </article>)}
            </div>
            <div className="byb-actions"><button className="byb-textlink" onClick={() => setReopenBrief(true)} disabled={Boolean(busy)}><Pencil size={14} /> Revisit the brief</button>
              {pinnedArtId && <span className="byb-pin-note">The pinned art direction will carry into the story you choose.</span>}
            </div>
          </> : <>
            <div className="byb-chapter-header"><div><h2>Shape the brand</h2><p>{system.idea}</p></div>
              <button className="byb-outline" onClick={() => { setSelectedDraft(true); selectView("Brand Bible"); }}><Eye size={15} /> Preview the Bible</button>
            </div>
            <nav className="byb-chapters" aria-label="Draft chapters">{chapters.map((item) =>
              <button type="button" key={item} aria-pressed={chapter === item} onClick={() => setChapter(item)}>{data.draft.reviewed.includes(item) && <Check size={14} />}{item}</button>)}
            </nav>
            <div className="byb-chapter"><section>
              {sectionList.filter((item) => item.group === chapter).map((item, index) => {
                const entry = system.sections.find((part) => part.id === item.id);
                if (!entry) return null;
                return <details key={item.id} className="byb-section" open={index === 0 || undefined}>
                  <summary>{item.title}</summary><p>{entry.text}</p><blockquote>{entry.example}</blockquote>
                  <Sources records={discovery.sources.filter(({ id }) => entry.sourceIds.includes(id))} />
                  <SectionEdit section={item.id} text={entry.text} example={entry.example} busy={Boolean(busy)} onSave={(details) => command("edit-section", details)} onRevise={(note) => command("draft-system", { section: item.id, note }, data.revision, "Revising this section…")} />
                </details>;
              })}
            </section><aside className="byb-chapter-aside">
              <Artwork theme={system.theme} name={system.name} preview={system.faces.find((item) => item.face === direction?.focus)?.preview || system.faces[0].preview} image={image} compose />
              <div><strong>{chapter === "Identity" ? "Visual direction" : "Creative direction"}</strong><p>{system.theme.direction}</p></div>
            </aside></div>
            <div className="byb-actions byb-review-actions">
              {data.draft.dirty && !data.draft.reviewed.includes(chapter) && <button className="byb-outline" disabled={Boolean(busy)} onClick={() => void review()}><Check size={16} /> Mark {chapter.toLowerCase()} reviewed</button>}
              {data.draft.dirty && chapters.every((item) => data.draft.reviewed.includes(item)) && <button className="byb-primary" disabled={Boolean(busy)} onClick={() => void approve()}><Check size={17} /> Approve brand version {(approved?.version || 0) + 1}</button>}
              {!data.draft.dirty && approved && <span className="byb-status"><Check size={15} /> This draft is the approved brand</span>}
              <details className="byb-revisit"><summary>Explore a different direction</summary><p>The approved version stays available while you explore.</p>
                <div className="byb-actions">{discovery.directions.filter((item) => item.id !== direction?.id).map((item) => <button className="byb-outline" key={item.id} disabled={Boolean(busy)} onClick={() => void choose(item)}>{item.title}</button>)}
                  <button className="byb-outline" disabled={Boolean(busy)} onClick={() => setReopenBrief(true)}>Revisit the brief</button>
                </div></details>
            </div>
          </>}
        </>}
      </>}

      {["Brand Bible", "Visual guidelines", "Vocabulary cube"].includes(view) && <>
        {approved && system && data.draft.dirty && <div className="byb-version-toggle" aria-label="Brand version"><button aria-pressed={!showDraft} onClick={() => setSelectedDraft(false)}>Approved v{approved.version}</button><button aria-pressed={showDraft} onClick={() => setSelectedDraft(true)}>Draft preview</button></div>}
        {readingSystem && readingAxis ? <>
          {view === "Brand Bible" && <BibleReader system={readingSystem} sources={readingSources || []} image={image} version={showDraft ? 0 : approved.version} onGuidelines={() => selectView("Visual guidelines")} />}
          {view === "Visual guidelines" && <Guidelines system={readingSystem} workspace={workspace} image={image} onBrand={onOpenBrand} />}
          {view === "Vocabulary cube" && <Cube key={`${showDraft ? "draft" : approved.version}-${readingSystem.idea}`} system={readingSystem} axis={readingAxis} image={image} initialFace={showDraft ? direction?.focus : data.focus.find((item) => item.version === approved.version && item.context === "Default")?.face}
            applied={showDraft ? [] : data.focus.filter((item) => item.version === approved.version)}
            editable={!showDraft} busy={Boolean(busy)} onApply={(face, context, reason) => command("focus", { face, context, reason, version: approved?.version })} />}
        </> : <EmptyState title={view} action={() => selectView("Studio")}>Develop a direction in the Studio to see this part of the brand.</EmptyState>}
      </>}
      {view === "Memory" && <MemoryPanel lessons={data.memory} history={data.history} focusHistory={data.focusHistory || []} busy={Boolean(busy)} onSave={(details) => command("remember", details)} onForget={(id) => command("forget", { id })} />}
      {view === "Method" && data.canEditMethods && <MethodsPanel methods={data.methods} busy={Boolean(busy)} onSave={(method) => command("save-method", { ...method })} />}
    </div>}
  </div>;
}

function EmptyState({ title, children, action }: { title: string; children: ReactNode; action: () => void }) {
  return <section className="byb-empty"><ScrollText size={28} aria-hidden="true" /><h2>{title}</h2><p>{children}</p><button className="byb-primary" onClick={action}>Open Studio <ArrowRight size={15} /></button></section>;
}

function Sources({ records }: { records: BrandSourceRecord[] }) {
  return records.length ? <ul className="byb-sources">{records.map((record) => <li key={record.id}>
    {record.url ? <a href={record.url} target="_blank" rel="noreferrer">{record.label || "Open source"} <ArrowUpRight size={12} /></a> : <span>{record.label}</span>}
  </li>)}</ul> : null;
}

function SectionEdit({ section, text, example, busy, onSave, onRevise }: { section: string; text: string; example: string; busy: boolean; onSave: (details: Record<string, unknown>) => Promise<unknown>; onRevise: (note: string) => Promise<unknown> }) {
  const [mode, setMode] = useState<"revise" | "edit" | "">("");
  const [content, setContent] = useState(text);
  const [sample, setSample] = useState(example);
  const [note, setNote] = useState("");
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const result = mode === "edit" ? await onSave({ section, text: content, example: sample, reason: note }) : await onRevise(note);
    if (result) { setMode(""); setNote(""); }
  };
  return <div className="byb-inline-edit">
    {mode ? <form onSubmit={(event) => void save(event)}>
      {mode === "edit" && <>
        <label className="byb-field"><span>Text</span><textarea rows={4} value={content} onChange={(event) => setContent(event.target.value)} required /></label>
        <label className="byb-field"><span>Example</span><textarea rows={2} value={sample} onChange={(event) => setSample(event.target.value)} required /></label>
      </>}
      <label className="byb-field"><span>{mode === "edit" ? "Why this works · optional, remembered for this brand" : "What should change?"}</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} required={mode === "revise"} /></label>
      <div className="byb-actions"><button disabled={busy} className="byb-primary">{mode === "edit" ? "Save correction" : "Revise section"}</button><button className="byb-outline" type="button" onClick={() => setMode("")}>Cancel</button></div>
    </form> : <div className="byb-actions"><button className="byb-textlink" disabled={busy} onClick={() => setMode("revise")}><Sparkles size={14} /> Direct a revision</button>
      <button className="byb-textlink" disabled={busy} onClick={() => { setContent(text); setSample(example); setMode("edit"); }}><Pencil size={13} /> Edit</button></div>}
  </div>;
}

interface BibleProps { system: BrandSystem; sources: BrandSourceRecord[]; image?: string; version: number; onGuidelines: () => void }

function BibleReader(props: BibleProps) {
  const [reading, setReading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (reading) dialog.current?.showModal(); }, [reading]);
  return <>
    <button className="byb-outline byb-read-button" onClick={() => setReading(true)}><Maximize2 size={14} /> Reading view</button>
    {reading ? <dialog ref={dialog} className="byb-reading-mode" aria-label="Brand Bible reading view" onClose={() => setReading(false)}>
      <button className="byb-outline" onClick={() => dialog.current?.close()}><X size={15} /> Close reading view</button>
      <BrandBible {...props} onGuidelines={() => { dialog.current?.close(); props.onGuidelines(); }} />
    </dialog> : <BrandBible {...props} />}
  </>;
}

function BrandBible({ system, sources, image, version, onGuidelines }: BibleProps) {
  const [chapter, setChapter] = useState<typeof chapters[number]>("Strategy");
  const narrative = system.sections.find((entry) => entry.id === "narrative");
  return <article className={`byb-bible byb-type-${system.theme.typeStyle} byb-bible-${system.theme.layout} tw:overflow-hidden tw:rounded-2xl`} style={themeStyle(system.theme)}>
    <header className="byb-bible-header tw:flex tw:flex-wrap tw:items-center tw:justify-between tw:gap-3"><span>{system.name}</span><span>Brand Bible · {version ? `Version ${version}` : "Draft"}</span></header>
    <section className="byb-bible-cover">
      <div className="byb-bible-title"><h2>{system.idea}</h2>{narrative?.text && <p>{narrative.text}</p>}<a className="byb-bible-link" href="#brand-bible-chapters">Read the brand <ArrowDown size={16} /></a></div>
      {image ? <img loading="lazy" src={image} alt="" className="byb-bible-image" /> : <div className="byb-bible-graphic" aria-hidden="true"><span>{system.name.slice(0, 1)}</span></div>}
    </section>
    <div className="byb-bible-inner tw:mx-auto tw:w-full" id="brand-bible-chapters">
      <nav aria-label="Brand Bible chapters" className="byb-bible-chapters tw:flex tw:flex-wrap tw:gap-3">{chapters.map((item) => <button key={item} aria-pressed={chapter === item} onClick={() => setChapter(item)}>{item}</button>)}</nav>
      <div className="byb-bible-sections tw:grid tw:gap-8">{sectionList.filter((item) => item.group === chapter).map((item) => {
        const section = system.sections.find((part) => part.id === item.id);
        if (!section) return null;
        return <section key={item.id} className="byb-bible-section"><h3>{item.title}</h3><div><p>{section.text}</p><blockquote>{section.example}</blockquote><Sources records={sources.filter(({ id }) => section.sourceIds.includes(id))} /></div></section>;
      })}</div>
      <button className="byb-bible-link" onClick={onGuidelines}>Open visual guidelines <ArrowUpRight size={16} /></button>
    </div>
  </article>;
}

function Guidelines({ system, workspace, image, onBrand }: { system: BrandSystem; workspace: ProductWorkspace; image?: string; onBrand: () => void }) {
  const logos = workspace.brand.logoVariants;
  const legacy = !logos.length && workspace.brand.logoDataUrl;
  const samples = [["Background", system.theme.paper], ["Text", system.theme.ink], ["Accent", system.theme.accent]];
  const ruleRows = [["Composition", system.guidelines.layout], ["Photography & imagery", system.guidelines.imagery], ["Motion", system.guidelines.motion], ["What to avoid", system.guidelines.avoid]];
  const sample = system.sections.find((item) => item.id === "voice")?.example || system.idea;
  return <div className={`byb-guidelines byb-type-${system.theme.typeStyle}`} style={themeStyle(system.theme)}>
    <div className="byb-guide-hero"><div><h2>Visual guidelines</h2><p>{system.theme.direction}</p></div><div className="byb-guide-monogram" aria-hidden="true">{system.name.slice(0, 2)}</div></div>
    <section className="byb-guide-card"><h3>Logo and variants</h3>
      {logos.length ? <div className="byb-logo-grid">{logos.map((logo) => <figure key={logo.id}><div className={logo.usage === "dark" ? "on-dark" : ""}><img src={logo.url} alt={logo.name} /></div><figcaption>{logo.name} · {logo.usage}</figcaption></figure>)}</div> :
        legacy ? <div className="byb-logo-grid"><figure><div><img src={workspace.brand.logoDataUrl} alt={workspace.brand.logoName || "Project logo"} /></div><figcaption>{workspace.brand.logoName || "Project logo"}</figcaption></figure></div> :
          <p>No logo file is assigned to this project.</p>}
      <p>{system.guidelines.logo}</p><button className="byb-textlink" onClick={onBrand}>Manage approved logos <ArrowUpRight size={14} /></button>
    </section>
    <section className="byb-guide-card"><h3>Color</h3><div className="byb-palette">{samples.map(([label, value]) => <figure key={label}><div style={{ backgroundColor: value }} /><figcaption>{label}<code>{value}</code></figcaption></figure>)}</div><p>{system.guidelines.palette}</p></section>
    <section className="byb-guide-card"><h3>Typography</h3><div className="byb-type-specimen">{system.idea}</div><p>{sample}</p><p>{system.guidelines.type}</p></section>
    <section className="byb-guide-card"><h3>Apply the system</h3>
      <Artwork theme={system.theme} preview={system.faces[0].preview} name={system.name} image={image} />
      <div className="byb-guide-rules">{ruleRows.map(([label, value]) => <div key={label}><h4>{label}</h4><p>{value}</p></div>)}</div>
    </section>
    <section className="byb-guide-card"><h3>Before it goes out</h3><ul>{system.checks.map((item) => <li key={item}>{item}</li>)}</ul></section>
  </div>;
}

function Cube({ system, axis, initialFace, applied, image, editable, busy, onApply }: {
  system: BrandSystem; axis: BrandDiscovery["axis"]; initialFace?: BrandFace; applied: BrandBuilderData["focus"]; image?: string;
  editable: boolean; busy: boolean; onApply: (face: BrandFace, context: string, reason: string) => Promise<unknown>;
}) {
  const [face, setFace] = useState<BrandFace>(initialFace || "both");
  const [word, setWord] = useState("");
  const [context, setContext] = useState("Homepage");
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState(false);
  const selected = system.faces.find((item) => item.face === face) || system.faces[0];
  const words = system.words.filter((item) => item.face === face);
  const selectedWord = words.find((item) => item.id === word) || words[0];
  const hypothetical = face === "neither" || face.endsWith("contradiction");
  const contextNames = [...new Set(["Default", "Homepage", "Limited release", ...applied.map((item) => item.context)])];
  const active = applied.find((item) => item.context.trim().toLowerCase() === context.trim().toLowerCase());
  const conditions = {
    both: `${axis.first} + ${axis.second}`, neither: `${axis.notFirst} + ${axis.notSecond}`,
    first: `${axis.first} + ${axis.notSecond}`, second: `${axis.second} + ${axis.notFirst}`,
    "first-contradiction": `${axis.first} + ${axis.notFirst}`, "second-contradiction": `${axis.second} + ${axis.notSecond}`,
  };
  return <section className="byb-cube-page">
    <div className="byb-cube-header"><h2>Vocabulary cube</h2><p>{axis.domain} <span>·</span> {axis.first} ↔ {axis.second}</p></div>
    <div className="byb-cube-grid">
      <div className="byb-cube-stage" style={themeStyle(system.theme)}>
        <div className="byb-cube-perspective" aria-hidden="true"><div className="byb-cube" style={{ transform: rotations[face] }}>
          {faceOrder.map((item, index) => <div key={item} className={`byb-cube-face byb-cube-face-${index} ${item === face ? "chosen" : ""}`}><span>{labelFace(item, axis)}</span></div>)}
        </div></div>
        <div className="byb-face-buttons" aria-label="Cube faces">{faceOrder.map((item) => <button key={item} aria-pressed={item === face} onClick={() => { setFace(item); setWord(""); }}>{labelFace(item, axis)}</button>)}</div>
      </div>
      <div className="byb-cube-reading">
        <small>{conditions[face]}</small><h3>{labelFace(face, axis)}</h3><p>{selected.story}</p><p className="byb-boundary"><b>{hypothetical ? "What to watch for" : "Boundary"}</b> {selected.boundary}</p>
        <div className="byb-words" aria-label="Vocabulary on this face">{words.map((item) => <button key={item.id} aria-pressed={item.id === selectedWord?.id} onClick={() => setWord(item.id)}>{item.word}</button>)}</div>
        {selectedWord && <div className="byb-word-detail"><strong>{selectedWord.word}</strong><p>{selectedWord.meaning}</p><p>{selectedWord.application}</p>
          {selectedWord.links.length > 0 && <ul>{selectedWord.links.map((link) => {
            const target = system.words.find((item) => item.id === link.id);
            return target && <li key={link.id}><button className="byb-textlink" onClick={() => { setFace(target.face); setWord(target.id); }}>{target.word}<ArrowUpRight size={13} /></button><span>{link.reason}</span></li>;
          })}</ul>}</div>}
      </div>
    </div>
    <section className="byb-cube-preview"><header><h3>{hypothetical ? "Homepage counterexample" : "Homepage with this focus"}</h3>{active && <span className="byb-status"><Check size={14} /> {active.context} uses {labelFace(active.face, axis)}</span>}</header>
      <Artwork theme={system.theme} preview={selected.preview} name={system.name} image={image} />
      {editable && !hypothetical && <div className="byb-apply-focus">
        {detail ? <form onSubmit={async (event) => { event.preventDefault(); if (await onApply(face, context, reason)) { setDetail(false); setReason(""); } }}>
          <div className="byb-actions"><label className="byb-field"><span>Context</span><input list="byb-context-options" required maxLength={80} value={context} onChange={(event) => setContext(event.target.value)} /><datalist id="byb-context-options">{contextNames.map((name) => <option key={name} value={name} />)}</datalist></label>
            <label className="byb-field"><span>Why this focus · optional</span><input value={reason} maxLength={360} onChange={(event) => setReason(event.target.value)} /></label></div>
          <div className="byb-actions"><button className="byb-primary" disabled={busy || !context.trim()}>Save focus</button><button className="byb-outline" type="button" onClick={() => setDetail(false)}>Cancel</button></div>
        </form> : <button className="byb-primary" onClick={() => setDetail(true)} disabled={busy}><Compass size={16} /> Use this focus</button>}
      </div>}
    </section>
    {!!applied.length && <section className="byb-focus-history"><h3>Approved contexts</h3>{applied.map((item) => <button key={item.context} className={context === item.context ? "active" : ""} onClick={() => { setFace(item.face); setWord(""); setContext(item.context); }}>
      <strong>{item.context}</strong><span>{labelFace(item.face, axis)} · {item.reason}</span><small>{item.author} · {new Date(item.at).toLocaleDateString()}</small>
    </button>)}</section>}
  </section>;
}

function MemoryPanel({ lessons, history, focusHistory, busy, onSave, onForget }: { lessons: BrandLesson[]; history: BrandBuilderData["history"]; focusHistory: BrandBuilderData["focus"]; busy: boolean; onSave: (input: Record<string, unknown>) => Promise<unknown>; onForget: (id: string) => Promise<unknown> }) {
  const [edit, setEdit] = useState<Partial<BrandLesson> | null>(null);
  return <section className="byb-admin"><div className="byb-chapter-header"><div><h2>Editorial memory</h2><p>Examples and judgments the assistant can reuse for this project.</p></div>
    <button className="byb-primary" disabled={busy} onClick={() => setEdit({ verdict: "avoid" })}><Plus size={16} /> Add an example</button></div>
    {edit && <form className="byb-edit-panel" onSubmit={async (event) => { event.preventDefault(); if (await onSave({ ...edit })) setEdit(null); }}>
      <div className="byb-actions"><label className="byb-field"><span>Judgment</span><select value={edit.verdict || "avoid"} onChange={(event) => setEdit({ ...edit, verdict: event.target.value as BrandLesson["verdict"] })}><option value="avoid">Avoid</option><option value="keep">Keep</option></select></label>
        <label className="byb-field"><span>Section</span><select value={edit.section || ""} onChange={(event) => setEdit({ ...edit, section: event.target.value })}><option value="">Whole brand</option>{sectionList.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
        <label className="byb-field"><span>Context · optional</span><input value={edit.context || ""} maxLength={80} onChange={(event) => setEdit({ ...edit, context: event.target.value })} placeholder="For example, Homepage" /></label>
      </div>
      <label className="byb-field"><span>Example</span><textarea rows={3} required maxLength={2200} value={edit.example || ""} onChange={(event) => setEdit({ ...edit, example: event.target.value })} /></label>
      <label className="byb-field"><span>Why</span><textarea rows={2} required maxLength={800} value={edit.reason || ""} onChange={(event) => setEdit({ ...edit, reason: event.target.value })} /></label>
      <div className="byb-actions"><button className="byb-primary" disabled={busy}>Save feedback</button><button className="byb-outline" type="button" onClick={() => setEdit(null)}>Cancel</button></div>
    </form>}
    {lessons.length ? <div className="byb-lesson-list">{lessons.map((lesson) => <article key={lesson.id}>
      <span className={`byb-lesson-${lesson.verdict}`}>{lesson.verdict === "keep" ? "Keep" : "Avoid"}</span>
      <div><small>{sectionList.find((item) => item.id === lesson.section)?.title || "Whole brand"}{lesson.context && ` · ${lesson.context}`}</small><blockquote>{lesson.example}</blockquote><p>{lesson.reason}</p></div>
      <div className="byb-actions"><button className="byb-outline" aria-label="Edit feedback" disabled={busy} onClick={() => setEdit(lesson)}><Pencil size={15} /></button><button className="byb-outline" aria-label="Remove feedback" disabled={busy} onClick={() => { if (window.confirm("Remove this example from the brand’s memory?")) void onForget(lesson.id); }}><Trash2 size={15} /></button></div>
    </article>)}</div> : <p className="byb-empty-memory">When you explain why a correction works, the assistant saves that judgment here.</p>}
    {!!history.length && <section className="byb-focus-history"><h3>Brand approvals</h3>{history.map((item) => <div key={item.version}><strong>Version {item.version}</strong><span>{item.idea}</span><small>{item.by} · {new Date(item.at).toLocaleDateString()}</small></div>)}</section>}
    {!!focusHistory.length && <section className="byb-focus-history"><h3>Focus decisions</h3>{focusHistory.map((item) => <div key={`${item.context}-${item.at}`}><strong>{item.context} · v{item.version}</strong><span>{item.reason}</span><small>{item.author} · {new Date(item.at).toLocaleDateString()}</small></div>)}</section>}
  </section>;
}

function MethodsPanel({ methods, busy, onSave }: { methods: BrandMethod[]; busy: boolean; onSave: (method: BrandMethod) => Promise<unknown> }) {
  const [edited, setEdited] = useState<BrandMethod | null>(null);
  const method = edited || methods[0];
  if (!method) return null;
  return <section className="byb-admin">
    <h2>Creative method</h2><p>Published guidance and examples inform new drafts across projects.</p>
    <form className="byb-edit-panel" onSubmit={async (event) => { event.preventDefault(); if (await onSave(method)) setEdited(null); }}>
      <label className="byb-field"><span>Section</span><select value={method.section} onChange={(event) => setEdited(methods.find((item) => item.section === event.target.value) || null)}>{sectionList.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      {([["instructions", "Guidance"], ["good", "A strong example"], ["bad", "An example to reject"], ["reject", "Rejection test"]] as const).map(([key, label]) =>
        <label className="byb-field" key={key}><span>{label}</span><textarea rows={3} value={method[key]} required={key === "instructions"} onChange={(event) => setEdited({ ...method, [key]: event.target.value })} /></label>)}
      <div className="byb-actions"><button className="byb-primary" disabled={busy || !edited}>Publish method</button><span>{method.version ? `Version ${method.version}` : "Built-in guidance"}</span></div>
    </form>
  </section>;
}
