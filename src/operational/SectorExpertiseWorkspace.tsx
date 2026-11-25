import { useEffect, useId, useRef, useState, type ReactNode } from "react";
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
const tabs = ["Overview", "Buyer journey", "Alternatives", "Positioning", "Outbound test", "Evidence"] as const;
const alternativeLabels: Record<string, string> = {
  incumbent: "Incumbent provider",
  direct_competitor: "Direct competitor",
  specialist: "Specialist provider",
  independent: "Independent",
  in_house: "In-house",
};
const buyerRecordLabels: Record<string, string> = {
  procurement: "Procurement record",
  job_post: "Buyer job listing",
  buyer_statement: "Buyer statement",
  buyer_interviews: "Buyer interviews or observations",
};
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
  const tablistId = useId();
  const tablist = useRef<HTMLDivElement>(null);
  const [category, setCategory] = useState<SectorKnowledgeCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState("");
  const [correction, setCorrection] = useState("");
  const expertise = workspace.sectorExpertise;
  const brief = expertise?.brief;
  const entry = brief?.version === 2 ? brief.marketEntry : null;
  const readiness = brief?.readiness;
  const accounts = brief?.accounts || [];
  const outbound = entry ? brief?.outbound : null;
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
  const recommended = entry ? brief?.positions.find((item) => item.id === brief.recommendedPositionId) : undefined;
  const learning = runs.filter((run) => run.learningConclusion).slice(0, 3);
  const metrics = brief?.version === 2 ? [...new Map(outside.filter((item) => item.metric)
    .map((item) => [item.sourceUrl.split("/")[2]?.toLowerCase().replace(/^www\./, "") || item.sourceUrl, item])).values()].slice(0, 4) : [];

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
      notify(data.sectorExpertise.brief?.recommendedPositionId ? "Sector research saved." : "Evidence saved. See Overview for what is still missing.");
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
          marketEntry: null,
          buyerJourney: brief.buyerJourney.filter(avoidsCorrection),
          alternatives: brief.alternatives.filter(avoidsCorrection),
          positions: brief.positions.filter(avoidsCorrection),
          recommendedPositionId: "",
          accounts: brief.accounts?.filter(avoidsCorrection),
          outbound: null,
          readiness: undefined,
        } : null,
        items: expertise.items.map((item) => item.id === editingId ? {
          ...item, statement, sourceTitle: "User correction", sourceUrl: "", observedAt: now, confidence: "high",
          verificationStatus: "verified", userCorrected: true, sourceChecked: false, implication: "", metric: "",
          buyerRecord: "", signalKind: "", signalDate: "", namedAccount: "",
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
      <div className="sector-tabs" ref={tablist} role="tablist" aria-label="Sector expertise">
        {tabs.map((name, index) => (
          <button key={name} role="tab" type="button" id={`${tablistId}-tab-${index}`}
            aria-selected={tab === name} aria-controls={tab === name ? `${tablistId}-panel-${index}` : undefined}
            tabIndex={tab === name ? 0 : -1} onClick={() => setTab(name)}
            onKeyDown={(event) => {
              let next: number;
              switch (event.key) {
                case "ArrowRight": next = (index + 1) % tabs.length; break;
                case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break;
                case "Home": next = 0; break;
                case "End": next = tabs.length - 1; break;
                default: return;
              }
              event.preventDefault();
              setTab(tabs[next]);
              tablist.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}>
            {name}
          </button>
        ))}
      </div>
      {working && <p className="sector-progress" role="status">Checking buyer records, competing offers and prices, and dated buying signals. This can take a few minutes.</p>}
      {error && <div className="op-analytics-error" role="alert"><CircleAlert size={16} aria-hidden="true" />{error}</div>}
      <div className="sector-tab-content" role="tabpanel" tabIndex={0} id={`${tablistId}-panel-${tabs.indexOf(tab)}`} aria-labelledby={`${tablistId}-tab-${tabs.indexOf(tab)}`}>
      {!outside.length && tab === "Overview" && (
        <div className="sector-empty">
          <Globe2 size={26} aria-hidden="true" />
          <div><h2>{expertise?.items?.length ? "Ready for a new research brief" : "Research your market"}</h2>
            <p>{expertise?.items?.length ? "Refresh to check earlier claims against independent sources and build the market brief. Your corrections are saved." : "Build sector expertise to uncover buying triggers, alternatives, and positioning options for this project."}</p></div>
        </div>
      )}
      {outside.length > 0 && tab === "Overview" && <>
        <section className="sector-overview">
          <article className="sector-entry">
            <span className="sector-kicker">{entry ? "Market entry recommendation" : "Research coverage"}</span>
            {entry ? <>
              <h2>{entry.segment}</h2>
              <p>{entry.rationale}</p>
              <dl className="sector-detail-list">
                {entry.industry && <Detail label="Industry">{entry.industry}</Detail>}
                {entry.companyProfile && <Detail label="Company profile">{entry.companyProfile}</Detail>}
                {entry.buyingSituation && <Detail label="Buying situation">{entry.buyingSituation}</Detail>}
                <Detail label="Buyer to reach">{entry.buyer}</Detail>
                {entry.budgetBasis && <Detail label="Budget evidence">{entry.budgetBasis}</Detail>}
                <Detail label="Why now">{entry.whyNow}</Detail>
                <Detail label="What could change the decision">{entry.biggestUnknown}</Detail>
              </dl>
              <div className="sector-actions">
                {showEvidence(entry.evidenceIds)}
                {recommended && <button className="sector-secondary" onClick={() => setTab("Positioning")}>Compare positioning <ArrowRight size={14} /></button>}
                {outbound && <button className="sector-secondary" onClick={() => setTab("Outbound test")}>See outbound test <ArrowRight size={14} /></button>}
              </div>
            </> : <><h2>More evidence needed</h2><p>Refresh research to build a supported recommendation for your first buyer segment.</p></>}
            {!!readiness?.gaps.length && <ul className="sector-gaps">{readiness.gaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}
          </article>
          <article className="sector-panel sector-coverage">
            <header><div><h2>Market evidence</h2><p>{sources} source{sources === 1 ? "" : "s"} · {outside.length} checked findings</p></div><ChartColumn size={20} /></header>
            {readiness && <dl className="sector-counts">
              <div><dt>Publishers</dt><dd>{readiness.publishers}</dd></div>
              <div><dt>Buyer sources</dt><dd>{readiness.buyerPublishers}</dd></div>
              <div><dt>Dated signals</dt><dd>{readiness.datedSignals}</dd></div>
            </dl>}
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
      {tab === "Buyer journey" && (
        <section className="sector-panel"><h2>How the buyer decides</h2><p className="sector-muted">Research interpretation. Actual decisions can vary by organization.</p>
          {brief?.buyerJourney.length ? <ol className="sector-journey">{brief.buyerJourney.map((stage, index) => (
            <li key={`${stage.stage}-${index}`}><span className="sector-stage-number">{index + 1}</span><h3>{stage.stage}</h3>
              <strong>{stage.role}</strong><p>{stage.decision}</p><dl className="sector-detail-list"><Detail label="Proof they need">{stage.proof}</Detail></dl>
              {showEvidence(stage.evidenceIds)}
            </li>
          ))}</ol> : <p className="sector-muted">{outside.length ? "The sources did not establish the decision stages yet." : "Run sector research to see who is involved in buying, what triggers the decision, and what proof they need."}</p>}
        </section>
      )}
      {tab === "Alternatives" && (
        <section className="sector-panel"><h2>What buyers can choose instead</h2><p className="sector-muted">Competitive assessment based on the linked sources.</p>
          {brief?.alternatives.length ? <div className="sector-alternatives">{brief.alternatives.map((alternative, index) => (
            <article key={`${alternative.name}-${index}`}>
              {alternative.kind && alternativeLabels[alternative.kind] && <span className="sector-kicker">{alternativeLabels[alternative.kind]}</span>}
              <h3>{alternative.name}</h3>
              <dl className="sector-detail-list"><Detail label="Why buyers choose it">{alternative.advantage}</Detail><Detail label="Where there may be an opening">{alternative.opening}</Detail>
                <Detail label="Public pricing">{alternative.price || "No public price found"}{alternative.priceSource && <> · {showEvidence([alternative.priceSource])}</>}</Detail>
              </dl>
              {showEvidence(alternative.evidenceIds)}
            </article>
          ))}</div> : <p className="sector-muted">{outside.length ? "The reviewed sources did not establish enough about alternatives to compare them." : "Run sector research to compare the competitors and substitutes your buyers already use."}</p>}
        </section>
      )}
      {tab === "Positioning" && (
        <section className="sector-panel"><h2>Positioning options</h2><p className="sector-muted">{recommended ? "Compare the buyer, promise, and proof each direction would require." : "These are working options. More evidence is needed before recommending a position to test."}</p>
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
                {recommended?.id === position.id && <button className="sector-primary" onClick={() => onDevelop(position)}><Sparkles size={15} /> Develop in Ideas</button>}
              </div>
            </article>
          ))}</div> : <p className="sector-muted">{outside.length ? "More independent evidence is needed before proposing a position." : "Run sector research to see positioning options, the proof each needs, and experiments to take into Ideas."}</p>}
        </section>
      )}
      {tab === "Outbound test" && (
        <>
          <section className="sector-panel">
            <h2>{outbound ? "First outbound test" : "Outbound test needs more evidence"}</h2>
            {outbound ? <>
              <dl className="sector-detail-list sector-outbound-details">
                <Detail label="Channel">{outbound.channel}</Detail>
                <Detail label="Buyer to reach">{outbound.buyerRole}</Detail>
                <Detail label="Offer">{outbound.offer}</Detail>
                <Detail label="Pricing approach">{outbound.pricingApproach}</Detail>
                <Detail label="Success criterion">{outbound.successSignal}</Detail>
                <Detail label="When to stop">{outbound.stopRule}</Detail>
              </dl>
              <h3>Opening message</h3><blockquote className="sector-opening">{outbound.openingMessage}</blockquote>
              <div className="sector-actions">{showEvidence(outbound.evidenceIds)}
                {recommended && <button className="sector-primary" onClick={() => onDevelop(recommended)}><Sparkles size={15} /> Develop test in Ideas</button>}
              </div>
            </> : <ul className="sector-gaps">{(readiness?.outboundGaps.length ? readiness.outboundGaps : ["Run sector research to identify accounts with dated buying signals and build a test."]).map((gap) => <li key={gap}>{gap}</li>)}</ul>}
          </section>
          {!!accounts.length && <section className="sector-panel"><h2>Accounts to evaluate</h2>
            <p className="sector-muted">Each account has a documented event. Fit and outreach angles are research interpretations.</p>
            <ol className="sector-accounts">{accounts.map((account) => <li key={account.name}>
              <header><h3>{account.name}</h3><span>{account.triggerDate}</span></header>
              <blockquote>{account.trigger}</blockquote>
              <dl className="sector-detail-list">
                <Detail label="Why it fits">{account.fit}</Detail>
                <Detail label="Outreach angle">{account.outreachAngle}</Detail>
              </dl>
              {showEvidence(account.evidenceIds)}
            </li>)}</ol>
          </section>}
        </>
      )}
      {tab === "Evidence" && (
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
          </EvidenceCard>) : <p className="sector-muted">{items.length ? "No findings match this view." : "Checked passages and your corrections appear here after research."}</p>}</div>
        </section>
      )}
      </div>
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
        {item.buyerRecord && <span>{buyerRecordLabels[item.buyerRecord]}</span>}
        {item.signalDate && <span>Dated evidence · {item.signalDate}</span>}
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
