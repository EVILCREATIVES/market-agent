import { useState } from "react";
import { LoaderCircle, LockKeyhole, Sparkles } from "lucide-react";
import OperationalApp from "./OperationalApp";
import { authClient, authUrl } from "./auth";

export default function CloudApp() {
  if (!authUrl) return <ConfigurationMissing />;
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const session = authClient.useSession();

  if (session.isPending) {
    return <FullScreenMessage icon={<LoaderCircle className="spin" size={24} />} title="Opening your cloud workspace" detail="Checking the secure session…" />;
  }
  if (!session.data) return <AuthScreen />;

  return (
    <OperationalApp
      userId={session.data.user.id}
      userEmail={session.data.user.email}
      onSignOut={async () => { await authClient.signOut(); }}
    />
  );
}

function AuthScreen() {
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = mode === "sign-up"
        ? await authClient.signUp.email({ name: name.trim() || "Market Agent user", email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) throw new Error(result.error.message || "Authentication failed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-brand"><span><Sparkles size={20} /></span><strong>Market Agent</strong></div>
      <section className="auth-card">
        <div className="auth-lock"><LockKeyhole size={23} /></div>
        <div><small>MULTI-PROJECT MARKETING WORKSPACE</small><h1>{mode === "sign-in" ? "Welcome back" : "Create your account"}</h1><p>Sign in to manage research, campaigns, and content across your projects. Data is stored securely in your private cloud workspace.</p></div>
        <form onSubmit={submit}>
          {mode === "sign-up" && <label><span>Your name</span><input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} /></label>}
          <label><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label><span>Password</span><input type="password" minLength={8} autoComplete={mode === "sign-up" ? "new-password" : "current-password"} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          {error && <div className="auth-error">{error}</div>}
          <button disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={16} />}{mode === "sign-in" ? "Sign in" : "Create secure account"}</button>
        </form>
        <button className="auth-switch" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setError(""); }}>
          {mode === "sign-in" ? "First time here? Create an account" : "Already have an account? Sign in"}
        </button>
      </section>
      <p className="auth-note">Every account has its own private projects, data, and saved agent work.</p>
    </div>
  );
}

function ConfigurationMissing() {
  return <FullScreenMessage icon={<LockKeyhole size={24} />} title="Cloud authentication is not configured" detail="Reconnect the Neon integration and redeploy this project." />;
}

function FullScreenMessage({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <div className="full-message"><span>{icon}</span><h1>{title}</h1><p>{detail}</p></div>;
}
