const placeholderLabels = /^(?:first\s*name|last\s*name|full\s*name|sender\s*name|sender|venue|company|organisation|organization|job\s*title|role|business\s*contact(?:\s*details)?(?:\s*and\s*physical\s*mailing\s*address)?|physical\s*mailing\s*address|mailing\s*address|specific[^\]]*reason[^\]]*|verified[^\]]*area[^\]]*)$/i;

export function unresolvedEmailPlaceholders(...values) {
  const found = new Set();
  for (const value of values.flat(Infinity)) {
    const text = typeof value === "string" ? value : "";
    for (const match of text.matchAll(/\[([^\]\n]{1,120})\](?!\()/g)) {
      const label = String(match[1] || "").trim();
      if (placeholderLabels.test(label)) found.add(`[${label}]`);
    }
  }
  return [...found];
}

export function newsletterDraftPlaceholders(draft) {
  return unresolvedEmailPlaceholders(
    draft?.subject,
    draft?.previewText,
    draft?.headline,
    draft?.introduction,
    ...(Array.isArray(draft?.sections) ? draft.sections.flatMap((section) => [section?.heading, section?.body]) : []),
    draft?.ctaLabel,
    draft?.closing,
  );
}

export function replaceCampaignLinks(text, targetUrl) {
  const target = normalizedUrl(targetUrl);
  if (!target) return { text: String(text || ""), replaced: 0 };
  let replaced = 0;
  const next = String(text || "").replace(/https?:\/\/[^\s<>()\]]+/gi, (value) => {
    const trailing = value.match(/[.,;:!?]+$/)?.[0] || "";
    const candidate = value.slice(0, value.length - trailing.length);
    try {
      const current = new URL(candidate);
      if (isCitationOrPolicyLink(current)) return value;
      replaced += 1;
      return `${target}${trailing}`;
    } catch {
      return value;
    }
  });
  return { text: next, replaced };
}

function normalizedUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['https:', 'http:'].includes(url.protocol)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function isCitationOrPolicyLink(url) {
  return /(?:mailchimp\.com|support\.|help\.|docs\.|developer\.|ico\.org\.uk|europa\.eu|crtc\.gc\.ca)$/i.test(url.hostname);
}
