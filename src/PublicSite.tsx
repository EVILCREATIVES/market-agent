import { ArrowRight, BarChart3, Check, CircleAlert, FileLock2, Mail, Megaphone, ShieldCheck, Sparkles } from "lucide-react";

const updated = "November 7, 2026";

export function isPublicRoute(pathname = window.location.pathname) {
  return ["/about", "/privacy", "/terms", "/connection-result"].includes(normalizePath(pathname));
}

export default function PublicSite() {
  const pathname = normalizePath(window.location.pathname);
  if (pathname === "/connection-result") return <ConnectionResult />;
  if (pathname === "/privacy") return <PrivacyPolicy />;
  if (pathname === "/terms") return <TermsOfService />;
  return <AboutMarketAgent />;
}

function ConnectionResult() {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("connection") || "social-error";
  const successful = result.endsWith("-success") || result === "analytics-select";
  const provider = result.replace(/-(success|error)$/, "").replace(/-select$/, "");
  const labels: Record<string, string> = {
    analytics: "Google Analytics",
    gmail: "Email",
    linkedin: "LinkedIn",
    instagram: "Instagram",
    tiktok: "TikTok",
    x: "X",
    social: "Social account",
    billing: "Managed plan",
  };
  const label = labels[provider] || "Account";
  const reason = params.get("reason") || `${label} could not be connected.`;
  const workspaceParams = new URLSearchParams({ connection: result });
  if (!successful) workspaceParams.set("reason", reason);

  return (
    <div className="connection-result-shell">
      <section className={successful ? "connection-result success" : "connection-result error"}>
        <span>{successful ? <Check size={27} /> : <CircleAlert size={27} />}</span>
        <small>MARKET AGENT CONNECTION</small>
        <h1>{successful ? `${label} connected` : `${label} needs attention`}</h1>
        <p>{successful
          ? result === "billing-success"
            ? "Your $29.99 monthly managed text plan is active. Return to the workspace to continue."
            : result === "analytics-select"
            ? "Authorization is complete. Return to the workspace to choose the Analytics property for this project."
            : "Authorization is complete and securely saved to this project."
          : reason}</p>
        <a href={`/?${workspaceParams.toString()}`}>Return to your workspace <ArrowRight size={15} /></a>
        <em>If your session expired while you were away, sign in again with the same Market Agent account.</em>
      </section>
    </div>
  );
}

function PublicHeader() {
  return (
    <header className="public-header">
      <a className="public-brand" href="/about"><span><Sparkles size={18} /></span><strong>Market Agent</strong></a>
      <nav aria-label="Public navigation">
        <a href="/about">Product</a>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a className="public-sign-in" href="/">Sign in <ArrowRight size={14} /></a>
      </nav>
    </header>
  );
}

function PublicFooter() {
  return (
    <footer className="public-footer">
      <span><strong>Market Agent</strong><small>© 2026 Evil Creatives. All rights reserved.</small></span>
      <div><a href="/about">Product</a><a href="/privacy">Privacy Policy</a><a href="/terms">Terms of Service</a></div>
      <a href="mailto:unleash@evilcreatives.com">unleash@evilcreatives.com</a>
    </footer>
  );
}

