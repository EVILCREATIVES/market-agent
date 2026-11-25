import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChartColumn, CircleAlert, Globe2, LoaderCircle, Search, Sparkles, X } from "lucide-react";
import { apiFetch } from "../auth";
import type { AgentRun, ProductWorkspace, SectorKnowledgeCategory, SectorKnowledgeItem, SectorPosition } from "./types";
import "./sector-expertise.css";

const categories: Record<SectorKnowledgeCategory, string> = {
  industry_business_model: "Business models",
  customer_segments: "Buyers",
  decision_process: "Buying process",
  problems_objections_triggers: "Problems and triggers",
  competitors_alternatives: "Competitors and substitutes",
  terminology_conventions: "Sector language",
  regulations_risks_proof: "Risk and proof",
  seasonality_events_signals: "Timing and signals",
};
const tabs = ["Overview", "Buyer journey", "Alternatives", "Positioning", "Evidence"] as const;
type Tab = typeof tabs[number];

interface Props {
  workspace: ProductWorkspace;
  runs: AgentRun[];
  onSave: (workspace: ProductWorkspace) => void;
  onResearchSaved: (projectId: string, expertise: ProductWorkspace["sectorExpertise"], revision: number) => void;
  onDevelop: (position: SectorPosition) => void;
  notify: (message: string) => void;
}

