import { useState } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import BrandLogo from "./BrandLogo";
import OperationalApp from "./OperationalApp";
import PublicSite, { isPublicRoute } from "./PublicSite";
import { authClient, authUrl, canonicalAppOrigin, passwordResetUrl } from "./auth";

export default function CloudApp() {
  const canonicalUrl = getCanonicalUrl();
  if (canonicalUrl) {
    window.location.replace(canonicalUrl);
    return <FullScreenMessage icon={<LoaderCircle className="spin" size={24} />} title="Opening Market Agent" detail="Moving you to the secure workspace…" />;
  }
  if (isPublicRoute()) return <PublicSite />;
  if (!authUrl) return <ConfigurationMissing />;
  return <AuthenticatedApp />;
}

function getCanonicalUrl() {
  if (!import.meta.env.PROD || window.location.origin === canonicalAppOrigin) return "";
  const host = window.location.hostname.toLowerCase();
  const isMarketAgentHost = host === "marketagent.shop" || host.endsWith(".vercel.app");
  if (!isMarketAgentHost) return "";
  return `${canonicalAppOrigin}${window.location.pathname}${window.location.search}${window.location.hash}`;
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
  const resetToken = new URLSearchParams(window.location.search).get("token") || "";
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "forgot" | "reset">(() => resetToken || new URLSearchParams(window.location.search).get("auth") === "reset" ? "reset" : "sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const changeMode = (nextMode: "sign-in" | "sign-up" | "forgot" | "reset") => {
    setMode(nextMode);
    setError("");
    setSuccess("");
    setPassword("");
    setPasswordConfirmation("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (mode === "forgot") {
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: passwordResetUrl,
        });
        if (result.error) throw new Error(result.error.message || "The reset email could not be sent.");
        setSuccess("If that email belongs to an account, a secure reset link is on its way. Check spam if it does not arrive shortly.");
        return;
      }
      if (mode === "reset") {
        if (!resetToken) throw new Error("This reset link is invalid or has expired. Request a new one.");
        if (password !== passwordConfirmation) throw new Error("The two passwords do not match.");
        const result = await authClient.resetPassword({ newPassword: password, token: resetToken });
        if (result.error) throw new Error(result.error.message || "The password could not be changed.");
        window.history.replaceState({}, "", "/");
        changeMode("sign-in");
        setSuccess("Password changed. You can sign in now.");
        return;
      }
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

  const title = mode === "sign-in" ? "Welcome back" : mode === "sign-up" ? "Create your account" : mode === "forgot" ? "Reset your password" : "Choose a new password";
  const detail = mode === "forgot"
    ? "Enter the email used for Market Agent and we’ll send a secure reset link."
    : mode === "reset"
      ? "Create a new password for your existing account. Your projects and connected services will remain unchanged."
      : "Sign in to manage research, campaigns, and content across your projects. Data is stored securely in your private cloud workspace.";

  return (
    <div className="auth-shell">
      <div className="auth-brand"><BrandLogo /><strong>Market Agent</strong></div>
      <section className="auth-card">
        <div className="auth-lock"><LockKeyhole size={23} /></div>
        <div><small>MULTI-PROJECT MARKETING WORKSPACE</small><h1>{title}</h1><p>{detail}</p></div>
        <form onSubmit={submit}>
          {mode === "sign-up" && <label><span>Your name</span><input autoComplete="name" required value={name} onChange={(event) => setName(event.target.value)} /></label>}
          {mode !== "reset" && <label><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>}
          {mode !== "forgot" && <label><span>{mode === "reset" ? "New password" : "Password"}</span><input type="password" minLength={8} autoComplete={mode === "sign-in" ? "current-password" : "new-password"} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>}
          {mode === "reset" && <label><span>Confirm new password</span><input type="password" minLength={8} autoComplete="new-password" required value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} /></label>}
          {error && <div className="auth-error">{error}</div>}
          {success && <div className="auth-success">{success}</div>}
          <button disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <LockKeyhole size={16} />}{mode === "sign-in" ? "Sign in" : mode === "sign-up" ? "Create secure account" : mode === "forgot" ? "Send reset link" : "Save new password"}</button>
        </form>
        {mode === "sign-in" && <><button className="auth-switch" onClick={() => changeMode("forgot")}>Forgot your password?</button><button className="auth-switch auth-switch--secondary" onClick={() => changeMode("sign-up")}>First time here? Create an account</button></>}
        {mode === "sign-up" && <button className="auth-switch" onClick={() => changeMode("sign-in")}>Already have an account? Sign in</button>}
        {(mode === "forgot" || mode === "reset") && <button className="auth-switch" onClick={() => changeMode("sign-in")}>Back to sign in</button>}
      </section>
      <p className="auth-note">Every account has its own private projects, data, and saved agent work.</p>
      <nav className="auth-links" aria-label="About and legal"><a href="/about">About</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav>
    </div>
  );
}

function ConfigurationMissing() {
  return <FullScreenMessage icon={<LockKeyhole size={24} />} title="Cloud authentication is not configured" detail="Reconnect the Neon integration and redeploy this project." />;
}

function FullScreenMessage({ icon, title, detail }: { icon: React.ReactNode; title: string; detail: string }) {
  return <div className="full-message"><span>{icon}</span><h1>{title}</h1><p>{detail}</p></div>;
}