function AboutMarketAgent() {
  const capabilities = [
    [Megaphone, "Campaign execution", "Research, positioning, channel plans, final copy, schedules, and reviewable launch actions."],
    [BarChart3, "Live measurement", "Connect a project’s own analytics property and use real traffic and acquisition data."],
    [Mail, "Connected delivery", "Authorize email and social accounts per project. Every external action remains individually reviewable."],
    [FileLock2, "Private project memory", "Keep sources, corrections, brand rules, campaign history, and account connections isolated by user and project."],
  ] as const;
  return (
    <div className="public-shell">
      <PublicHeader />
      <main>
        <section className="public-hero">
          <div className="public-eyebrow"><ShieldCheck size={15} /> Multi-project marketing workspace</div>
          <h1>From project truth<br />to approved execution.</h1>
          <p>Market Agent researches the live market, understands project materials, prepares channel-ready work, and executes only through accounts the user explicitly connects.</p>
          <div className="public-hero-actions"><a href="/">Open your workspace <ArrowRight size={15} /></a><span>No social account is shared between users or projects.</span></div>
        </section>

        <section className="public-proof">
          <div><small>01</small><strong>Add the project</strong><p>Upload documents and assets, or connect public project sources.</p></div>
          <div><small>02</small><strong>Review the product brain</strong><p>The workspace extracts facts, brand signals, audiences, and useful media.</p></div>
          <div><small>03</small><strong>Approve real actions</strong><p>Connect owned channels and approve each send or publication before it leaves the app.</p></div>
        </section>

        <section className="public-section">
          <div className="public-section-heading"><small>WHAT IT DOES</small><h2>One operating workspace for many projects</h2><p>The service is not tied to one brand. Each user can create independent projects with separate sources, memory, analytics, and delivery accounts.</p></div>
          <div className="public-capabilities">{capabilities.map(([Icon, title, detail]) => <article key={title}><span><Icon size={20} /></span><h3>{title}</h3><p>{detail}</p></article>)}</div>
        </section>

        <section className="public-controls">
          <div><small>CONTROL BY DESIGN</small><h2>Autonomous work, explicit external approval.</h2><p>The workspace can research, analyze, draft, organize, and prepare assets independently. Sending email or publishing to a connected network requires a visible user approval for the specific action.</p></div>
          <ul><li><Check size={15} />Private credentials are stored server-side</li><li><Check size={15} />Connections are scoped to the signed-in user and project</li><li><Check size={15} />Disconnect access at any time</li><li><Check size={15} />No fabricated recipients or account permissions</li></ul>
        </section>

        <section className="public-cta"><span><Sparkles size={22} /></span><div><small>READY WHEN YOU ARE</small><h2>Build the first project workspace.</h2></div><a href="/">Sign in or create an account <ArrowRight size={15} /></a></section>
      </main>
      <PublicFooter />
    </div>
  );
}

function PrivacyPolicy() {
  return <LegalPage title="Privacy Policy" intro="How Market Agent collects, uses, protects, and deletes information when you use the service.">
    <LegalSection title="1. Service owner and operator"><p>Market Agent is a product owned and operated by Evil Creatives. Market Agent is not presented as a separate legal company. References to “Market Agent,” “we,” “us,” or “our” in this policy refer to the service operated by Evil Creatives.</p></LegalSection>
    <LegalSection title="2. Information we collect"><p>We collect account information you provide, including your name and email address; project information, instructions, uploaded files, links, brand assets, and saved work; and technical records needed to secure and operate the service.</p><p>When you connect an external service, we store the account identifier, permissions granted, encrypted access credentials, and the minimum information needed to show and operate that connection. We do not ask for or store your external-service password.</p><p>For a managed subscription, we store the PayPal subscription identifier, subscription status, payer email supplied by PayPal, and billing-event records needed to provide or stop access. PayPal processes payment credentials; Market Agent does not store card or PayPal account passwords.</p></LegalSection>
    <LegalSection title="3. How information is used"><p>Information is used to provide private project workspaces, analyze the materials you submit, create requested marketing work, maintain project memory, measure results, and carry out actions you explicitly approve through connected accounts. It is also used to prevent abuse, diagnose failures, and maintain service security.</p></LegalSection>
    <LegalSection title="4. Connected services"><p>Google Analytics access is read-only. Gmail access is used to send messages you approve. Mailchimp access is used to manage the audience you select, register consented subscribers, create campaigns, perform approved sends or schedules, and read campaign reports. Social-network access is used only for the capabilities and accounts authorized by the user. Each connected provider also processes information under its own privacy policy and terms.</p><p>You may disconnect a provider at any time from the Connections page. Disconnecting removes the stored authorization from Market Agent; you may also revoke access directly in the provider’s account settings.</p></LegalSection>
    <LegalSection title="5. Service providers, payments, and model APIs"><p>Market Agent uses infrastructure and storage providers to run the service and PayPal to process managed-plan subscriptions. When a user connects a private analysis or media API key, project inputs needed for the requested task may be sent to that provider under the user’s own account and the provider’s terms. During a demo or managed text plan, relevant project inputs may be processed through Market Agent’s managed services. We do not sell personal information.</p></LegalSection>
    <LegalSection title="6. Security and retention"><p>Private API keys and connected-account credentials are handled on the server and encrypted before storage. Access is limited to the signed-in account and the relevant project. We retain account and project information while the account is active or as needed to provide the service, resolve disputes, and meet legal obligations.</p></LegalSection>
    <LegalSection title="7. Your choices"><p>You can correct project information in the workspace, disconnect external services, and request access to or deletion of your account information. Some provider-side records must be managed directly with that provider.</p></LegalSection>
    <LegalSection title="8. Contact"><p>For privacy questions or deletion requests, email <a href="mailto:unleash@evilcreatives.com">unleash@evilcreatives.com</a>.</p></LegalSection>
  </LegalPage>;
}