export default function SectorExpertiseWorkspace({ workspace, runs, onSave, onResearchSaved, onDevelop, notify }: Props) {
  const [tab, setTab] = useState<Tab>("Overview");
  const [category, setCategory] = useState<SectorKnowledgeCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState("");
  const [correction, setCorrection] = useState("");
  const expertise = workspace.sectorExpertise;
  const brief = expertise?.brief;
  const entry = brief?.marketEntry;
  const items = (expertise?.items || []).filter((item) => item.sourceChecked || item.userCorrected);
  const outside = items.filter((item) => item.sourceChecked && !item.userCorrected);
  const sources = new Set(outside.map((item) => item.sourceUrl)).size;
  const coverage = (Object.entries(categories) as [SectorKnowledgeCategory, string][]).map(([key, label]) => ({
    key, label, count: outside.filter((item) => item.category === key).length,
  }));
  const maxCount = Math.max(1, ...coverage.map((row) => row.count));
  const filtered = items.filter((item) => (category === "all" || item.category === category)
    && `${item.statement} ${item.implication} ${item.sourceTitle}`.toLowerCase().includes(query.trim().toLowerCase()));
  const selectedEvidence = outside.filter((item) => evidenceIds.includes(item.id));
  const recommended = brief?.positions.find((item) => item.id === brief.recommendedPositionId);
  const learning = runs.filter((run) => run.learningConclusion).slice(0, 3);
  const metrics = [...new Map(outside.filter((item) => item.metric).map((item) => [item.sourceUrl + item.metric, item])).values()].slice(0, 4);

  const refresh = async () => {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      const response = await apiFetch("/api/agent", { method: "POST", body: JSON.stringify({ action: "sector", projectId: workspace.id }) });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.sectorExpertise?.items?.some((item: SectorKnowledgeItem) => item.sourceChecked)) {
        throw new Error(data?.error || (response.status === 504 ? "Sector research timed out. Try again." : "No checked sector evidence was returned. Try again."));
      }
      onResearchSaved(workspace.id, data.sectorExpertise, Number(data.revision));
      setTab("Overview");
      notify("Sector research saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sector research could not be refreshed.");
    } finally {
      setWorking(false);
    }
  };

  const saveCorrection = () => {
    const statement = correction.trim();
    if (!expertise || !editingId || !statement) return;
    const now = new Date().toISOString();
    const avoidsCorrection = (record: { evidenceIds: string[] }) => !record.evidenceIds.includes(editingId);
    onSave({
      ...workspace,
      sectorExpertise: {
        ...expertise,
        brief: brief ? {
          ...brief,
          marketEntry: brief.marketEntry && avoidsCorrection(brief.marketEntry) ? brief.marketEntry : null,
          buyerJourney: brief.buyerJourney.filter(avoidsCorrection),
          alternatives: brief.alternatives.filter(avoidsCorrection),
          positions: brief.positions.filter(avoidsCorrection),
        } : null,
        items: expertise.items.map((item) => item.id === editingId ? {
          ...item, statement, sourceTitle: "User correction", sourceUrl: "", observedAt: now, confidence: "high",
          verificationStatus: "verified", userCorrected: true, sourceChecked: false, implication: "", metric: "",
        } : item),
      },
      updatedAt: now,
    });
    setEditingId("");
    notify("Correction saved. It will inform the next refresh.");
  };

  const showEvidence = (ids: string[]) => {
    const available = ids.filter((id) => outside.some((item) => item.id === id));
    return available.length ? (
      <button className="sector-link" onClick={() => setEvidenceIds(available)}>
        {available.length === 1 ? "Read source" : `Read ${available.length} findings`} <ArrowRight size={14} />
      </button>
    ) : <p className="sector-muted">Supporting evidence changed. Refresh to review this analysis.</p>;
  };
  const openCategory = (key: SectorKnowledgeCategory) => {
    setCategory(key);
    setQuery("");
    setTab("Evidence");
  };

  return (
    <div className="op-stack sector-workspace">
      <header className="op-heading sector-heading">
        <div>
          <h1>Sector expertise</h1>
          <p>Where {workspace.name || "this business"} can compete, who buys, and what to test.</p>
        </div>
        <button className="sector-primary" onClick={() => void refresh()} disabled={working}>
          {working ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}
          {working ? "Researching…" : outside.length ? "Refresh research" : "Build sector expertise"}
        </button>
      </header>
      {working && <p className="sector-progress" role="status">Searching the market, opening sources, and checking passages. This can take a few minutes.</p>}
      {error && <div className="op-analytics-error" role="alert"><CircleAlert size={16} />{error}</div>}
      {!outside.length && (
        <div className="sector-empty">
          <Globe2 size={26} />
          <div><h2>{expertise?.items?.length ? "Ready for a new research brief" : "Research your market"}</h2>
            <p>{expertise?.items?.length ? "Refresh to check earlier claims against independent sources and build the market brief. Your corrections are saved." : "Build sector expertise to uncover buying triggers, alternatives, and positioning options for this project."}</p></div>
        </div>
      )}
      {(outside.length > 0 || items.length > 0) && (
        <nav className="sector-tabs" aria-label="Sector expertise views">
          {tabs.filter((name) => outside.length || name === "Evidence").map((name) => (
            <button key={name} aria-pressed={tab === name || (!outside.length && name === "Evidence")} onClick={() => setTab(name)}>{name}</button>
          ))}
        </nav>
      )}
      {outside.length > 0 && tab === "Overview" && <>
        <section className="sector-overview">
          <article className="sector-entry">
            <span className="sector-kicker">Market entry recommendation</span>
            {entry ? <>
              <h2>{entry.segment}</h2>
              <p>{entry.rationale}</p>
              <dl className="sector-detail-list">
                <Detail label="Buyer to reach">{entry.buyer}</Detail>
                <Detail label="Why now">{entry.whyNow}</Detail>
                <Detail label="What could change the decision">{entry.biggestUnknown}</Detail>
              </dl>
              <div className="sector-actions">
                {showEvidence(entry.evidenceIds)}
                {recommended && <button className="sector-secondary" onClick={() => setTab("Positioning")}>Compare positioning <ArrowRight size={14} /></button>}
              </div>
            </> : <p>Research is available. More evidence is needed to recommend which market to enter first.</p>}
          </article>
          <article className="sector-panel sector-coverage">
            <header><div><h2>Market evidence</h2><p>{sources} source{sources === 1 ? "" : "s"} · {outside.length} checked findings</p></div><ChartColumn size={20} /></header>
            <div className="sector-bars">{coverage.map(({ key, label, count }) => (
              <button key={key} onClick={() => openCategory(key)} aria-label={`${label}, ${count} findings. Open evidence.`}>
                <span>{label}</span><span className="sector-bar"><i style={{ width: `${count / maxCount * 100}%` }} /></span><strong>{count}</strong>
              </button>
            ))}</div>
            {expertise.refreshedAt && <small>Research updated {new Date(expertise.refreshedAt).toLocaleDateString()}</small>}
          </article>
        </section>
        {!!metrics.length && (
          <section className="sector-panel"><h2>Market figures</h2>
            <div className="sector-metrics">{metrics.map((item) => <button key={item.id} onClick={() => setEvidenceIds([item.id])}>
              <strong>{item.metric}</strong><p>{item.statement}</p><span>{item.sourceTitle} <ArrowRight size={13} /></span>
            </button>)}</div>
          </section>
        )}
        {!!expertise?.missingKnowledge.length && <section className="sector-panel sector-unknowns">
          <h2>What needs validating</h2>
          <ul>{expertise.missingKnowledge.map((item) => <li key={item}>{item}</li>)}</ul>
        </section>}
        {!!learning.length && <section className="sector-panel"><h2>What your experiments found</h2>
          <div className="sector-learning">{learning.map((run) => <details key={run.id}>
            <summary>{run.title}</summary><p>{run.learningConclusion?.whatHappened}</p><p>{run.learningConclusion?.meaning}</p>
          </details>)}</div>
        </section>}
      </>}
      {outside.length > 0 && tab === "Buyer journey" && (
        <section className="sector-panel"><h2>How the buyer decides</h2><p className="sector-muted">Research interpretation. Actual decisions can vary by organization.</p>
          {brief?.buyerJourney.length ? <ol className="sector-journey">{brief.buyerJourney.map((stage, index) => (
            <li key={`${stage.stage}-${index}`}><span className="sector-stage-number">{index + 1}</span><h3>{stage.stage}</h3>
              <strong>{stage.role}</strong><p>{stage.decision}</p><dl className="sector-detail-list"><Detail label="Proof they need">{stage.proof}</Detail></dl>
              {showEvidence(stage.evidenceIds)}
            </li>
          ))}</ol> : <p className="sector-muted">The sources did not establish the decision stages yet.</p>}
        </section>
      )}
      {outside.length > 0 && tab === "Alternatives" && (
        <section className="sector-panel"><h2>What buyers can choose instead</h2><p className="sector-muted">Competitive assessment based on the linked sources.</p>
          {brief?.alternatives.length ? <div className="sector-alternatives">{brief.alternatives.map((alternative, index) => (
            <article key={`${alternative.name}-${index}`}><h3>{alternative.name}</h3>
              <dl className="sector-detail-list"><Detail label="Why it wins">{alternative.advantage}</Detail><Detail label="Where there may be an opening">{alternative.opening}</Detail></dl>
              {showEvidence(alternative.evidenceIds)}
            </article>
          ))}</div> : <p className="sector-muted">The reviewed sources did not establish enough about alternatives to compare them.</p>}
        </section>
      )}
      {outside.length > 0 && tab === "Positioning" && (
        <section className="sector-panel"><h2>Positioning options</h2><p className="sector-muted">Proposed directions based on the evidence. Compare the buyer, promise and proof each would require.</p>
          {brief?.positions.length ? <div className="sector-positions">{[...brief.positions].sort((a, b) => Number(b.id === recommended?.id) - Number(a.id === recommended?.id)).map((position) => (
            <article key={position.id} className={position.id === recommended?.id ? "recommended" : ""}>
              {position.id === recommended?.id && <span className="sector-kicker">Recommended to test</span>}
              <h3>{position.title}</h3>
              <p className="sector-promise">{position.promise}</p>
              <dl className="sector-detail-list">
                <Detail label="Buyer">{position.buyer}</Detail>
                <Detail label="Difference">{position.difference}</Detail>
                <Detail label="Proof to build">{position.proof}</Detail>
                <Detail label="Biggest risk">{position.risk}</Detail>
              </dl>
              <details className="sector-test"><summary>View proposed experiment</summary><p>{position.test}</p><p><b>Success signal</b> {position.successSignal}</p></details>
              <div className="sector-actions">{showEvidence(position.evidenceIds)}
                <button className="sector-primary" onClick={() => onDevelop(position)}><Sparkles size={15} /> Develop in Ideas</button>
              </div>
            </article>
          ))}</div> : <p className="sector-muted">More independent evidence is needed before proposing a position.</p>}
        </section>
      )}
      {(tab === "Evidence" || (!outside.length && !!items.length)) && (
        <section className="sector-panel">
          <div className="sector-evidence-controls"><h2>Evidence library</h2>
            <label><span>Search evidence</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            <label><span>Research area</span><select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="all">All areas</option>{Object.entries(categories).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select></label>
          </div>
          <div className="sector-evidence-list">{filtered.length ? filtered.map((item) => <EvidenceCard key={item.id} item={item}>
            {editingId === item.id ? <div className="op-sector-correction">
              <textarea aria-label="Your correction" value={correction} onChange={(event) => setCorrection(event.target.value)} />
              <div><button className="secondary" onClick={() => setEditingId("")}>Cancel</button><button onClick={saveCorrection} disabled={!correction.trim()}>Save correction</button></div>
            </div> : <button className="sector-secondary" onClick={() => { setCorrection(item.statement); setEditingId(item.id); }}>Correct</button>}
          </EvidenceCard>) : <p className="sector-muted">No findings match this view.</p>}</div>
        </section>
      )}
      <EvidenceDialog items={selectedEvidence} onClose={() => setEvidenceIds([])} />
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function EvidenceCard({ item, children }: { item: SectorKnowledgeItem; children?: ReactNode }) {
  return (
    <article className="sector-evidence">
      <header><span>{categories[item.category]}</span><span>{item.userCorrected ? "Your correction" : "Checked passage"}</span></header>
      {item.userCorrected ? <p>{item.statement}</p> : <blockquote>“{item.statement}”</blockquote>}
      {item.implication && !item.userCorrected && <p className="sector-implication"><b>What it may mean</b> {item.implication}</p>}
      {item.sourceUrl && <footer><a href={item.sourceUrl} target="_blank" rel="noreferrer">{item.sourceTitle || "Open source"} <ArrowRight size={13} /></a>
        {item.observedAt && <time dateTime={item.observedAt}>Checked {new Date(item.observedAt).toLocaleDateString()}</time>}
      </footer>}
      {children}
    </article>
  );
}

function EvidenceDialog({ items, onClose }: { items: SectorKnowledgeItem[]; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const isOpen = items.length > 0;
  useEffect(() => {
    const element = dialog.current;
    if (isOpen && element && !element.open) element.showModal();
    if (!isOpen && element?.open) element.close();
  }, [isOpen]);
  return <dialog ref={dialog} className="sector-dialog" onClose={onClose} aria-labelledby="sector-evidence-title">
    <header><h2 id="sector-evidence-title">Supporting evidence</h2><button onClick={onClose} aria-label="Close evidence" autoFocus><X size={20} /></button></header>
    <div>{items.map((item) => <EvidenceCard key={item.id} item={item} />)}</div>
  </dialog>;
}
