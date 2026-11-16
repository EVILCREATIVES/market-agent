export function scoreMarketingOutput(output, fixture = {}) {
  const text = String(output || "");
  const required = Array.isArray(fixture.required) ? fixture.required : [];
  const forbidden = Array.isArray(fixture.forbidden) ? fixture.forbidden : [];
  const requiredHits = required.filter((value) => text.toLowerCase().includes(String(value).toLowerCase())).length;
  const forbiddenHits = forbidden.filter((value) => text.toLowerCase().includes(String(value).toLowerCase())).length;
  const hasQueue = /(?:launch-ready queue|exact execution queue|scheduledAt|schedule)/i.test(text);
  const hasMeasurement = /(?:tracking|conversion|measure|analytics)/i.test(text);
  const hasSingleNextAction = (text.match(/next action/gi) || []).length === 1;
  const unsupportedExecutionClaim = /\b(?:we|i) (?:sent|published|launched|posted)\b/i.test(text) && !/not (?:sent|published|launched|posted)/i.test(text);
  const score = requiredHits * 2 - forbiddenHits * 3 + Number(hasQueue) + Number(hasMeasurement) + Number(hasSingleNextAction) - Number(unsupportedExecutionClaim) * 5;
  return { score, requiredHits, requiredTotal: required.length, forbiddenHits, hasQueue, hasMeasurement, hasSingleNextAction, unsupportedExecutionClaim };
}