function TermsOfService() {
  return <LegalPage title="Terms of Service" intro="Rules for using Market Agent and its connected marketing, analytics, and publishing features.">
    <LegalSection title="1. Owner and operator"><p>Market Agent is a product and brand owned and operated by Evil Creatives; it is not a separate legal company. Evil Creatives owns the Market Agent service, software, interface, branding, and related product materials, subject to any third-party rights identified in the service.</p></LegalSection>
    <LegalSection title="2. The service"><p>Market Agent provides project research, marketing planning, content preparation, asset workflows, analytics reporting, and approved delivery through accounts a user connects. Features may change as external platforms and service providers change their APIs and requirements.</p></LegalSection>
    <LegalSection title="3. Accounts and authority"><p>You must provide accurate account information and protect your login. You may connect only accounts, projects, files, and data that you are authorized to use. You are responsible for activity performed through your account and for reviewing collaborators’ access.</p></LegalSection>
    <LegalSection title="4. Approvals and external actions"><p>Connector recommendations are suggestions based on the project information available to the service; they are not guarantees of suitability or performance. You decide which accounts to connect and may decline a recommendation.</p><p>You remain responsible for account authority, final claims, recipients, subscriber consent, targeting, intellectual-property rights, disclosures, applicable marketing and privacy law, provider rules, and the consequences of approved external actions. Market Agent requires explicit approval before sending email, scheduling or sending a newsletter, or publishing social content, but that approval does not replace your legal or professional review.</p></LegalSection>
    <LegalSection title="5. Acceptable use"><p>Do not use the service to impersonate others, infringe rights, distribute unlawful or deceptive content, send spam, bypass consent or opt-out requirements, scrape restricted data, evade platform rules, or compromise another account or system.</p></LegalSection>
    <LegalSection title="6. External services and charges"><p>Connected providers—including analytics, email, social networks, infrastructure, and private analysis or media APIs—are governed by their own terms, quotas, review processes, and pricing. Charges made by those providers to your connected account are your responsibility.</p></LegalSection>
    <LegalSection title="7. Demo and managed subscription"><p>The limited demo lasts ten days from the account’s first authenticated workspace use and may impose daily and total usage limits. It includes text-based document analysis, campaign reasoning, and LinkedIn connection; it does not include image or video creation.</p><p>The managed text plan is billed at the price and interval shown at checkout, currently $29.99 USD per month, through PayPal until cancelled. It includes text research, strategy, campaigns, writing, and balanced review subject to fair usage limits; image and video creation require the user’s own APIs. You may cancel in Market Agent or through PayPal. Access follows the subscription status reported by PayPal, and any mandatory refund rights remain unaffected.</p></LegalSection>
    <LegalSection title="8. Your content"><p>You retain ownership of the materials and instructions you provide. You grant the service permission to process them only as needed to operate the requested features. You are responsible for ensuring you have the rights needed for uploaded and published content.</p></LegalSection>
    <LegalSection title="9. Market Agent intellectual property"><p>The Market Agent name, product, software, visual identity, interface, documentation, and original service content are owned by Evil Creatives and protected by applicable intellectual-property laws. These terms do not transfer ownership of Market Agent or Evil Creatives intellectual property to users.</p></LegalSection>
    <LegalSection title="10. Availability and liability"><p>The service is provided on an as-available basis. Generated work and connector recommendations may contain errors and must be reviewed before approval. External APIs may delay, limit, reject, or remove access or content. To the maximum extent permitted by law, the service owner is not liable for indirect, incidental, special, consequential, or provider-imposed loss arising from user-approved actions, connected accounts, generated work, or external providers. Nothing in these terms excludes liability that cannot legally be excluded.</p></LegalSection>
    <LegalSection title="11. Suspension and termination"><p>Access may be suspended for abuse, security risk, non-payment, or violation of these terms. You may stop using the service and request account deletion at any time.</p></LegalSection>
    <LegalSection title="12. Contact"><p>Questions about these terms may be sent to <a href="mailto:unleash@evilcreatives.com">unleash@evilcreatives.com</a>.</p></LegalSection>
  </LegalPage>;
}

function LegalPage({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return <div className="public-shell"><PublicHeader /><main className="legal-page"><div className="legal-hero"><small>MARKET AGENT</small><h1>{title}</h1><p>{intro}</p><span>Last updated {updated}</span></div><article className="legal-copy">{children}</article></main><PublicFooter /></div>;
}

function LegalSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h2>{title}</h2>{children}</section>;
}

function normalizePath(pathname: string) {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path.toLowerCase();
}
