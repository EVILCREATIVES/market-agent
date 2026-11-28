function matchingContext(context, text) {
  const phrase = comparableBrandText(context);
  return phrase.length >= 3 && text.includes(` ${phrase} `);
}

export function brandContextKey(context) {
  return String(context || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function comparableBrandText(value) {
  return brandContextKey(value).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
}

export function relevantBrandLessons(memory, { section = "", context = "", direction = "" } = {}) {
  const text = ` ${comparableBrandText(`${context} ${direction}`)} `;
  return (Array.isArray(memory) ? memory : []).filter((lesson) =>
    (!lesson.context || matchingContext(lesson.context, text)) && (!section || !lesson.section || lesson.section === section)
  ).slice(0, 14);
}

export function repeatedBrandFeedback(memory, drafts) {
  return memory.filter((lesson) => {
    const rejected = comparableBrandText(lesson.example);
    return lesson.verdict === "avoid" && rejected.length >= 14 && drafts.some(({ section, text }) =>
      (!lesson.section || lesson.section === section) && matchingContext(rejected, ` ${comparableBrandText(text)} `)
    );
  });
}

export function projectBrandProjection(approved, focus, memory) {
  const { system, version, axis, foundation } = approved;
  return {
    version,
    idea: system.idea,
    axis,
    foundation,
    name: system.name,
    conclusions: system.sections.map(({ id, text, example, meaning }) => ({ id, text, example, meaning })),
    checks: system.checks,
    guidelines: system.guidelines,
    guidelineMeanings: system.guidelineMeanings,
    focuses: focus.filter((entry) => entry.version === version).slice(0, 20).map(({ context, face, reason }) => {
      const selected = system.faces.find((item) => item.face === face);
      return { context, face, reason, story: selected?.story || "", boundary: selected?.boundary || "" };
    }),
    memory: memory.slice(0, 45),
  };
}

export function approvedBrandInstructions(workspace, direction = "") {
  const canon = workspace?.creativeBrand;
  if (!canon?.version || !canon.idea) return "";
  const text = ` ${comparableBrandText(direction)} `;
  const contexts = Array.isArray(canon.focuses) ? canon.focuses : [];
  const focus = [...contexts].filter((item) => brandContextKey(item.context) !== "default" && matchingContext(item.context, text))
    .sort((left, right) => right.context.length - left.context.length)[0]
    || contexts.find((item) => brandContextKey(item.context) === "default");
  const lessons = relevantBrandLessons(canon.memory, { direction, context: focus?.context || "" }).map((lesson) => ({
    ...lesson, example: String(lesson.example || "").slice(0, 500), reason: String(lesson.reason || "").slice(0, 420),
  }));
  return `APPROVED BRAND BIBLE · VERSION ${Number(canon.version)}
Use the creator’s approved worldview and principles as the basis for this work. Follow the approved relationship for the relevant context and the consequences it establishes. Other readings stay available. An audience or channel can affect the expression while the approved identity remains its source. Existing factual claims and the user's exact task and delivery approvals still apply. Treat samples as examples. Use the checks and applicable editorial feedback to revise the draft before delivering it.
${JSON.stringify({ name: canon.name, idea: canon.idea, axis: canon.axis, focus, checks: canon.checks, lessons, foundation: canon.foundation, guidelines: canon.guidelines, guidelineMeanings: canon.guidelineMeanings, sections: canon.conclusions }).slice(0, 28_000)}`;
}
