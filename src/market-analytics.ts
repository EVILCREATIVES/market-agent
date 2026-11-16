const MEASUREMENT_ID = "G-BGP0BQ2MKK";
const PREFERENCE_KEY = "market-agent-analytics-consent";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export type MarketAnalyticsPreference = "accepted" | "declined" | "";

export function marketAnalyticsPreference(): MarketAnalyticsPreference {
  try {
    const value = window.localStorage.getItem(PREFERENCE_KEY);
    return value === "accepted" || value === "declined" ? value : "";
  } catch { return ""; }
}

export function saveMarketAnalyticsPreference(value: Exclude<MarketAnalyticsPreference, "">) {
  try { window.localStorage.setItem(PREFERENCE_KEY, value); } catch { /* Browser storage may be unavailable. */ }
}

export function enableMarketAnalytics() {
  if (document.querySelector(`script[data-market-analytics="${MEASUREMENT_ID}"]`)) return;
  window.dataLayer = window.dataLayer || [];
  window.gtag = (...args: unknown[]) => { window.dataLayer?.push(args); };
  window.gtag("js", new Date());
  window.gtag("config", MEASUREMENT_ID, { send_page_view: false, anonymize_ip: true });
  window.gtag("event", "page_view", {
    page_title: document.title,
    page_location: `${window.location.origin}${window.location.pathname}`,
    page_path: window.location.pathname,
  });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
  script.dataset.marketAnalytics = MEASUREMENT_ID;
  document.head.appendChild(script);
}

if (typeof window !== "undefined" && marketAnalyticsPreference() === "accepted") enableMarketAnalytics();
