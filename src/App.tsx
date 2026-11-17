import { useState } from "react";
import CloudApp from "./CloudApp";
import { enableMarketAnalytics, marketAnalyticsPreference, saveMarketAnalyticsPreference } from "./market-analytics";

export default function App() {
  const publicOptin = window.location.pathname.toLowerCase().startsWith("/join/");
  return <><CloudApp />{!publicOptin && <AnalyticsConsent />}</>;
}

function AnalyticsConsent() {
  const [preference, setPreference] = useState(() => marketAnalyticsPreference());
  if (preference) return null;
  const choose = (value: "accepted" | "declined") => {
    saveMarketAnalyticsPreference(value);
    setPreference(value);
    if (value === "accepted") enableMarketAnalytics();
  };
  return <aside className="analytics-consent" aria-label="Analytics preference"><div><strong>Help improve Market Agent</strong><p>Allow anonymous product-usage measurement. Project content, account credentials, and URL parameters are never sent.</p><a href="/privacy">Privacy policy</a></div><div><button className="secondary" onClick={() => choose("declined")}>No thanks</button><button onClick={() => choose("accepted")}>Allow analytics</button></div></aside>;
}
